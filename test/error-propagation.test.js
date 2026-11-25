const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const { tmpdir } = require('node:os');
const { join, resolve } = require('node:path');
const { createServer } = require('node:http');
const { spawn } = require('node:child_process');
const { HeadlessServer } = require('../src/server');
const { AgentSession } = require('../src/session');
const { getProvider } = require('../src/providers');
const { hasValidControlFields } = require('../src/control');
const { createSessionDelivery } = require('../src/session-delivery');
const { ContentStore } = require('../src/content-store');

function cli(args, env) {
  return new Promise(resolveResult => {
    const child = spawn(process.execPath, [resolve(__dirname, '../bin/clideck.js'), ...args], {
      env: { ...process.env, ...env }, stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '', stderr = '';
    child.stdout.on('data', chunk => { stdout += chunk; }); child.stderr.on('data', chunk => { stderr += chunk; });
    child.on('close', code => resolveResult({ code, stdout, stderr }));
  });
}

async function fixture(t) {
  const dir = fs.mkdtempSync(join(tmpdir(), 'clideck-error-api-'));
  const deliveries = [], writes = [];
  const server = new HeadlessServer({ port: 0, dataDir: dir, autoSaveMs: 0, bundledPluginsDir: join(dir, 'bundled'),
    monitorOptions: { timers: { setTimeout() { return 1; }, clearTimeout() {} } },
    agentErrorOptions: { timers: { setTimeout() { return 1; }, clearTimeout() {} },
      deliver: async (row, ctx) => { ctx.commit(); deliveries.push(row); return { state: 'sent', message: 'Delivered.' }; } } });
  const session = new AgentSession({ id: 'error-caller', name: 'Caller', provider: getProvider('codex'), cwd: dir,
    promptSubmitDelay: () => 20, submitRetryMs: 5000 });
  session.status = 'idle'; session.sessionStarted = true;
  session.terminal = { write: value => writes.push(value), kill: () => session.handleExit(0, null) };
  session.close = () => session.handleExit(0, null);
  server.sessions.set(session.id, session); server.persistence.register(session);
  const { httpUrl } = await server.listen();
  t.after(async () => { await server.close(); fs.rmSync(dir, { recursive: true, force: true }); });
  return { dir, server, session, httpUrl, deliveries, writes,
    env: { CLIDECK_URL: httpUrl, CLIDECK_SESSION_ID: session.id } };
}

test('CLI treats malformed JSON and application errors on HTTP200 as failures, including --json', async t => {
  let body = '', status = 200;
  const server = createServer((req, res) => { res.writeHead(status, { 'Content-Type': 'application/json' }); res.end(body); });
  await new Promise(resolveListen => server.listen(0, '127.0.0.1', resolveListen));
  t.after(() => new Promise(resolveClose => server.close(resolveClose)));
  const env = { CLIDECK_URL: `http://127.0.0.1:${server.address().port}`, CLIDECK_SESSION_ID: 'caller' };
  for (const invalid of ['', '{bad', 'null', '[]', '{"ok":false,"error":"broken","message":"Could not do it"}', '{"error":"Monitor storage unavailable"}']) {
    body = invalid;
    const result = await cli(['monitor', 'list', '--json'], env);
    assert.equal(result.code, 1, invalid); assert.equal(result.stdout, ''); assert(result.stderr.length > 0);
  }
  status = 404; body = '';
  const missing = await cli(['monitor', 'list'], env);
  assert.equal(missing.code, 1); assert.match(missing.stderr, /404/);
});

test('plugin activation failure reaches the installing agent instead of Installed success', async t => {
  const f = await fixture(t), source = join(f.dir, 'broken-plugin'); fs.mkdirSync(source);
  fs.writeFileSync(join(source, 'clideck-plugin.json'), JSON.stringify({ id: 'broken-plugin', name: 'Broken Plugin', version: '1.0.0', apiVersion: 1 }));
  fs.writeFileSync(join(source, 'server.js'), 'exports.activate = () => { throw Error("missing configuration"); };');
  const result = await cli(['plugin', 'install', source], f.env);
  assert.equal(result.code, 1); assert.equal(result.stdout, ''); assert.match(result.stderr, /copied but could not activate.*missing configuration/);
  assert.equal(f.server.pluginManager.snapshot().find(plugin => plugin.id === 'broken-plugin').status, 'failed');
});

test('plugin prompt submission waits for Enter and propagates interruption or rejection', async t => {
  const f = await fixture(t);
  let done = false;
  const first = f.server.pluginCoreCall('test', 'sendPrompt', [f.session.id, 'hello']).then(result => { done = true; return result; });
  assert.equal(done, false); assert.equal(f.writes.length, 1); assert(!f.writes.includes('\r'));
  assert.equal(await first, true); assert.equal(f.writes.at(-1), '\r');
  f.session.status = 'idle'; f.session.turnOpen = false;
  const second = f.server.pluginCoreCall('test', 'sendPrompt', [f.session.id, 'interrupted']);
  f.session.markUserActivity(); await assert.rejects(second, /already inserted/);
  await new Promise(resolveWait => setTimeout(resolveWait, 40)); assert.equal(f.writes.filter(value => value === '\r').length, 1);
  f.session.userActivityUntil = 0; f.session.sendPrompt = () => false;
  assert.throws(() => f.server.pluginCoreCall('test', 'sendPrompt', [f.session.id, 'rejected']), /not accepted/);
});

test('preview errors notify only the owning agent and dedup across browser reports/restarts', async t => {
  const f = await fixture(t);
  const post = await fetch(f.httpUrl + '/show', { method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ sessionId: f.session.id, name: 'diagram', kind: 'mermaid', payload: 'bad diagram' }) });
  assert.equal(post.status, 200); const content = await post.json();
  assert.equal(content.reportErrors, true);
  assert.equal(f.server.persistence.get(f.session.id).assets[content.contentId].agentInitiated, true);
  const restored = new ContentStore({ dataDir: f.dir }); restored.restoreSessions(f.server.persistence.list());
  assert.equal(restored.get(content.contentId).agentInitiated, true);
  assert.equal(restored.event(content.contentId, restored.get(content.contentId)).reportErrors, true);
  const message = { type: 'content.renderFailed', sessionId: f.session.id, contentId: content.contentId, message: 'Parse error' };
  const socket = { send() {}, close() { assert.fail('valid render result rejected'); } };
  const control = m => f.server.handleControl(socket, Buffer.from(JSON.stringify(m)));
  control({ ...message, sessionId: 'other' }); assert.equal(f.server.agentErrors.records.size, 0);
  control(message); control(message); await f.server.agentErrors.tick();
  assert.equal(f.deliveries.length, 1); assert.equal(f.deliveries[0].sessionId, f.session.id);
  assert.match(f.deliveries[0].pending.text, /Parse error/);
  const userContent = f.server.contentStore.addOpenPayload(f.session.id, 'manual', 'text', 'user file');
  f.server.publishContent(f.session.id, userContent);
  control({ ...message, contentId: userContent.contentId }); assert.equal(f.server.agentErrors.records.size, 1);
  const replacement = f.server.contentStore.addPayload(f.session.id, 'fixed', 'mermaid', 'diagram');
  f.server.publishContent(f.session.id, replacement, true);
  assert.equal(f.server.agentErrors.records.size, 0);
  control(message); assert.equal(f.server.agentErrors.records.size, 0, 'late old-content errors are ignored');
  assert.equal(hasValidControlFields({ ...message, message: 'x'.repeat(2001) }), false);
});

test('unexpected handler failures return an error response instead of hanging the caller', async t => {
  const f = await fixture(t); f.server.handleHttp = async () => { throw Error('operation broke'); };
  const result = await cli(['plugins'], f.env);
  assert.equal(result.code, 1); assert.match(result.stderr, /operation broke/);
});

test('a real misspelled check reaches its creating session through actual paste and Enter', async t => {
  const f = await fixture(t); f.server.agentErrors.deliver = createSessionDelivery(f.server);
  const added = await cli(['monitor', 'add', '--name', 'Broken inbox', '--run', 'clideck-nonexistent-test-check', '--json'], f.env);
  assert.equal(added.code, 0); const id = JSON.parse(added.stdout).id;
  await f.server.monitors.tick(); await f.server.agentErrors.tick();
  assert.equal(f.writes.length, 0, 'one failed check should not wake the agent');
  f.server.monitors.act({ action: 'check', id });
  await f.server.monitors.tick(); await f.server.agentErrors.tick();
  assert.equal(f.writes.filter(value => value === '\r').length, 1);
  assert.match(f.writes[0], /Command exited 127/); assert.match(f.writes[0], new RegExp(`monitor remove '${id}'`));
  assert.equal(f.server.monitors.rows[0].state, 'error'); assert.equal(f.server.monitors.rows[0].wakeCount, 0);
  const removed = await cli(['monitor', 'remove', id], f.env); assert.equal(removed.code, 0);
  assert.equal(f.server.monitors.rows.length, 0); assert.equal(f.server.agentErrors.records.size, 0);
});

test('caller can inspect and acknowledge an interrupted error, unblocking later notices without resend', async t => {
  const f = await fixture(t), errors = f.server.agentErrors;
  errors.deliver = createSessionDelivery(f.server);
  const report = (key, sessionId = f.session.id) => errors.report({ key, sessionId, operation: 'test', text: key });
  report('interrupted'); const first = errors.records.get('interrupted'); first.pending.phase = 'uncertain'; errors.save();
  report('later'); report('other', 'different-session');
  await errors.tick(); assert.equal(f.writes.length, 0);
  assert.match(errors.records.get('later').message, new RegExp(`errors acknowledge ${first.pending.id}`));
  const listed = await cli(['errors', '--json'], f.env); assert.equal(listed.code, 0);
  assert.equal(JSON.parse(listed.stdout).length, 2, 'other session notices are private to its caller');
  assert.equal((await cli(['errors', 'acknowledge', errors.records.get('other').pending.id], f.env)).code, 1);
  const ack = await cli(['errors', 'acknowledge', first.pending.id], f.env); assert.equal(ack.code, 0, ack.stderr);
  errors.sessionReady(f.session.id); await errors.tick(); await errors.tick();
  assert.equal(f.writes.filter(value => value === '\r').length, 1); assert.match(f.writes[0], /later/);
  assert.equal(first.pending.phase, 'sent'); assert.match(first.message, /without resending/);
  assert.equal((await fetch(f.httpUrl + '/api/session/errors?callerSessionId=' + f.session.id, { headers: { Origin: 'https://evil.example' } })).status, 403);
});

test('CLI passes the supported hour timeout to plugin handlers that await completion', async t => {
  const f = await fixture(t);
  f.server.pluginManager.runCommand = async (id, command, request) => ({ stdout: String(request.timeoutMs), stderr: '', exitCode: 0 });
  const result = await cli(['fake/operation'], f.env);
  assert.equal(result.code, 0); assert.equal(result.stdout, '3600000');
});
