const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('events');
const { spawn } = require('child_process');
const { createServer } = require('http');
const {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} = require('fs');
const { tmpdir } = require('os');
const { join, resolve } = require('path');
const { parseDuration } = require('../src/cli');
const { MAX_CONTENT_BYTES } = require('../src/content-store');
const { HeadlessServer } = require('../src/server');

const CLI = resolve(__dirname, '../bin/clideck.js');

class FakeSession extends EventEmitter {
  constructor(id, name, provider, cwd) {
    super();
    this.id = id;
    this.name = name;
    this.provider = { id: provider };
    this.cwd = cwd;
    this.cols = 100;
    this.rows = 30;
    this.status = 'idle';
    this.turnOpen = false;
    this.closeRequested = false;
    this.closed = false;
    this.menu = [];
    this.latestUpdate = '';
    this.prompts = [];
  }

  sendPrompt(text) {
    this.prompts.push(text);
    this.turnOpen = true;
    this.status = 'working';
    setImmediate(() => {
      this.turnOpen = false;
      this.status = 'idle';
      this.latestUpdate = 'CLI_ANSWER';
      this.emit('event', { type: 'agent.final', text: 'CLI_ANSWER' });
    });
    return true;
  }

  steerPrompt(text) {
    this.prompts.push(text);
    return true;
  }

  close() {
    this.closed = true;
    this.emit('event', { type: 'session.closed' });
  }

  waitForClose() {
    return Promise.resolve();
  }
}

function runCli(args, env, input = '', cwd) {
  return new Promise((resolveResult) => {
    const child = spawn(process.execPath, [CLI, ...args], {
      env: { ...process.env, ...env },
      ...(cwd && { cwd }),
    });
    let stdout = '';
    let stderr = '';
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk) => { stdout += chunk; });
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    child.on('close', (code) => resolveResult({ code, stdout, stderr }));
    child.stdin.end(input);
  });
}

function register(server, session) {
  server.persistence.register(session);
  server.sessions.set(session.id, session);
}

test('CLI duration parser accepts the documented range', () => {
  assert.equal(parseDuration('30s'), 30_000);
  assert.equal(parseDuration('10m'), 600_000);
  assert.equal(parseDuration('1h'), 3_600_000);
  assert.equal(parseDuration('2h'), null);
  assert.equal(parseDuration('soon'), null);
});

test('CLI help explains how busy agents can steer', async () => {
  const result = await runCli(['--help'], {});
  assert.equal(result.code, 0, result.stderr);
  assert.match(result.stdout, /ask <target> <message> --steer/);
  assert.match(result.stdout, /injects guidance immediately and returns without waiting/);
  assert.match(result.stdout, /Show supports text, JSON, markdown/);
});

test('HTML starter and focused show help work without an engine or caller', async () => {
  const offline = { CLIDECK_SESSION_ID: '', CLIDECK_NEXT_SESSION_ID: '', CLIDECK_URL: 'http://127.0.0.1:1' };
  const result = await runCli(['show', '--template'], offline);
  assert.equal(result.code, 0, result.stderr);
  assert.equal(result.stderr, '');
  assert.match(result.stdout, /^<!doctype html>/);
  assert.match(result.stdout, /<html lang="en" data-clideck-theme="auto">/);
  assert.match(result.stdout, /name="viewport"/);
  assert.ok(result.stdout.includes(readFileSync(join(__dirname, '../public/css/preview.css'), 'utf8').trim()));
  assert.doesNotMatch(result.stdout, /<script|<link/);
  const help = await runCli(['show', '--help'], offline);
  assert.equal(help.code, 0, help.stderr);
  assert.match(help.stdout, /show --template > report.html/);
  assert.match(help.stdout, /--cd-bg/);
  for (const args of [['page.html'], ['--stdin'], ['--kind', 'html'], ['--name', 'Report']]) {
    const invalid = await runCli(['show', '--template', ...args], offline);
    assert.notEqual(invalid.code, 0);
    assert.equal(invalid.stdout, '');
    assert.match(invalid.stderr, /--template writes an HTML starter/);
  }
});

test('CLI long polls do not inherit fetch transport deadlines', async () => {
  const dataDir = mkdtempSync(join(tmpdir(), 'clideck-next-cli-long-poll-'));
  const preload = join(dataDir, 'break-fetch.cjs');
  writeFileSync(preload, [
    'global.fetch = () => new Promise((resolve, reject) => {',
    '  setTimeout(() => reject(new TypeError("fetch failed")), 20);',
    '});',
  ].join('\n'));
  const server = createServer((_req, res) => {
    setTimeout(() => {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true, answer: 'DELAYED_ANSWER' }));
    }, 80);
  });
  try {
    await new Promise((resolveListen, rejectListen) => {
      server.once('error', rejectListen);
      server.listen(0, '127.0.0.1', resolveListen);
    });
    const url = `http://127.0.0.1:${server.address().port}`;
    const result = await runCli(['ask', 'peer', 'wait for it', '--timeout', '30s'], {
      CLIDECK_SESSION_ID: 'caller',
      CLIDECK_URL: url,
      NODE_OPTIONS: `--require=${preload}`,
    });
    assert.equal(result.code, 0, result.stderr);
    assert.equal(result.stdout, 'DELAYED_ANSWER\n');
  } finally {
    await new Promise((resolveClose) => server.close(resolveClose));
    rmSync(dataDir, { recursive: true, force: true });
  }
});

test('CLI lists, asks, reports status, and rejects invalid targets', async () => {
  const dataDir = mkdtempSync(join(tmpdir(), 'clideck-next-cli-'));
  const server = new HeadlessServer({ port: 0, dataDir, autoSaveMs: 0 });
  const cwd = '/tmp/cli-project';
  const caller = new FakeSession('caller-id', 'Programmer', 'shell', cwd);
  const target = new FakeSession('target-id', 'Reviewer', 'claude-code', cwd);
  const other = new FakeSession('other-id', 'Other project', 'claude-code', '/tmp/other');
  caller.projectId = 'main-project';
  target.projectId = 'main-project';
  other.projectId = 'other-project';
  target.latestUpdate = 'Ready to review';
  const broadcasts = [];
  server.broadcast = (event) => broadcasts.push(event);
  register(server, caller);
  register(server, target);
  register(server, other);

  try {
    server.configStore.update({ projects: [
      { id: 'main-project', name: 'Main', path: cwd, color: '#123456', collapsed: false },
      { id: 'other-project', name: 'Other', path: '/tmp/other', color: '#654321', collapsed: false },
    ] });
    const { httpUrl } = await server.listen();
    const env = { CLIDECK_SESSION_ID: caller.id, CLIDECK_URL: httpUrl };

    const listed = await runCli(['agents', '--json'], env);
    assert.equal(listed.code, 0, listed.stderr);
    const agents = JSON.parse(listed.stdout);
    assert.deepEqual(agents.map((agent) => agent.id), ['caller-id', 'target-id']);
    assert.equal(agents[1].address, '@Main/Reviewer');
    assert.equal(agents[1].projectId, 'main-project');
    assert.equal(agents[1].cwdGroup, cwd);
    assert.equal(agents[1].lastPreview, 'Ready to review');

    const status = await runCli(['ask', 'status', '--json', '--url', httpUrl], {
      CLIDECK_SESSION_ID: caller.id,
      CLIDECK_URL: '',
    });
    assert.equal(status.code, 0, status.stderr);
    assert.equal(JSON.parse(status.stdout)[1].status, 'idle');

    const asked = await runCli(['ask', '@Main/Reviewer', '--timeout', '30s'], env, 'Review this.');
    assert.equal(asked.code, 0, asked.stderr);
    assert.equal(asked.stdout, 'CLI_ANSWER\n');
    assert.match(asked.stderr, /contacting "@Main\/Reviewer"/);
    assert.equal(target.prompts[0], '[CliDeck ask from @Main/Programmer]\n\nReview this.');
    assert.deepEqual(broadcasts.filter((event) => event.type === 'session.dispatch'), [{
      type: 'session.dispatch',
      fromId: caller.id,
      fromName: caller.name,
      toId: target.id,
      toName: target.name,
    }]);

    target.status = 'working';
    const busy = await runCli(['ask', 'Reviewer', 'Do not queue.'], env);
    assert.equal(busy.code, 1);
    assert.match(busy.stderr, /Re-run with --steer/);
    assert.equal(broadcasts.filter((event) => event.type === 'session.dispatch').length, 1);

    const steered = await runCli(['ask', 'Reviewer', 'Use the new constraint.', '--steer'], env);
    assert.equal(steered.code, 0, steered.stderr);
    assert.equal(steered.stdout, '');
    assert.match(steered.stderr, /steered "Reviewer"/);
    assert.equal(target.status, 'working');
    assert.equal(target.prompts.at(-1), '[CliDeck steer from @Main/Programmer]\n\nUse the new constraint.');
    assert.equal(broadcasts.filter((event) => event.type === 'session.dispatch').length, 2);

    target.menu = ['Approve'];
    const blockedSteer = await runCli(['ask', 'Reviewer', 'Do not select.', '--steer'], env);
    assert.equal(blockedSteer.code, 1);
    assert.match(blockedSteer.stderr, /cannot be steered/i);
    assert.equal(target.prompts.at(-1), '[CliDeck steer from @Main/Programmer]\n\nUse the new constraint.');
    target.menu = [];

    target.status = 'idle';
    const missing = await runCli(['ask', 'Missing project', 'Hello.'], env);
    assert.equal(missing.code, 1);
    assert.match(missing.stderr, /No matching target/i);
    assert.equal(broadcasts.filter((event) => event.type === 'session.dispatch').length, 2);

    const unknownCaller = await runCli(['agents', '--json'], {
      CLIDECK_SESSION_ID: 'missing-caller',
      CLIDECK_URL: httpUrl,
    });
    assert.equal(unknownCaller.code, 1);
    assert.match(unknownCaller.stderr, /Caller session is not active/i);

    const unknownCallerAsk = await runCli(['ask', 'Reviewer', 'Hello.'], {
      CLIDECK_SESSION_ID: 'missing-caller',
      CLIDECK_URL: httpUrl,
    });
    assert.equal(unknownCallerAsk.code, 1);
    assert.match(unknownCallerAsk.stderr, /Caller session is not active/i);
  } finally {
    await server.close();
    rmSync(dataDir, { recursive: true, force: true });
  }
});

test('CLI discovery includes dormant peers, groups all projects and refreshes live state', async () => {
  const dataDir = mkdtempSync(join(tmpdir(), 'clideck-agent-discovery-'));
  const server = new HeadlessServer({ port: 0, dataDir, autoSaveMs: 0 });
  const caller = new FakeSession('discovery-self', 'Main', 'codex', dataDir);
  const stopped = new FakeSession('discovery-old', 'Old reviewer', 'codex', dataDir);
  const remote = new FakeSession('discovery-remote', 'Reviewer', 'claude-code', dataDir);
  const remoteStopped = new FakeSession('discovery-remote-old', 'Retired', 'codex', dataDir);
  caller.projectId = stopped.projectId = 'here';
  remote.projectId = remoteStopped.projectId = 'there';
  for (const session of [caller, stopped, remote, remoteStopped]) register(server, session);
  server.sessions.delete(stopped.id);
  remoteStopped.closed = true;
  server.persistence.update(stopped.id, { lastActive: '2026-09-01T12:00:00.000Z' });
  try {
    server.configStore.update({ projects: [
      { id: 'here', name: 'Here', path: dataDir, color: '#123456', collapsed: false },
      { id: 'there', name: 'There', path: dataDir, color: '#654321', collapsed: false },
    ] });
    const { httpUrl } = await server.listen();
    const env = { CLIDECK_SESSION_ID: caller.id, CLIDECK_URL: httpUrl };
    const local = await runCli(['agents', '--json'], env);
    assert.equal(local.code, 0, local.stderr);
    assert.equal(local.stderr, '');
    const listed = JSON.parse(local.stdout);
    assert.deepEqual(listed.map((a) => [a.id, a.status]), [[caller.id, 'idle'], [stopped.id, 'dormant']]);
    assert.equal(listed[1].lastActive, '2026-09-01T12:00:00.000Z');
    assert.equal(listed[1].live, false);
    assert.equal(listed[1].working, false);

    const all = await runCli(['agents', '--all', '--json'], env);
    assert.equal(all.code, 0, all.stderr);
    assert.deepEqual(JSON.parse(all.stdout).map((a) => a.id), [caller.id, stopped.id, remote.id, remoteStopped.id]);
    const grouped = await runCli(['agents', '--all'], env);
    assert.equal(grouped.code, 0, grouped.stderr);
    assert.match(grouped.stdout, /^Here \(current\)\n/m);
    assert.match(grouped.stdout, /^There\n/m);
    assert.match(grouped.stdout, /Retired \| dormant/);
    assert.match(grouped.stdout, /Hint:/);

    // Listing stays project-local by default; asking an exact other-project address still works.
    const asked = await runCli(['ask', '@There/Reviewer', 'Review fixture.'], env);
    assert.equal(asked.code, 0, asked.stderr);
    assert.equal(asked.stdout, 'CLI_ANSWER\n');
    assert.equal(remote.prompts.length, 1);

    const dormant = await runCli(['ask', '@Here/Old reviewer', 'Review fixture.'], env);
    assert.equal(dormant.code, 1);
    assert.match(dormant.stderr, /dormant \(stopped\)/);
    assert.match(dormant.stderr, /Hint: Run clideck agents/);
    assert.match(dormant.stderr, /resume this session only if it is still needed/);

    remote.closed = true;
    const status = await runCli(['ask', 'status', '--all', '--json'], env);
    assert.equal(status.code, 0, status.stderr);
    assert.equal(JSON.parse(status.stdout).find((a) => a.id === remote.id).status, 'dormant');
    remote.closed = false;
    remote.status = 'working';
    const changed = await runCli(['agents', '--all', '--json'], env);
    assert.equal(JSON.parse(changed.stdout).find((a) => a.id === remote.id).status, 'working');

    const unknown = await runCli(['agents', '--all'], { ...env, CLIDECK_SESSION_ID: 'unknown' });
    assert.equal(unknown.code, 1);
    assert.match(unknown.stderr, /Caller session is not active/);
    assert.match(unknown.stderr, /Hint:/);
    const badArgument = await runCli(['agents', 'invented'], env);
    assert.equal(badArgument.code, 1);
    assert.match(badArgument.stderr, /Hint: use clideck agents/);
  } finally {
    await server.close();
    rmSync(dataDir, { recursive: true, force: true });
  }
});

test('CLI ask errors provide next steps without contaminating stdout', async () => {
  let response = {};
  const server = createServer((req, res) => {
    req.resume();
    res.writeHead(409, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: false, ...response }));
  });
  await new Promise((resolveListen) => server.listen(0, '127.0.0.1', resolveListen));
  const env = { CLIDECK_SESSION_ID: 'hint-caller', CLIDECK_URL: `http://127.0.0.1:${server.address().port}` };
  try {
    for (const [error, hint] of [
      ['unknown_target', /--all to search other projects/],
      ['unknown_project', /--all for current project names/],
      ['ambiguous_target', /--all --json and use the exact session id/],
      ['ambiguous_project', /@projectId\/sessionId/],
      ['not_working', /without --steer/],
      ['busy', /may need to finish or dismiss a prompt/],
      ['timeout', /work may still be running/],
      ['unsupported_target', /no-ask marker/],
      ['target_closed', /choose a current peer/],
    ]) {
      response = { error };
      const result = await runCli(['ask', 'Peer', 'Fixture only.'], env);
      assert.equal(result.code, 1, error);
      assert.equal(result.stdout, '', error);
      assert.match(result.stderr, /Hint:/, error);
      assert.match(result.stderr, hint, error);
    }
    response = { error: 'busy', message: 'Target session is working. Re-run with --steer.' };
    const busy = await runCli(['ask', 'Peer', 'Fixture only.'], env);
    assert.match(busy.stderr, /Re-run with --steer/);
    assert.match(busy.stderr, /Hint: Use clideck ask status/);
    response = { error: 'timeout' };
    const prompt = await runCli(['prompt', 'Fixture only?'], env);
    assert.equal(prompt.code, 1);
    assert.match(prompt.stderr, /waiting for the user/);
    assert.doesNotMatch(prompt.stderr, /ask status|work may still be running/);
  } finally { await new Promise((resolveClose) => server.close(resolveClose)); }
});

test('CLI show broadcasts scoped content and serves ranged media', async () => {
  const dataDir = mkdtempSync(join(tmpdir(), 'clideck-next-show-'));
  const cwd = join(dataDir, 'project');
  mkdirSync(cwd);
  writeFileSync(join(cwd, 'preview.png'), Buffer.from('png-body'));
  writeFileSync(join(cwd, 'clip.mp4'), Buffer.from('0123456789'));
  writeFileSync(join(cwd, 'notes.txt'), 'not supported');
  writeFileSync(join(cwd, 'debug.log'), 'one\ntwo\n');
  writeFileSync(join(cwd, 'page.html'), '<h1>hello</h1>');
  writeFileSync(join(cwd, 'readme.md'), '# hello');
  writeFileSync(join(cwd, 'report.pdf'), '%PDF-test');
  writeFileSync(join(cwd, 'flow.mmd'), 'graph TD; A-->B');
  writeFileSync(join(cwd, 'changes.patch'), '@@ -1 +1 @@');
  writeFileSync(join(cwd, 'data.json'), '{"value":1}');
  writeFileSync(join(cwd, 'unsupported.bin'), 'unsupported');
  writeFileSync(join(dataDir, 'outside.png'), Buffer.from('outside'));
  symlinkSync(join(dataDir, 'outside.png'), join(cwd, 'linked.png'));

  const server = new HeadlessServer({ port: 0, dataDir, autoSaveMs: 0 });
  const caller = new FakeSession('show-caller', 'Viewer', 'shell', cwd);
  const broadcasts = [];
  server.broadcast = (event) => broadcasts.push(event);
  register(server, caller);
  try {
    const { httpUrl } = await server.listen();
    const env = { CLIDECK_SESSION_ID: caller.id, CLIDECK_URL: httpUrl };

    const shown = await runCli(['show', 'preview.png'], env, '', cwd);
    assert.deepEqual(shown, { code: 0, stdout: '', stderr: '' });
    const imageEvent = broadcasts.at(-1);
    assert.match(imageEvent.contentId, /^[0-9a-f-]{36}$/);
    assert.deepEqual(imageEvent, {
      type: 'content.show',
      sessionId: caller.id,
      contentId: imageEvent.contentId,
      kind: 'image',
      name: 'preview.png',
      url: `/content/${imageEvent.contentId}`,
      sourcePath: realpathSync(join(cwd, 'preview.png')),
    });
    const image = await fetch(`${httpUrl}${imageEvent.url}`);
    assert.equal(image.status, 200);
    assert.equal(image.headers.get('content-type'), 'image/png');
    assert.equal(Buffer.from(await image.arrayBuffer()).toString(), 'png-body');

    writeFileSync(join(cwd, 'swapped.png'), Buffer.from('safe'));
    const swapShown = await runCli(['show', 'swapped.png'], env, '', cwd);
    assert.equal(swapShown.code, 0, swapShown.stderr);
    const swapEvent = broadcasts.at(-1);
    unlinkSync(join(cwd, 'swapped.png'));
    symlinkSync(join(dataDir, 'outside.png'), join(cwd, 'swapped.png'));
    const swapped = await fetch(`${httpUrl}${swapEvent.url}`);
    assert.equal(swapped.status, 404);
    assert.notEqual(await swapped.text(), 'outside');

    const videoShown = await runCli(['show', 'clip.mp4'], env, '', cwd);
    assert.equal(videoShown.code, 0, videoShown.stderr);
    const videoEvent = broadcasts.at(-1);
    assert.equal(videoEvent.kind, 'video');
    const video = await fetch(`${httpUrl}${videoEvent.url}`, {
      headers: { Range: 'bytes=2-5' },
    });
    assert.equal(video.status, 206);
    assert.equal(video.headers.get('content-type'), 'video/mp4');
    assert.equal(video.headers.get('content-range'), 'bytes 2-5/10');
    assert.equal(video.headers.get('accept-ranges'), 'bytes');
    assert.equal(Buffer.from(await video.arrayBuffer()).toString(), '2345');

    for (const [file, kind, mime, body] of [
      ['page.html', 'html', 'text/html', '<h1>hello</h1>'],
      ['readme.md', 'markdown', 'text/markdown', '# hello'],
      ['notes.txt', 'text', 'text/plain', 'not supported'],
      ['debug.log', 'text', 'text/plain', 'one\ntwo\n'],
      ['data.json', 'json', 'application/json', '{"value":1}'],
      ['report.pdf', 'pdf', 'application/pdf', '%PDF-test'],
      ['flow.mmd', 'mermaid', 'text/plain', 'graph TD; A-->B'],
      ['changes.patch', 'diff', 'text/plain', '@@ -1 +1 @@'],
    ]) {
      const result = await runCli(['show', file], env, '', cwd);
      assert.equal(result.code, 0, `${file}: ${result.stderr}`);
      assert.equal(result.stdout, '');
      if (kind === 'html') assert.match(result.stderr, /To follow CliDeck's theme.*show --template/);
      else assert.equal(result.stderr, '');
      const event = broadcasts.at(-1);
      assert.equal(event.kind, kind);
      assert.equal(event.name, file);
      const response = await fetch(`${httpUrl}${event.url}`);
      assert.equal(response.status, 200);
      assert.equal(response.headers.get('content-type'), mime);
      if (kind === 'html') assert.equal(response.headers.get('content-security-policy'), 'sandbox allow-scripts');
      assert.equal(Buffer.from(await response.arrayBuffer()).toString(), body);
    }

    const starter = await runCli(['show', '--template'], {});
    assert.equal(starter.code, 0, starter.stderr);
    writeFileSync(join(cwd, 'page.html'), starter.stdout);
    const themedFile = await runCli(['show', 'page.html'], env, '', cwd);
    assert.deepEqual(themedFile, { code: 0, stdout: '', stderr: '' });
    const themedResponse = await fetch(`${httpUrl}${broadcasts.at(-1).url}`);
    assert.equal(await themedResponse.text(), starter.stdout);
    for (const [html, hinted] of [['<h1>Plain HTML</h1>', true], [starter.stdout, false]]) {
      const result = await runCli(['show', '--stdin', '--kind', 'html', '--name', 'theme-check'], env, html, cwd);
      assert.equal(result.code, 0, result.stderr);
      assert.equal(result.stdout, '');
      assert.equal(result.stderr.includes('show --template'), hinted);
    }

    const overridden = await runCli(['show', 'notes.txt', '--kind', 'markdown'], env, '', cwd);
    assert.equal(overridden.code, 0, overridden.stderr);
    const overriddenEvent = broadcasts.at(-1);
    assert.equal(overriddenEvent.kind, 'markdown');
    assert.equal(
      (await fetch(`${httpUrl}${overriddenEvent.url}`)).headers.get('content-type'),
      'text/markdown',
    );

    const piped = await runCli(
      ['show', '--stdin', '--kind', 'diff', '--name', 'live.diff'],
      env,
      '@@ piped diff @@\n',
      cwd,
    );
    assert.equal(piped.code, 0, piped.stderr);
    const pipedEvent = broadcasts.at(-1);
    assert.equal(pipedEvent.kind, 'diff');
    assert.equal(pipedEvent.name, 'live.diff');
    const pipedResponse = await fetch(`${httpUrl}${pipedEvent.url}`);
    assert.equal(pipedResponse.headers.get('content-type'), 'text/plain');
    assert.equal(await pipedResponse.text(), '@@ piped diff @@\n');

    for (const [kind, name, body, mime] of [
      ['text', 'notes.txt', 'plain payload', 'text/plain'],
      ['json', 'data.json', '{"ready":true}', 'application/json'],
    ]) {
      const result = await runCli(
        ['show', '--stdin', '--kind', kind, '--name', name],
        env,
        body,
        cwd,
      );
      assert.equal(result.code, 0, result.stderr);
      const event = broadcasts.at(-1);
      assert.equal(event.kind, kind);
      const response = await fetch(`${httpUrl}${event.url}`);
      assert.equal(response.headers.get('content-type'), mime);
      assert.equal(await response.text(), body);
    }

    const replaced = await runCli(
      ['show', '--stdin', '--kind', 'diff', '--name', 'live.diff'],
      env,
      'replacement',
      cwd,
    );
    assert.equal(replaced.code, 0, replaced.stderr);
    const replacedEvent = broadcasts.at(-1);
    assert.equal(replacedEvent.replaces, pipedEvent.contentId);
    assert.notEqual(replacedEvent.contentId, pipedEvent.contentId);
    assert.equal((await fetch(`${httpUrl}${pipedEvent.url}`)).status, 404);
    assert.equal(await (await fetch(`${httpUrl}${replacedEvent.url}`)).text(), 'replacement');

    for (const kind of ['chart', 'testresults']) {
      const result = await runCli(
        ['show', '--stdin', '--kind', kind, '--name', `${kind}.json`],
        env,
        'not validated as JSON',
        cwd,
      );
      assert.equal(result.code, 0, result.stderr);
      const event = broadcasts.at(-1);
      assert.equal(event.kind, kind);
      const response = await fetch(`${httpUrl}${event.url}`);
      assert.equal(response.headers.get('content-type'), 'application/json');
      assert.equal(await response.text(), 'not validated as JSON');
    }

    const tooLarge = await fetch(`${httpUrl}/show`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        sessionId: caller.id,
        payload: 'x'.repeat(MAX_CONTENT_BYTES + 1),
        kind: 'diff',
        name: 'large.diff',
      }),
    });
    assert.equal(tooLarge.status, 413);
    assert.equal((await tooLarge.json()).error, 'too_large');

    assert.equal((await fetch(`${httpUrl}/content/sibling.css`)).status, 404);

    const eventCount = broadcasts.length;
    const outside = await runCli(['show', '../outside.png'], env, '', cwd);
    assert.equal(outside.code, 1);
    assert.match(outside.stderr, /outside the session working directory/i);
    const linked = await runCli(['show', 'linked.png'], env, '', cwd);
    assert.equal(linked.code, 1);
    assert.match(linked.stderr, /outside the session working directory/i);
    const unsupported = await runCli(['show', 'unsupported.bin'], env, '', cwd);
    assert.equal(unsupported.code, 1);
    assert.match(unsupported.stderr, /unsupported content file type/i);
    const payloadOnlyFile = await runCli(
      ['show', 'data.json', '--kind', 'chart'],
      env,
      '',
      cwd,
    );
    assert.equal(payloadOnlyFile.code, 1);
    assert.match(payloadOnlyFile.stderr, /unsupported content kind/i);
    const missing = await runCli(['show', 'missing.png'], env, '', cwd);
    assert.equal(missing.code, 1);
    assert.match(missing.stderr, /not found/i);
    assert.equal(broadcasts.length, eventCount);

    const unknown = await runCli(['show', 'preview.png'], {
      CLIDECK_SESSION_ID: 'missing-session',
      CLIDECK_URL: httpUrl,
    }, '', cwd);
    assert.equal(unknown.code, 1);
    assert.match(unknown.stderr, /Caller session is not active/i);
  } finally {
    await server.close();
    rmSync(dataDir, { recursive: true, force: true });
  }
});
