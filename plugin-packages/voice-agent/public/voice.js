(() => {
  'use strict';
  const $ = id => document.getElementById(id);
  const post = (event, data) => parent.postMessage({ type: 'clideck.send', event, data }, '*');
  let sessionId = '', state = null, visible = true, timer, lastAnnouncement = '', transcriptSignature = '';
  const action = name => { if (sessionId) post('voice-ui', { action: name, sessionId }); };
  function render(value) {
    state = value; const mode = value.state || 'off';
    const missing = value.setup?.missing?.includes('openai-key');
    const disabled = value.featureEnabled === false;
    const ready = value.setup?.ready === true, listening = mode === 'listening', connecting = mode === 'connecting';
    $('session-name').textContent = value.name || 'Your session';
    $('stage').dataset.state = mode;
    $('connection').textContent = listening ? 'Microphone on' : connecting ? 'Connecting' : 'Microphone off';
    $('setup').hidden = !missing; $('ready').hidden = !value.setup || missing;
    $('ready-text').textContent = value.checked ? 'OpenAI connection checked' : 'OpenAI key saved';
    $('check').textContent = value.checking ? 'Checking…' : value.checked ? 'Check again' : 'Check connection'; $('check').disabled = value.checking;
    const title = listening ? 'I’m listening' : connecting ? 'Getting your voice ready' : mode === 'paused' ? 'Voice is paused' : mode === 'error' ? 'Let’s get voice connected' : 'A conversation, without typing';
    const copy = listening ? 'Talk naturally. You can interrupt or ask me to wait.' : connecting ? 'Your browser may ask for microphone access. Choose Allow to continue.' : mode === 'paused' ? 'Your agent can keep working. Resume whenever you’re ready.' : 'Your microphone stays off until you start.';
    $('headline').textContent = title; $('description').textContent = copy;
    $('primary').textContent = disabled ? 'Enable Talk to sessions' : missing ? 'Set up voice' : !value.supported ? 'Reload CliDeck to update' : listening ? 'Pause microphone' : connecting ? 'Cancel connecting' : mode === 'paused' ? 'Resume voice' : mode === 'error' ? 'Try again' : 'Start voice';
    $('primary').disabled = !disabled && (!value.setup || (!value.supported && !missing) || (!value.focused && !listening && !connecting));
    $('end').hidden = !value.enabled || connecting;
    $('focus-note').textContent = listening ? 'Only this session is listening. Switching away pauses its microphone and sound.' : 'Switching to another session pauses this microphone and its sound.';
    const error = value.error || value.setup?.errors?.[0] || '';
    $('error').textContent = error; $('error').hidden = !error;
    const request = value.request;
    let update = '';
    if (request) {
      if (['waiting','sending'].includes(request.state)) update = 'Your request is waiting for the session. You don’t need to repeat it.';
      else if (['sent','awaiting'].includes(request.state)) update = 'Your session received the request. Its work can continue while voice is paused.';
      else if (request.state === 'uncertain') update = 'We couldn’t confirm delivery. Check your session before repeating the request.';
      else if (request.state === 'complete') update = 'Your session sent a result. You can ask about it.';
      else if (request.state === 'error') update = request.message || 'Your session could not receive that request.';
    }
    $('request').textContent = update; $('request').hidden = !update;
    const history = Array.isArray(value.transcript) ? value.transcript : [];
    const signature = JSON.stringify(history);
    $('transcript-section').hidden = !history.length;
    if (signature !== transcriptSignature) {
      transcriptSignature = signature;
      $('transcript').replaceChildren(...history.map(turn => {
        const row = document.createElement('div'); row.className = 'utterance';
        const who = document.createElement('strong'); who.textContent = turn.role === 'user' ? 'YOU' : 'VOICE';
        const text = document.createElement('p'); text.textContent = String(turn.text || ''); row.append(who, text); return row;
      }));
    }
    const announce = title + (error ? '. ' + error : '');
    if (announce !== lastAnnouncement) { lastAnnouncement = announce; $('live').textContent = announce; }
  }
  $('primary').onclick = () => {
    if (state?.featureEnabled === false || state?.setup?.missing?.includes('openai-key')) return action('settings');
    action(['listening','connecting'].includes(state?.state) ? 'pause' : 'start');
  };
  $('end').onclick = () => action('end'); $('settings').onclick = $('add-key').onclick = () => action('settings');
  $('calls').onclick = () => action('calls'); $('check').onclick = () => action('check');
  $('usage').onclick = () => action('usage');
  $('get-key').onclick = () => parent.postMessage({ type: 'clideck.open', url: 'https://platform.openai.com/api-keys' }, '*');
  function refresh() { clearInterval(timer); if (visible && sessionId) { action('snapshot'); timer = setInterval(() => action('snapshot'), 4000); } }
  window.addEventListener('message', event => {
    if (event.source !== parent) return;
    const m = event.data || {}, data = m.data || {};
    if (m.type === 'clideck.init') { sessionId = data.context?.sessionId || ''; visible = data.visible !== false; if (data.theme) document.documentElement.dataset.theme = data.theme; refresh(); }
    else if (m.type === 'clideck.theme' && ['light','dark'].includes(data.theme)) document.documentElement.dataset.theme = data.theme;
    else if (m.type === 'clideck.visible') { visible = data.visible !== false; refresh(); }
    else if (m.type === 'clideck.message' && data.event === 'voice-ui-state' && data.data?.sessionId === sessionId) render(data.data);
  });
  window.addEventListener('pagehide', () => clearInterval(timer));
  parent.postMessage({ type: 'clideck.ready' }, '*');
})();
