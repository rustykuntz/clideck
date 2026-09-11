const test = require('node:test');
const assert = require('node:assert/strict');
const { mkdtempSync, rmSync, writeFileSync } = require('fs');
const { tmpdir } = require('os');
const { join } = require('path');
const { AgentSession, sessionEnvironment } = require('../src/session');
const pty = require('../src/pty');
const { getProvider } = require('../src/providers');
const { Screen } = require('../src/screen');

function claudeSession() {
  return new AgentSession({ provider: getProvider('claude-code'), port: 4100 });
}

test('unchanged terminal sizes never reach the PTY, including another client’s resize', () => {
  const session = claudeSession();
  const resizes = [];
  session.terminal = { resize: (...args) => resizes.push(args) };
  session.resize(session.cols, session.rows);
  session.resize(session.cols, session.rows);
  assert.deepEqual(resizes, []);
  session.resize(100, 30);
  session.resize(100, 30);
  assert.deepEqual(resizes, [[100, 30]]);
  assert.equal(session.screen.cols, 100);
  assert.equal(session.screen.rows, 30);
  session.resize(1, 1);
  session.resize(2, 2);
  assert.deepEqual(resizes, [[100, 30], [20, 5]]);
});

test('session environment advertises v2 CLI identity and endpoint', () => {
  const env = sessionEnvironment({ PROVIDER_VALUE: 'yes' }, 'session-one', 43210, '0;15');
  assert.equal(env.PROVIDER_VALUE, 'yes');
  assert.equal(env.CLIDECK_NEXT_SESSION_ID, 'session-one');
  assert.equal(env.CLIDECK_SESSION_ID, 'session-one');
  assert.equal(env.CLIDECK_PORT, '43210');
  assert.equal(env.CLIDECK_URL, 'http://127.0.0.1:43210');
  assert.equal(env.COLORFGBG, '0;15');
});

test('built-in extra arguments prefix provider-managed launch arguments', () => {
  const originalSpawn = pty.spawn;
  let invocation;
  pty.spawn = (command, args, options) => {
    invocation = { command, args, options };
    return {
      pid: 123,
      onData() {},
      onExit() {},
      write() {},
      kill() {},
    };
  };
  const provider = {
    id: 'test-agent',
    command: 'test-agent',
    createLaunch: () => ({
      command: 'test-agent',
      args: ['--managed-hook', 'hook.json'],
    }),
  };
  const session = new AgentSession({
    provider,
    port: 4100,
    providerOptions: {
      extraArgs: ['--dangerously-skip-permissions', '--model', 'two words'],
    },
  });
  try {
    session.start();
    assert.equal(invocation.command, 'test-agent');
    assert.deepEqual(invocation.args, [
      '--dangerously-skip-permissions', '--model', 'two words',
      '--managed-hook', 'hook.json',
    ]);
  } finally {
    pty.spawn = originalSpawn;
    session.handleExit(0, null);
  }
});

test('prompt submission uses bracketed paste and retries Enter only while idle', async () => {
  const create = () => new AgentSession({
    provider: getProvider('codex'),
    port: 4100,
    promptSubmitDelay: () => 5,
    submitRetryMs: 10,
  });
  const idle = create();
  const idleWrites = [];
  idle.status = 'idle';
  idle.terminal = { write: (value) => idleWrites.push(value) };
  assert.equal(idle.sendPrompt('line one\nline two'), true);
  await new Promise((resolve) => setTimeout(resolve, 30));
  assert.deepEqual(idleWrites, [
    '\x1b[200~line one\nline two\x1b[201~',
    '\r',
    '\r',
  ]);
  idle.handleExit(0, null);

  const working = create();
  const workingWrites = [];
  working.status = 'idle';
  working.terminal = { write: (value) => workingWrites.push(value) };
  working.sendPrompt('question');
  working.setStatus('working');
  await new Promise((resolve) => setTimeout(resolve, 30));
  assert.deepEqual(workingWrites, ['\x1b[200~question\x1b[201~', '\r']);
  working.handleExit(0, null);
});

test('steering submits once without resetting the active turn', async () => {
  const session = new AgentSession({
    provider: getProvider('codex'),
    port: 4100,
    promptSubmitDelay: () => 5,
    submitRetryMs: 10,
  });
  const writes = [];
  const events = [];
  session.status = 'working';
  session.turnOpen = true;
  session.baselineCandidate = 'original';
  session.terminal = { write: (value) => writes.push(value) };
  session.on('event', (event) => events.push(event));

  assert.equal(session.steerPrompt('new constraint'), true);
  await new Promise((resolve) => setTimeout(resolve, 30));

  assert.deepEqual(writes, ['\x1b[200~new constraint\x1b[201~', '\r']);
  assert.equal(session.status, 'working');
  assert.equal(session.turnOpen, true);
  assert.equal(session.baselineCandidate, 'original');
  assert.deepEqual(events.filter((event) => event.type === 'turn.user'), [
    { type: 'turn.user', sessionId: session.id, text: 'new constraint' },
  ]);
  session.handleExit(0, null);
});

test('steering refuses an approval menu pending in the screen buffer', async () => {
  const session = new AgentSession({
    provider: getProvider('claude-code'),
    port: 4100,
    promptSubmitDelay: () => 5,
  });
  const writes = [];
  const events = [];
  session.status = 'working';
  session.turnOpen = true;
  session.terminal = { write: (value) => writes.push(value) };
  session.on('event', (event) => events.push(event));
  session.screenBuffer = [
    'Do you want to create proof.txt?',
    '❯ 1. Yes',
    '  2. No',
    'Esc to cancel',
  ].join('\r\n');

  assert.equal(session.steerPrompt('new constraint'), false);
  await new Promise((resolve) => setTimeout(resolve, 15));

  assert.deepEqual(session.menu.map((choice) => choice.label), ['Yes', 'No']);
  assert.deepEqual(writes, []);
  assert.equal(events.some((event) => event.type === 'turn.user'), false);
  session.handleExit(0, null);
});

test('PTY output leads immediately and batches sustained redraws', async () => {
  const session = new AgentSession({
    provider: getProvider('claude-code'),
    port: 4100,
    outputBatchMs: 10,
  });
  const output = [];
  let analyses = 0;
  session.screen.write = (data) => output.push(`screen:${data}`);
  session.analyzeScreen = () => { analyses += 1; };
  session.on('event', (event) => {
    if (event.type === 'output') output.push(`event:${event.data}`);
  });

  session.handleOutput('one');
  session.handleOutput(' two');
  session.handleOutput(' three');
  assert.deepEqual(output, ['event:one', 'screen:one']);
  assert.equal(analyses, 1);

  await new Promise((resolve) => setTimeout(resolve, 30));
  assert.deepEqual(output, ['event:one', 'screen:one', 'event: two three', 'screen: two three']);
  assert.equal(analyses, 2);

  session.handleOutput('four');
  assert.deepEqual(output.slice(-2), ['event:four', 'screen:four']);
  session.handleExit(0, null);
});

test('session output batching defaults to 100ms', () => {
  const session = claudeSession();
  assert.equal(session.outputBatchMs, 100);
  session.handleExit(0, null);
});

test('session tracks bracketed-paste mode for every provider and snapshots changes after output', async () => {
  const session = new AgentSession({
    provider: getProvider('shell'),
    port: 4100,
    outputBatchMs: 5,
  });
  const events = [];
  session.on('event', (event) => events.push(event));

  session.handleOutput('\x1b[?20');
  session.handleOutput('04h');
  await new Promise((resolve) => setTimeout(resolve, 15));

  assert.equal(session.snapshot().bracketedPaste, true);
  const enabled = events.findIndex((event) => event.type === 'session.created' && event.bracketedPaste === true);
  assert(enabled > 0);
  assert.equal(events[enabled - 1].type, 'output');

  session.handleOutput('\x1b[?2004l');
  await new Promise((resolve) => setTimeout(resolve, 15));
  assert.equal(session.snapshot().bracketedPaste, false);

  session.handleOutput('\x1b[?2004h\x1bc');
  await new Promise((resolve) => setTimeout(resolve, 15));
  assert.equal(session.snapshot().bracketedPaste, false);
  session.handleExit(0, null);
});

test('protocol events cannot strand a pending settled screen', async () => {
  const provider = {
    id: 'screen-repro',
    command: 'true',
    statusFromActivity: false,
    requiresSessionStart: false,
    screen: {
      detectMenuDetails: () => ({ choices: [], context: '' }),
      stripMenu: (lines) => lines,
      latestAgentText: () => '',
      hasInputPrompt: (lines) => lines.some((line) => line.includes('>')),
      hasSettledPrompt: (lines) => lines.some((line) => line.includes('>')),
    },
  };
  const session = new AgentSession({ provider, cwd: '/tmp', outputBatchMs: 10 });
  const events = [];
  session.status = 'working';
  session.turnOpen = true;
  session.pendingFinal = true;
  session.on('event', (event) => events.push(event.type));

  session.handleOutput('some agent output\r\n> ');
  session.emitProtocol('turn.user', { text: 'hello' });
  await new Promise((resolve) => setTimeout(resolve, 30));

  assert.equal(session.screenBuffer, '');
  assert.equal(session.status, 'idle');
  assert.deepEqual(events, ['output', 'status', 'turn.user']);
  session.handleExit(0, null);
});

test('session does not emit an empty menu before a real menu appears', () => {
  const session = claudeSession();
  const events = [];
  session.on('event', (event) => events.push(event));
  session.analyzeScreen();
  assert.equal(events.some((event) => event.type === 'menu'), false);
});

test('menu context is present only while choices are active', () => {
  const session = claudeSession();
  const events = [];
  session.on('event', (event) => events.push(event));
  session.screen.write([
    'Create file',
    'proof.txt',
    'Do you want to create proof.txt?',
    '❯ 1. Yes',
    '  2. No',
    'Esc to cancel',
  ].join('\r\n'));
  session.analyzeScreen();

  const opened = events.find((event) => event.type === 'menu');
  assert.match(opened.context, /proof\.txt/);
  assert.equal(opened.choices.length, 2);

  session.screen = new Screen();
  session.analyzeScreen();
  const cleared = events.filter((event) => event.type === 'menu').at(-1);
  assert.deepEqual(cleared.choices, []);
  assert.equal(Object.hasOwn(cleared, 'context'), false);
});

test('Claude finalizes the native Stop message instead of a stale tool block', () => {
  const session = claudeSession();
  const events = [];
  session.on('event', (event) => events.push(event));
  session.handleHook('start');
  session.userPrompts.push('Check the dashboard');
  session.screen.write([
    '❯ Check the dashboard',
    '⏺ Bash(cd /project; date; ps ...)',
    '  ⎿ tool output',
    '❯',
  ].join('\r\n'));

  session.handleHook('stop', {
    last_assistant_message: 'All caught up. Here is where things stand.\n\nThe dashboard remains healthy.',
  });
  session.handleHook('idle');

  const finals = events.filter((event) => event.type === 'agent.final');
  assert.equal(finals.length, 1);
  assert.equal(finals[0].text, 'All caught up. Here is where things stand.\n\nThe dashboard remains healthy.');
  assert.equal(session.status, 'idle');
  assert.equal(session.pendingFinal, false);
});

test('session snapshots identify their provider', () => {
  const session = new AgentSession({ provider: getProvider('codex'), port: 4100 });
  assert.equal(session.snapshot().provider, 'codex');
  assert.equal(session.snapshot().live, true);
  assert.equal(session.snapshot().projectId, null);
  const projected = new AgentSession({
    provider: getProvider('codex'), port: 4100, projectId: 'main',
  });
  assert.equal(projected.snapshot().projectId, 'main');
});

test('session context usage updates status without changing lifecycle state', () => {
  const session = new AgentSession({
    provider: getProvider('pi'), port: 4100, now: () => 654321,
  });
  const events = [];
  session.on('event', (event) => events.push(event));
  session.handleHook('start');
  session.handleHook('context', { context_usage: {
    used_tokens: 25_000,
    window_tokens: 100_000,
    percent: 25,
  } });

  const update = events.at(-1);
  assert.equal(update.type, 'status');
  assert.equal(update.state, 'working');
  assert.equal(update.contextUsage.percent, 25);
  assert.equal(update.contextUsage.estimated, true);
  assert.equal(session.snapshot().contextUsage.percent, 25);

  session.handleHook('stop', { last_assistant_message: 'Done' });
  const final = events.find((event) => event.type === 'agent.final');
  assert.equal(final.at, 654321);
  assert.equal(session.snapshot().lastAgentAt, 654321);
});

test('Shell derives status from output activity without agent events', async () => {
  const provider = { ...getProvider('shell'), activityIdleMs: 30 };
  const session = new AgentSession({ provider, port: 4100 });
  const events = [];
  session.on('event', (event) => events.push(event));

  session.handleOutput('shell output');
  assert.equal(session.status, 'working');
  await new Promise((resolve) => setTimeout(resolve, 20));
  session.handleOutput('more shell output');
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(session.status, 'working');
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(session.status, 'idle');
  assert.deepEqual(
    events.filter((event) => event.type === 'status').map((event) => event.state),
    ['working', 'idle'],
  );
  assert.equal(events.some((event) => event.type.startsWith('agent.')), false);
});

test('Antigravity finalizes Claude-style output after activity settles', async () => {
  const provider = { ...getProvider('antigravity'), activityIdleMs: 20 };
  const session = new AgentSession({ provider, port: 4100, outputBatchMs: 5 });
  const events = [];
  const writes = [];
  session.status = 'idle';
  session.terminal = { write: (value) => writes.push(value) };
  session.on('event', (event) => events.push(event));

  session.writeInput('\r');
  session.handleOutput('❯ Reply with READY\r\n⏺ READY\r\n❯\r\n');
  await new Promise((resolve) => setTimeout(resolve, 45));

  assert.equal(session.status, 'idle');
  assert.equal(session.turnOpen, false);
  assert.deepEqual(writes, ['\r']);
  assert.equal(events.filter((event) => event.type === 'agent.final').length, 1);
  assert.equal(events.find((event) => event.type === 'agent.final').text, 'READY');
  assert.deepEqual(
    events.filter((event) => event.type === 'agent.final' || event.type === 'status')
      .map((event) => event.type === 'status' ? `status:${event.state}` : event.type),
    ['status:working', 'agent.final', 'status:idle'],
  );
  session.handleExit(0, null);
});

test('Codex uses its canonical hook message instead of progressively painted status rows', () => {
  const session = new AgentSession({ provider: getProvider('codex'), port: 4100 });
  const events = [];
  session.on('event', (event) => events.push(event));
  session.userPrompts.push('Reply with exactly READY');
  session.turnOpen = true;
  session.status = 'working';
  session.baselineCandidate = 'READY';

  for (const fragment of ['Wo', 'Wor', 'Work', 'Worki', 'Workin']) {
    session.screen = new Screen();
    session.screen.write([
      '› Reply with exactly READY',
      '• READY',
      '',
      `    ${fragment}`,
    ].join('\r\n'));
    session.analyzeScreen();
  }

  assert.equal(events.some((event) => event.type === 'agent.update'), false);

  session.screen = new Screen();
  session.screen.write([
    '› Reply with exactly READY',
    '• READY',
    '',
    '  Working (2s · esc to interrupt)',
  ].join('\r\n'));
  assert.equal(session.provider.screen.hasSettledPrompt(session.screen.lines()), false);
  session.handleHook('stop', { last_assistant_message: 'READY' });

  assert.deepEqual(
    events.filter((event) => event.type === 'agent.update' || event.type === 'agent.final')
      .map(({ type, text }) => ({ type, text })),
    [
      { type: 'agent.update', text: 'READY' },
      { type: 'agent.final', text: 'READY' },
    ],
  );
  assert.deepEqual(
    events.filter((event) => ['agent.update', 'agent.final', 'status'].includes(event.type))
      .map((event) => event.type),
    ['agent.update', 'agent.final', 'status'],
  );
  assert.equal(session.status, 'idle');
  assert.equal(session.pendingFinal, false);
});

test('Codex stop is authoritative for status and empty canonical text is not screen-finalized', () => {
  const session = new AgentSession({ provider: getProvider('codex'), port: 4100 });
  const events = [];
  session.on('event', (event) => events.push(event));
  session.handleHook('start');
  session.userPrompts.push('Reply with the complete answer');
  session.screen.write([
    '› Reply with the complete answer',
    '• PARTIAL',
    '',
    '  Working (2s · esc to interrupt)',
  ].join('\r\n'));

  assert.equal(session.currentCandidate(), 'PARTIAL');
  session.handleHook('stop', {});
  assert.equal(session.status, 'idle');
  assert.equal(session.turnOpen, false);
  assert.equal(session.pendingFinal, false);
  assert.equal(events.some((event) => (
    event.type === 'agent.update' || event.type === 'agent.final'
  )), false);
});

test('Codex Escape cancels the turn without hooks or screen-derived final text', () => {
  const session = new AgentSession({ provider: getProvider('codex'), port: 4100 });
  const events = [];
  const inputs = [];
  session.on('event', (event) => events.push(event));
  session.terminal = { write: (data) => inputs.push(data) };
  session.handleHook('start');
  session.userPrompts.push('Produce a long answer');
  session.screen.write([
    '› Produce a long answer',
    '• PARTIAL SCREEN TEXT',
    '',
    '  Working (20s · esc to interrupt)',
  ].join('\r\n'));

  session.writeInput('\x1b');

  assert.deepEqual(inputs, ['\x1b']);
  assert.equal(session.status, 'idle');
  assert.equal(session.turnOpen, false);
  assert.equal(session.pendingFinal, false);
  assert.deepEqual(
    events.filter((event) => event.type === 'agent.update' || event.type === 'agent.final'),
    [],
  );
  assert.deepEqual(
    events.filter((event) => event.type === 'status').map((event) => event.state),
    ['working', 'idle'],
  );
});

test('Claude Escape cancels the turn when no stop hook is emitted', () => {
  const session = claudeSession();
  const events = [];
  const inputs = [];
  session.on('event', (event) => events.push(event));
  session.terminal = { write: (data) => inputs.push(data) };
  session.handleHook('start');
  session.screen.write([
    '❯ Write a long answer',
    '⏺ PARTIAL SCREEN TEXT',
    '',
    '  esc to interrupt',
  ].join('\r\n'));

  session.writeInput('\x1b');

  assert.deepEqual(inputs, ['\x1b']);
  assert.equal(session.status, 'idle');
  assert.equal(session.turnOpen, false);
  assert.equal(session.pendingFinal, false);
  assert.deepEqual(
    events.filter((event) => event.type === 'agent.update' || event.type === 'agent.final'),
    [],
  );
  assert.deepEqual(
    events.filter((event) => event.type === 'status').map((event) => event.state),
    ['working', 'idle'],
  );
});

test('Gemini finalizes from the canonical AfterAgent response', () => {
  const session = new AgentSession({ provider: getProvider('gemini'), port: 4100 });
  const events = [];
  session.on('event', (event) => events.push(event));
  session.handleHook('start', { prompt: 'Reply READY' });
  session.screen.write('  Type your message or @path/to/file');
  session.handleHook('stop', { prompt_response: ' READY ' });

  assert.deepEqual(
    events.filter((event) => event.type === 'agent.update' || event.type === 'agent.final')
      .map(({ type, text }) => ({ type, text })),
    [
      { type: 'agent.update', text: 'READY' },
      { type: 'agent.final', text: 'READY' },
    ],
  );
  assert.equal(session.status, 'idle');
});

test('session close wait resolves only after the PTY exit is handled', async () => {
  const session = claudeSession();
  let resolved = false;
  const waiting = session.waitForClose().then(() => {
    resolved = true;
  });

  await Promise.resolve();
  assert.equal(resolved, false);
  session.handleExit(0, 0);
  await waiting;
  assert.equal(resolved, true);
});

test('Claude session close requests the provider clean exit path', () => {
  const session = claudeSession();
  const writes = [];
  session.terminal = {
    write(data) {
      writes.push(data);
    },
  };

  session.close();
  session.close();
  assert.deepEqual(writes, ['\x04\x04']);
});

test('Codex submits its exit command only after the input row renders', () => {
  const session = new AgentSession({ provider: getProvider('codex'), port: 4100 });
  const writes = [];
  session.terminal = {
    write(data) {
      writes.push(data);
    },
  };

  session.close();
  assert.deepEqual(writes, ['/exit']);
  session.handleOutput('unrelated output');
  assert.deepEqual(writes, ['/exit']);

  session.screen = new Screen();
  session.handleOutput('› /exit');
  session.handleOutput('more output');
  assert.deepEqual(writes, ['/exit', '\r']);
});

test('Claude waits for a pending transcript before requesting exit', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'clideck-next-transcript-'));
  const path = join(directory, 'session.jsonl');
  const session = new AgentSession({
    provider: getProvider('claude-code'),
    port: 4100,
    transcriptWaitMs: 1000,
  });
  const written = new Promise((resolve) => {
    session.terminal = { write: resolve };
  });
  session.userPrompts.push('remember this');
  session.recordResumeMetadata({ transcriptPath: path });

  try {
    session.close();
    writeFileSync(path, '{}\n');
    assert.equal(await written, '\x04\x04');
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test('Claude kills the PTY when pending transcript persistence times out', async () => {
  const session = new AgentSession({
    provider: getProvider('claude-code'),
    port: 4100,
    transcriptWaitMs: 10,
  });
  const killed = new Promise((resolve) => {
    session.terminal = { write() {}, kill: resolve };
  });
  session.userPrompts.push('remember this');
  session.recordResumeMetadata({ transcriptPath: '/missing/clideck-next-transcript.jsonl' });

  session.close();
  await killed;
});
