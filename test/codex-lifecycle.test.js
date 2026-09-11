const test = require('node:test');
const assert = require('node:assert/strict');
const { AgentSession } = require('../src/session');
const { getProvider } = require('../src/providers');
const { HeadlessServer } = require('../src/server');
const { mkdtempSync, rmSync } = require('fs');
const { tmpdir } = require('os');
const { join } = require('path');
const { createServer } = require('http');
const { spawn } = require('child_process');
const { createCodexLaunch } = require('../src/codex-launch');

test('Codex displays the native startup model before hooks and later hook metadata takes precedence', () => {
  const session = new AgentSession({ provider: getProvider('codex') });
  const lines = [
    '╭──────────────────────────────────────────╮',
    '│ >_ OpenAI Codex (v0.153.4)                │',
    '│                                          │',
    '│ model:     gpt-6-astra   /model to change │',
    '│ directory: ~/project                      │',
    '╰──────────────────────────────────────────╯',
    '› ',
  ];
  session.screen.lines = () => lines.map(line => line.replace('gpt-6-astra', 'loading'));
  session.analyzeScreen();
  assert.equal(session.model, null);
  session.screen.lines = () => lines;
  session.analyzeScreen();
  assert.equal(session.status, 'idle');
  assert.equal(session.model, 'gpt-6-astra');
  session.handleHook('session-start', { source: 'startup', model: 'another-native-model' });
  session.analyzeScreen();
  assert.equal(session.model, 'another-native-model');
  const { startupModel } = session.provider.screen;
  assert.equal(startupModel(lines.slice(2)), '');
  assert.equal(startupModel(['gpt-6-astra default · ~/project']), '');
  assert.equal(startupModel(lines.map(line => line.replace('gpt-6-astra   ', 'gpt-6-astra high   '))), 'gpt-6-astra');
  assert.equal(startupModel(lines.map(line => line.replace('/model to change', 'unrelated prose'))), '');
});

test('Codex hook definitions stay stable across launches while authenticating each child separately', async (t) => {
  const requests = [];
  const server = createServer((req, res) => {
    let body = '';
    req.on('data', (chunk) => { body += chunk; });
    req.on('end', () => {
      requests.push({ url: req.url, token: req.headers['x-clideck-launch'], body: JSON.parse(body) });
      res.writeHead(204).end();
    });
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const port = server.address().port;
  const first = createCodexLaunch({ port, hookToken: 'first-launch' });
  const second = createCodexLaunch({ port: port + 1, hookToken: 'second-launch' });
  assert.deepEqual(first.args, second.args);
  assert.notEqual(first.env.CLIDECK_HOOK_TOKEN, second.env.CLIDECK_HOOK_TOKEN);
  for (const [args, input] of [[['start'], '{"turn_id":"new"}'], [[String(port), 'idle', 'old-launch'], '']]) {
    const child = spawn(process.execPath, [join(__dirname, '../src/codex-hook.js'), ...args], {
      env: { ...process.env, ...first.env, CLIDECK_URL: '', CLIDECK_NEXT_SESSION_ID: 'test-session' },
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    child.stdin.end(input);
    const code = await new Promise((resolve, reject) => { child.on('error', reject); child.on('exit', resolve); });
    assert.equal(code, 0);
  }
  assert.deepEqual(requests, [
    { url: '/hooks/test-session/start', token: 'first-launch', body: { turn_id: 'new' } },
    { url: '/hooks/test-session/idle', token: 'old-launch', body: {} },
  ]);
});

test('Codex startup is idle, duplicate/completed turn hooks do not reopen work, old stops do not end a new turn', () => {
  const session = new AgentSession({ provider: getProvider('codex') });
  session.handleHook('session-start', { source: 'resume', model: 'gpt-6-astra' });
  assert.equal(session.status, 'idle');
  assert.equal(session.snapshot().model, 'gpt-6-astra');
  session.handleHook('start', { turn_id: 'first' });
  session.lastUpdate = 'preserve preview';
  session.handleHook('start', { turn_id: 'first' });
  assert.equal(session.lastUpdate, 'preserve preview');
  session.handleHook('stop', { turn_id: 'first' });
  session.handleHook('start', { turn_id: 'first' });
  assert.equal(session.status, 'idle');
  session.handleHook('start', { turn_id: 'second' });
  session.handleHook('stop', { turn_id: 'first' });
  assert.equal(session.status, 'working');
  session.handleHook('idle', { turn_id: 'second' });
  assert.equal(session.status, 'idle');
});

test('native clear invalidates context and detaches the old Codex rollout; compact does not cancel work', () => {
  for (const name of ['codex', 'claude-code']) {
    const session = new AgentSession({ provider: getProvider(name) });
    session.status = 'working';
    session.turnOpen = true;
    session.setContextUsage({ usedTokens: 50, windowTokens: 100, percent: 50 });
    session.handleHook('session-start', { source: 'compact' });
    assert.equal(session.status, 'working');
    let stopped = false;
    session.stopContextMonitor = () => { stopped = true; };
    session.handleHook('session-start', { source: 'clear' });
    assert.equal(session.contextUsage, null);
    assert.equal(session.status, 'idle');
    assert.equal(stopped, true);
  }
});

test('model metadata changes without opening a turn and arrives with the first status', () => {
  const session = new AgentSession({ provider: getProvider('codex') });
  const events = [];
  session.on('event', (event) => events.push(event));
  session.handleHook('session-start', { source: 'startup', model: 'gpt-6-astra' });
  assert.equal(events.find((event) => event.type === 'status').model, 'gpt-6-astra');
  const claude = new AgentSession({ provider: getProvider('claude-code') });
  claude.status = 'idle';
  claude.handleHook('context', { model: { display_name: 'Claude Opus' } });
  assert.equal(claude.snapshot().model, 'Claude Opus');
  assert.equal(claude.status, 'idle');
});

test('Codex clear detaches the old context monitor before attaching the new conversation', async (t) => {
  const dataDir = mkdtempSync(join(tmpdir(), 'clideck-clear-context-'));
  const server = new HeadlessServer({ dataDir, port: 0 });
  const monitors = new Map();
  const session = new AgentSession({
    provider: {
      ...getProvider('codex'),
      watchContextUsage(path, onUsage) {
        monitors.set(path, onUsage);
        return () => monitors.delete(path);
      },
    },
  });
  t.after(async () => {
    session.stopContextMonitor();
    server.sessions.clear();
    await server.close();
    rmSync(dataDir, { recursive: true, force: true });
  });
  await server.listen();
  server.sessions.set(session.id, session);
  session.status = 'idle';
  session.recordResumeMetadata({ transcriptPath: '/old.jsonl' });
  monitors.get('/old.jsonl')({ usedTokens: 200_927, windowTokens: 258_400, percent: 77 });
  const events = [];
  session.on('event', event => events.push(event));
  const response = await fetch(`http://127.0.0.1:${server.port}/hooks/${session.id}/session-start`, {
    method: 'POST',
    headers: { 'X-Clideck-Launch': session.hookToken },
    body: JSON.stringify({ source: 'clear', session_id: 'new-native', transcript_path: '/new.jsonl' }),
  });
  assert.equal(response.status, 204);
  assert.equal(session.contextUsage, null);
  assert.equal(events.some(event => event.type === 'status' && event.contextUsage === null), true);
  assert.deepEqual([...monitors.keys()], ['/new.jsonl']);
  // The new reading must arrive without needing another start/stop hook.
  monitors.get('/new.jsonl')({ usedTokens: 28_217, windowTokens: 258_400, percent: 7 });
  assert.equal(session.contextUsage.percent, 7);
  assert.equal(events.at(-1).contextUsage.percent, 7);
});

test('submitting the current Codex clear command hides stale context before native hooks arrive', () => {
  for (const [lines, input, menu, clears] of [
    [['› /clear'], '\r', [], true],
    [['› /clear'], '\n', [], true],
    [['› /clear'], 'x', [], false],
    [['› /clear'], '\x1b', [], false],
    [['› /clear', '› '], '\r', [], false],
    [['› explain /clear'], '\r', [], false],
    [['› /clear extra'], '\r', [], false],
    [['› /clear'], '\r', [{ label: 'Approve' }], false],
    [['› '], '\x1b[200~/clear\n\x1b[201~', [], false],
  ]) {
    const session = new AgentSession({ provider: getProvider('codex') });
    session.status = 'idle';
    session.menu = menu;
    session.screen.lines = () => lines;
    const written = [];
    session.terminal = { write: data => written.push(data) };
    let stopped = false;
    session.stopContextMonitor = () => { stopped = true; };
    session.contextTranscriptPathActive = '/old.jsonl';
    session.setContextUsage({ usedTokens: 200_927, windowTokens: 258_400, percent: 77 });
    const events = [];
    session.on('event', event => events.push(event));
    session.writeInput(input);
    assert.equal(session.contextUsage === null, clears, JSON.stringify({ lines, input, menu }));
    assert.equal(stopped, clears);
    assert.equal(events.some(event => event.contextUsage === null), clears);
    assert.deepEqual(written, [input]);
  }
});

test('Codex hooks from a replaced process cannot change status or native resume metadata', async (t) => {
  const dataDir = mkdtempSync(join(tmpdir(), 'clideck-hook-generation-'));
  const server = new HeadlessServer({ dataDir, port: 0 });
  t.after(async () => { server.sessions.clear(); await server.close(); rmSync(dataDir, { recursive: true, force: true }); });
  await server.listen();
  const session = new AgentSession({ id: 'same-id', provider: getProvider('codex') });
  session.status = 'idle';
  server.sessions.set(session.id, session);
  const url = `http://127.0.0.1:${server.port}/hooks/same-id/start`;
  const post = (token) => fetch(url, { method: 'POST', headers: { 'X-Clideck-Launch': token }, body: JSON.stringify({ session_id: 'native', turn_id: 'turn' }) });
  assert.equal((await post('old-process')).status, 204);
  assert.equal(session.status, 'idle');
  assert.equal((await post(session.hookToken)).status, 204);
  assert.equal(session.status, 'working');
});
