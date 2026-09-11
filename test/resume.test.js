const test = require('node:test');
const assert = require('node:assert/strict');
const { mkdtempSync, rmSync, writeFileSync } = require('fs');
const { tmpdir } = require('os');
const { join } = require('path');
const { createCodexLaunch } = require('../src/codex-launch');
const { getProvider } = require('../src/providers');
const { HeadlessServer } = require('../src/server');

function registrySession(id) {
  return {
    id,
    provider: { id: 'claude-code' },
    cwd: '/tmp/resume-project',
    cols: 90,
    rows: 25,
  };
}

test('provider launches carry native resume handles without changing hook setup', () => {
  const claude = getProvider('claude-code').createLaunch({
    port: 4100,
    sessionId: 'clideck-session',
    resumeHandle: 'claude-native',
  });
  try {
    assert.deepEqual(claude.args.slice(-2), ['--resume', 'claude-native']);
    assert.equal(claude.args.includes('--settings'), true);
  } finally {
    claude.cleanup();
  }

  const codex = createCodexLaunch({
    port: 4100,
    resumeHandle: 'codex-native',
  });
  assert.deepEqual(codex.args.slice(-2), ['resume', 'codex-native']);
  assert.match(codex.args.join(' '), /hooks\.UserPromptSubmit/);
});

test('dormant resume reuses metadata and falls back to a fresh provider launch without a handle', async () => {
  const dataDir = mkdtempSync(join(tmpdir(), 'clideck-next-resume-unit-'));
  const server = new HeadlessServer({ port: 0, dataDir });
  const captured = [];
  server.startSession = (options, register) => {
    captured.push({ options, register });
    return { id: options.id };
  };

  try {
    await server.listen();
    const native = registrySession('native-resume');
    native.muted = true;
    const transcriptPath = join(dataDir, 'native-resume.jsonl');
    writeFileSync(transcriptPath, '{}\n');
    server.persistence.register(native);
    server.persistence.recordResumeMetadata(native.id, {
      handle: 'native-handle',
      transcriptPath,
    });

    assert.equal(server.resumeSession(native.id).id, native.id);
    assert.equal(captured[0].register, false);
    assert.equal(captured[0].options.id, native.id);
    assert.equal(captured[0].options.cwd, native.cwd);
    assert.equal(captured[0].options.cols, native.cols);
    assert.equal(captured[0].options.rows, native.rows);
    assert.equal(captured[0].options.muted, true);
    assert.equal(captured[0].options.providerOptions.resumeHandle, 'native-handle');

    const missingTranscript = registrySession('missing-transcript');
    server.persistence.register(missingTranscript);
    server.persistence.recordResumeMetadata(missingTranscript.id, { handle: 'missing-native' });
    assert.equal(server.resumeSession(missingTranscript.id).id, missingTranscript.id);
    assert.equal(captured[1].options.providerOptions.resumeHandle, 'missing-native');

    const codex = { ...registrySession('codex-resume'), provider: { id: 'codex' } };
    server.persistence.register(codex);
    server.persistence.recordResumeMetadata(codex.id, { handle: 'codex-native' });
    assert.equal(server.resumeSession(codex.id).id, codex.id);
    assert.equal(captured[2].options.providerOptions.resumeHandle, 'codex-native');

    const fallback = registrySession('fresh-fallback');
    server.persistence.register(fallback);
    assert.equal(server.resumeSession(fallback.id).id, fallback.id);
    assert.equal(Object.hasOwn(captured[3].options.providerOptions, 'resumeHandle'), false);

    const shell = { ...registrySession('shell-resume'), provider: { id: 'shell' } };
    server.persistence.register(shell);
    assert.equal(server.resumeSession(shell.id).id, shell.id);
    assert.equal(captured[4].options.provider.id, 'shell');
    assert.equal(Object.hasOwn(captured[4].options.providerOptions, 'resumeHandle'), false);

    const gemini = { ...registrySession('gemini-resume'), provider: { id: 'gemini' } };
    const geminiTranscript = join(dataDir, 'gemini-resume.json');
    writeFileSync(geminiTranscript, '{}\n');
    server.persistence.register(gemini);
    server.persistence.recordResumeMetadata(gemini.id, {
      handle: 'gemini-native',
      transcriptPath: geminiTranscript,
    });
    assert.equal(server.resumeSession(gemini.id).id, gemini.id);
    assert.equal(captured[5].options.providerOptions.resumeHandle, 'gemini-native');

    server.sessions.set(native.id, { closed: false });
    assert.equal(server.resumeSession(native.id), null);
    assert.equal(server.resumeSession('unknown-session'), null);
    assert.equal(captured.length, 6);
    server.sessions.clear();
  } finally {
    await server.close();
    rmSync(dataDir, { recursive: true, force: true });
  }
});

test('engine shutdown waits for live PTYs before closing persistence', async () => {
  const dataDir = mkdtempSync(join(tmpdir(), 'clideck-next-close-unit-'));
  const server = new HeadlessServer({ port: 0, dataDir });
  let release;
  let closeCalled = false;
  let resolved = false;
  const exited = new Promise((resolve) => {
    release = resolve;
  });
  server.sessions.set('live-session', {
    close() {
      closeCalled = true;
    },
    waitForClose() {
      return exited;
    },
  });

  try {
    await server.listen();
    const closing = server.close().then(() => {
      resolved = true;
    });
    await Promise.resolve();
    assert.equal(closeCalled, true);
    assert.equal(resolved, false);
    assert.equal(server.persistence.closed, false);

    release();
    await closing;
    assert.equal(resolved, true);
    assert.equal(server.persistence.closed, true);
  } finally {
    rmSync(dataDir, { recursive: true, force: true });
  }
});

test('engine shutdown force-closes a shell blocked in a foreground process', {
  timeout: 3000,
}, async () => {
  const dataDir = mkdtempSync(join(tmpdir(), 'clideck-next-close-busy-'));
  const server = new HeadlessServer({ port: 0, dataDir });

  try {
    await server.listen();
    const session = server.startSession({
      provider: getProvider('shell'),
      cwd: dataDir,
      port: server.port,
      closeGraceMs: 50,
    }, false);
    session.writeInput('sleep 30\r');
    const startedAt = Date.now();
    await server.close();
    assert.equal(session.closed, true);
    assert.ok(Date.now() - startedAt < 1500);
  } finally {
    if (!server.closePromise) await server.close();
    rmSync(dataDir, { recursive: true, force: true });
  }
});
