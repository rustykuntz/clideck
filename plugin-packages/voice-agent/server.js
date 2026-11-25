const { Calls } = require('./calls');
const { OpenAILive, configuration, setup, safeError } = require('./openai');
const { BrowserVoice } = require('./browser');
const { VoiceUsage } = require('./usage');

function parse(stdin) {
  try { return JSON.parse(stdin); } catch { throw Error('Provide valid JSON on stdin.'); }
}
async function activate(api, options = {}) {
  const usage = new VoiceUsage(api, options);
  options = { ...options, usage };
  const calls = new Calls(api, options);
  const browser = new BrowserVoice(api, options);
  const recovery = Promise.all([calls.recover(), browser.recover()]);
  api.onSettingsChange(() => {
    if (api.getSetting('talk-to-sessions') === false) browser.stop(undefined, 'off').catch(() => {});
  });
  const status = () => {
    const state = setup(configuration(api));
    state.supervisorSupported = api.capabilities?.sessionSteer === true;
    if (!state.supervisorSupported) state.errors.push('Update and restart CliDeck to enable supervised plugin steering before dialing.');
    if (calls.storageError) state.errors.push(calls.storageError);
    if (state.errors.length) { state.ready = false; state.next = state.errors.join(' '); }
    return state;
  };
  const browserSetup = () => {
    const state = setup(configuration(api), 'browser');
    state.supervisorSupported = api.capabilities?.sessionSteer === true;
    if (!state.supervisorSupported || api.capabilities?.boundedTurns !== true) state.errors.push('Restart CliDeck to finish updating voice support.');
    if (browser.storageError) state.errors.push(browser.storageError);
    state.ready = !state.missing.length && !state.errors.length;
    state.next = state.ready ? 'Click the Voice Agent waveform icon in your session header.' : state.errors[0] || 'Add your OpenAI API key in Voice settings.';
    return state;
  };
  const command = handler => async context => {
    try {
      await recovery;
      const result = await handler(context);
      return { stdout: JSON.stringify(result, null, 2) + '\n', exitCode: 0 };
    } catch (error) { return { stdout: '', stderr: `Voice Agent: ${safeError(error, configuration(api))}\n`, exitCode: 1 }; }
  };
  api.registerCommand('setup', command(async ({ args }) => {
    if (args.length > 1 || args.length && args[0] !== 'check') throw Error('Use voice-agent/setup [check].');
    const config = configuration(api), state = browserSetup();
    state.phone = status();
    if (args[0] === 'check') {
      if (!config['openai-key']) throw Error('Set the OpenAI API key in Voice Agent settings first.');
      Object.assign(state, await (options.provider ? options.provider(config) : new OpenAILive(config)).check());
    }
    return state;
  }));
  api.registerCommand('start', command(async ({ args, stdin, sessionId }) => {
    if (args.length) throw Error('Use voice-agent/start --stdin with a JSON brief.');
    const call = await calls.start(sessionId, parse(stdin));
    if (['uncertain', 'failed'].includes(call.state)) throw Error(`Call ${call.id} is ${call.state}: ${call.error}. It was not redialed.`);
    return call;
  }));
  api.registerCommand('status', command(async ({ args, sessionId }) => {
    if (args.length > 1) throw Error('Use voice-agent/status [call-id].');
    return args.length ? { call: calls.snapshot(calls.get(args[0], sessionId)) } : { setup: browserSetup(), browser: browser.state(sessionId), phoneSetup: status(), calls: calls.list(sessionId) };
  }));
  api.registerCommand('reply', command(async ({ args, stdin, sessionId }) => {
    if (args.length !== 1) throw Error('Use voice-agent/reply <request-id> --stdin with a concise JSON answer.');
    return browser.answer(sessionId, args[0], parse(stdin));
  }));
  for (const name of ['steer', 'key', 'stop']) api.registerCommand(name, command(async ({ args, stdin, sessionId }) => {
    if (args.length !== (name === 'key' ? 2 : 1)) throw Error(`Use voice-agent/${name} <call-id>${name === 'key' ? ' <key>' : name === 'steer' ? ' --stdin' : ''}.`);
    const row = calls.get(args[0], sessionId);
    return name === 'steer' ? calls.steer(row, parse(stdin)) : name === 'key' ? calls.key(row, args[1]) : { call: await calls.stop(row) };
  }));
  api.onClientMessage('request', async (data, context) => {
    if (!data || typeof data.requestId !== 'string' || data.requestId.length > 200) return;
    try {
      await recovery;
      let result;
      if (data.action === 'usage') result = { usage: usage.report(data.filters || {}) };
      else if (data.action === 'status') result = data.callId ? { call: calls.snapshot(calls.get(data.callId)) } : { setup: status(), calls: calls.list() };
      else if (data.action === 'stop') result = { call: await calls.stop(calls.get(data.callId)) };
      else throw Error('Unknown Voice Agent action.');
      context.reply('result', { requestId: data.requestId, ok: true, ...result });
    } catch (error) { context.reply('result', { requestId: data.requestId, ok: false, error: safeError(error, configuration(api)) }); }
  });
  api.onEvent('session.closed', event => {
    for (const row of calls.rows.filter(r => r.sessionId === event.sessionId)) calls.stop(row, 'Supervising session closed.').catch(() => {});
    if (browser.current?.sessionId === event.sessionId) browser.stop(undefined, 'paused', 'This session closed. Open it again to continue with voice.').catch(() => {});
  });
  api.onEvent('session.reply', event => {
    if (event.phase === 'request.acknowledged' && event.origin === 'plugin:voice-agent') calls.acknowledged(event.requestId);
    browser.reply(event).catch(error => api.reportError(event.sessionId, 'browser:reply', safeError(error, configuration(api))).catch(() => {}));
  });
  // Workspace controls return to this browser's Worker, which verifies focus and owns the host media ID.
  api.onClientMessage('voice-ui', (data, context) => {
    if (!data || !['snapshot', 'start', 'pause', 'end', 'settings', 'calls', 'usage', 'check'].includes(data.action)
      || typeof data.sessionId !== 'string' || data.sessionId.length > 160) return;
    context.reply('voice-ui', { action: data.action, sessionId: data.sessionId });
  });
  api.onClientMessage('voice-ui-state', (data, context) => {
    if (data && typeof data.sessionId === 'string' && JSON.stringify(data).length < 40000) context.reply('voice-ui-state', data);
  });
  api.onClientMessage('browser', async (data, context) => {
    if (!data || typeof data.requestId !== 'string' || data.requestId.length > 160) return;
    try {
      await recovery;
      let result;
      if (data.action === 'setup') result = { setup: browserSetup(), ...browser.state(data.sessionId) };
      else if (data.action === 'check') {
        if (!configuration(api)['openai-key']) throw Error('Add your OpenAI API key first.');
        result = { setup: browserSetup(), ...await browser.provider().check() };
      } else if (data.action === 'start') result = await browser.start(data, context);
      else if (data.action === 'ready') result = { accepted: browser.ready(data) };
      else if (data.action === 'heartbeat') result = { accepted: browser.heartbeat(data, context) };
      else if (data.action === 'stop') result = { accepted: await browser.stop(browser.owned(data)) };
      else throw Error('Unknown browser voice action.');
      context.reply('browser-result', { requestId: data.requestId, ok: true, ...result });
    } catch (error) { context.reply('browser-result', { requestId: data.requestId, ok: false, error: safeError(error, configuration(api)) }); }
  });
  api.onShutdown(() => Promise.allSettled([calls.close(), browser.close()]));
  return calls;
}
module.exports = { activate };
