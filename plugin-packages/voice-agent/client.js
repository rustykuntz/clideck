// Browser Worker: conversation controls only. CliDeck's host owns every microphone and audio track.
const VOICE = 'voice', CALLS = 'calls', USAGE = 'usage';
const uuid = () => crypto.randomUUID();
export function activate(api) {
  const browserId = uuid(), entries = new Map(), pending = new Map(), cleanups = [];
  let focus = { session: null, focused: false, visible: false, connected: false }, active = null, generation = 0, closed = false;
  let stopping = Promise.resolve();
  const capable = () => api.capabilities?.realtimeAudio === true;
  const allowed = () => api.getSettings().values['talk-to-sessions'] !== false;
  const entry = id => {
    if (!entries.has(id)) entries.set(id, { sessionId: id, enabled: false, paused: false, state: 'off', error: '', transcript: [], request: null, setup: null, checking: false, checked: false });
    return entries.get(id);
  };
  const eligible = id => allowed() && !closed && focus.connected && focus.focused && focus.visible && focus.session?.id === id;
  function publish(id) {
    if (!id) return;
    const e = entry(id);
    api.send('voice-ui-state', { ...e, featureEnabled: allowed(), name: focus.session?.id === id ? focus.session.name : '', supported: capable(), focused: eligible(id) });
  }
  function request(action, fields = {}, timeout = 25000) {
    const requestId = uuid();
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { pending.delete(requestId); reject(Error('CliDeck did not answer. Check that it is connected, then try again.')); }, timeout);
      pending.set(requestId, { resolve, reject, timer }); api.send('browser', { action, requestId, browserId, ...fields });
    });
  }
  async function refresh(id) {
    const value = await request('setup', { sessionId: id });
    const e = entry(id); e.setup = value.setup; e.transcript = value.transcript || e.transcript; e.request = value.request; publish(id);
    return value.setup;
  }
  function pause(reason = 'Voice is paused.', manual = false) {
    const old = active; active = null; ++generation;
    if (!old) return stopping;
    clearInterval(old.heartbeat);
    old.controller.abort();
    const e = entry(old.sessionId); e.state = 'paused'; e.error = reason; if (manual) e.paused = true; publish(old.sessionId);
    // Close the local media first, independently of the engine/provider response.
    if (old.id) api.closeRealtimeAudio(old.id).catch(() => {});
    if (old.sent) stopping = request('stop', { connectionId: old.id }, 12000).catch(() => {});
    return stopping;
  }
  async function start(id, explicit = false) {
    const e = entry(id);
    if (!allowed()) { publish(id); return; }
    if (explicit) { e.enabled = true; e.paused = false; e.error = ''; }
    if (!e.enabled || e.paused || !eligible(id) || active?.sessionId === id) { publish(id); return; }
    if (!capable()) { e.state = 'error'; e.error = 'Reload CliDeck to finish updating voice support.'; e.paused = true; publish(id); openVoice({ session: { id } }); return; }
    if (active) pause();
    const ticket = ++generation;
    e.state = 'connecting'; e.error = ''; publish(id);
    const run = { sessionId: id, id: '', sent: false, ticket, controller: new AbortController() };
    active = run;
    const current = () => active === run && ticket === generation && eligible(id);
    try {
      await stopping;
      if (!current()) return;
      const setup = await refresh(id);
      if (!current()) return;
      if (!setup.ready) throw Error(setup.errors?.[0] || 'Add your OpenAI API key to start talking.');
      const media = await api.openRealtimeAudio({ sessionId: id, channelLabel: 'oai-events', signal: run.controller.signal });
      run.id = media.id;
      if (!current()) { await api.closeRealtimeAudio(media.id); return; }
      run.sent = true;
      const answer = await request('start', { connectionId: media.id, sessionId: id, sdp: media.offerSdp });
      if (!current()) { request('stop', { connectionId: media.id }).catch(() => {}); return; }
      await api.setRealtimeAudioAnswer(media.id, answer.sdp);
      if (!current()) return;
      run.heartbeat = setInterval(() => {
        if (!current()) return;
        request('heartbeat', { connectionId: media.id }, 10000).then(result => {
          if (current() && !result.accepted) { pause('The voice connection ended. Press Resume voice to reconnect.', true); }
        }).catch(error => { if (current()) pause(error.message, true); });
      }, 4000);
    } catch (error) {
      if (!current()) return;
      pause('', true); e.state = 'error'; e.error = error?.message || 'Voice could not connect. Try again.'; publish(id); openVoice({ session: { id } });
    }
  }
  function onFocus(next) {
    const previous = focus; focus = next;
    const id = next.session?.id;
    const changed = previous.session?.id !== id || previous.focused !== next.focused || previous.visible !== next.visible || previous.connected !== next.connected;
    if (active && !eligible(active.sessionId)) pause('Paused while you are away from this session.');
    if (id) {
      publish(id);
      if (changed && entry(id).enabled && !entry(id).paused && eligible(id)) start(id);
    }
  }
  function openVoice(context) {
    const sessionId = context?.session?.id || focus.session?.id;
    if (!sessionId) { api.toast('info', { title: 'Choose a session', body: 'Open the session you want to talk to, then choose Talk to this session.' }); return; }
    api.openWorkspace(VOICE, { sessionId });
    refresh(sessionId).catch(error => { entry(sessionId).error = error.message; publish(sessionId); });
  }
  function end(id) {
    const e = entry(id); e.enabled = false; e.paused = true;
    if (active?.sessionId === id) pause();
    e.state = 'off'; e.error = ''; publish(id);
  }
  function toggleVoice(context) {
    const id = context?.session?.id;
    if (!id || !allowed() || id !== focus.session?.id) return;
    const e = entry(id);
    if (e.enabled && !e.paused) end(id); else start(id, true);
  }
  cleanups.push(api.registerWorkspace({ id: VOICE, title: 'Talk to this session', src: '/plugins/voice-agent/public/voice.html' }),
    api.registerWorkspace({ id: CALLS, title: 'Phone calls', src: '/plugins/voice-agent/public/index.html' }),
    api.registerWorkspace({ id: USAGE, title: 'Voice usage & cost', src: '/plugins/voice-agent/public/usage.html' }),
    api.registerAction({ id: 'usage', label: 'Usage & cost', icon: 'clock', description: 'See voice minutes and estimated costs.', placements: ['plugin.settings', 'terminal.header'], run: () => api.openWorkspace(USAGE) }),
    api.registerAction({ id: 'talk', label: 'Voice controls', icon: 'waveform', description: 'Open the conversation and voice settings.', placements: ['plugin.settings'], when: allowed, run: openVoice }),
    api.registerAction({ id: 'voice-off', label: 'Voice Agent', icon: 'waveform', iconOnly: true, pressed: false,
      description: 'Voice Agent · Click to talk to this session', placements: ['terminal.primary'],
      when: context => allowed() && !!context?.session?.id && (!entry(context.session.id).enabled || entry(context.session.id).paused), run: toggleVoice }),
    api.registerAction({ id: 'voice-on', label: 'Voice Agent', icon: 'waveform', iconOnly: true, pressed: true,
      description: 'Voice Agent is on while this session is focused · Click to stop', placements: ['terminal.primary'],
      when: context => allowed() && !!context?.session?.id && entry(context.session.id).enabled && !entry(context.session.id).paused, run: toggleVoice }),
    api.onMessage('browser-result', data => {
      const p = pending.get(data?.requestId); if (!p) return; pending.delete(data.requestId); clearTimeout(p.timer);
      if (data.ok) p.resolve(data); else p.reject(Error(data.error || 'Voice could not connect.'));
    }),
    api.onMessage('browser-state', data => {
      if (!active || data?.connectionId !== active.id || data.sessionId !== active.sessionId) return;
      const e = entry(data.sessionId);
      if (data.transcript) e.transcript = data.transcript;
      if (data.request !== undefined) e.request = data.request;
      if (['error', 'paused'].includes(data.state)) {
        const reconnect = data.reconnect === true && e.enabled && !e.paused && eligible(data.sessionId);
        pause(data.error || 'Voice paused.', !reconnect); e.state = data.state;
        if (reconnect) start(data.sessionId);
      }
      publish(data.sessionId);
    }),
    api.onMessage('voice-ui', async data => {
      const id = data?.sessionId;
      if (!id || id !== focus.session?.id) return;
      const e = entry(id);
      if (data.action === 'snapshot') { publish(id); if (!e.setup) refresh(id).catch(error => { e.error = error.message; publish(id); }); }
      else if (data.action === 'start') start(id, true);
      else if (data.action === 'pause') { e.paused = true; if (active?.sessionId === id) pause('', true); e.state = 'paused'; e.error = ''; publish(id); }
      else if (data.action === 'end') end(id);
      else if (data.action === 'settings') { pause('Paused while you change voice settings.', true); api.openSettings?.(); }
      else if (data.action === 'calls') api.openWorkspace(CALLS, { sessionId: id });
      else if (data.action === 'usage') api.openWorkspace(USAGE);
      else if (data.action === 'check' && !e.checking) {
        e.checking = true; e.error = ''; publish(id);
        try { const result = await request('check', { sessionId: id }); e.checked = result.modelAccess === true; e.setup = result.setup; }
        catch (error) { e.checked = false; e.error = error.message; }
        finally { e.checking = false; publish(id); }
      }
    }),
    api.onSettingsChange(() => {
      if (!allowed()) { pause(); for (const id of entries.keys()) end(id); }
      const id = focus.session?.id; if (id) { entry(id).checked = false; publish(id); refresh(id).catch(() => {}); }
    }),
  );
  if (capable()) {
    cleanups.push(api.onActiveSessionChange(onFocus), api.onRealtimeAudioEvent(event => {
      const run = active; if (!run || event.id !== run.id || event.sessionId !== run.sessionId) return;
      if (event.type === 'state' && event.state === 'connected') {
        request('ready', { connectionId: run.id }).then(result => {
          if (active !== run || !eligible(run.sessionId)) return;
          if (!result.accepted) return pause('The voice connection ended. Press Resume voice to reconnect.', true);
          const e = entry(run.sessionId); e.state = 'listening'; e.error = ''; publish(run.sessionId);
        }).catch(error => { if (active === run) pause(error.message, true); });
      } else if (event.type === 'error') pause(event.error || 'Your microphone or voice connection stopped.', true);
      else if (event.type === 'state' && event.state === 'closed') pause('Voice paused.');
    }));
  } else api.getActiveSession().then(session => { focus = { session, focused: true, visible: true, connected: true }; if (session) publish(session.id); });
  return () => {
    closed = true; pause();
    for (const p of pending.values()) { clearTimeout(p.timer); p.reject(Error('Voice Agent stopped.')); } pending.clear();
    for (const cleanup of cleanups) cleanup?.();
  };
}
