// Voice Agent calls page. Plain script in a sandboxed frame: talks only to `parent` (the CliDeck host) and,
// through it, to the plugin server:
//   'request' {requestId, action:'status'}                → 'result' {requestId, ok, setup, calls}
//   'request' {requestId, action:'status', callId}        → 'result' {requestId, ok, call:{…, transcript, delegations, usageSeconds,
//                                                            updateDelivery, truncated}} (top-level copies of those fields also accepted)
//   'request' {requestId, action:'stop', callId}          → 'result' {requestId, ok, call}      (explicit Hang up)
//   'updated' {callId} broadcasts only say "something changed": the page asks again.
// Replies are matched by request ID, so other pages' replies are ignored. The page refreshes only while its tab
// is visible: the list every few seconds, the selected call more often until its state is final (ended/failed).
// Transcript entries arrive as streaming fragments; consecutive fragments from one speaker read as one turn.
// It shows only what the server last said — Hang up never pretends the call ended before the server does.
(function () {
  'use strict';
  const PHONE = '<svg width="19" height="19" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M5 4h4l2 5-2.5 1.5a11 11 0 0 0 5 5L15 13l5 2v4a2 2 0 0 1-2 2A16 16 0 0 1 3 6a2 2 0 0 1 2-2"/></svg>';
  const HANG = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M3 14.5c5-4.7 13-4.7 18 0l-2.4 2.6-3.3-1.6v-2.6a12 12 0 0 0-6.6 0v2.6l-3.3 1.6z"/></svg>';
  const LIST_EVERY = 4000, CALL_EVERY = 1500, WAIT = 15000;
  // Call states → [label, chip]. Unknown states are shown as written, in a neutral chip.
  const STATE = {};
  const states = (names, label, chip) => names.forEach((name) => { STATE[name] = [label, chip]; });
  states(['creating', 'queued', 'pending', 'created'], 'Starting', 'loading');
  states(['dialing', 'initiated', 'calling', 'connecting'], 'Calling', 'loading');
  states(['ringing'], 'Ringing', 'loading');
  states(['connected', 'in-progress', 'active', 'answered', 'live'], 'Connected', 'ready');
  states(['ending', 'hanging-up', 'stopping'], 'Ending', 'loading');
  states(['completed', 'ended', 'hung-up', 'done', 'stopped'], 'Ended', 'disabled');
  states(['busy'], 'Busy', 'disabled');
  states(['no-answer'], 'No answer', 'disabled');
  states(['canceled', 'cancelled'], 'Cancelled', 'disabled');
  states(['failed', 'error'], 'Failed', 'failed');
  states(['uncertain'], 'Not confirmed', 'loading');
  const ENDING = new Set(['ending', 'hanging-up', 'stopping']);
  // Final states: no Hang up, no fast polling. Everything else may still be on the line ('uncertain' included).
  const FINAL = new Set(['ended', 'failed', 'completed', 'hung-up', 'done', 'stopped', 'busy', 'no-answer', 'canceled', 'cancelled', 'error']);
  // Questions the voice agent handed to the session, and the call updates sent to it.
  const QUESTION = { pending: 'Waiting for an answer', answered: 'Answered', superseded: 'Replaced by a newer question' };
  const DELIVERY = { pending: 'Waiting', sending: 'Sending', sent: 'Delivered', delivered: 'Delivered', uncertain: 'Not confirmed', error: 'Couldn’t deliver', failed: 'Couldn’t deliver' };
  const ACRONYM = new Set(['api', 'id', 'sid', 'url', 'sip', 'stt', 'tts', 'llm', 'ai']);
  const BRAND = { openai: 'OpenAI', elevenlabs: 'ElevenLabs' };
  // The Settings labels for this plugin's own keys (clideck-plugin.json); any other key is named from the key itself.
  const FIELD = { 'openai-key': 'OpenAI API key', 'sip-url': 'Phone provider address', 'sip-username': 'Phone connection username', 'sip-password': 'Phone connection password', 'caller-number': 'Caller number' };
  const root = document.getElementById('root'), live = document.getElementById('live');
  const pageId = 'va-p-' + Math.random().toString(36).slice(2, 9);
  const pending = new Map();
  let seq = 0, started = false, visible = true, ctx = {};
  let setup = null, calls = null, listError = '';
  let selected = '', picked = false, detail = null, detailError = '', hanging = '', hangError = '';
  let listBusy = false, listAgain = false, callBusy = false, callAgain = false, listTimer = 0, callTimer = 0;
  let painted = '', announced = '';

  // ── bridge ──
  const post = (message) => parent.postMessage(message, '*');
  function request(action, fields) {
    return new Promise((resolve, reject) => {
      const requestId = pageId + '-' + (++seq);
      const timer = setTimeout(() => { pending.delete(requestId); reject(new Error('Voice Agent didn’t answer. Check that CliDeck is connected; this page keeps trying while it is open.')); }, WAIT);
      pending.set(requestId, { resolve, reject, timer });
      post({ type: 'clideck.send', event: 'request', data: Object.assign({ requestId, action }, fields || {}) });
    });
  }
  window.addEventListener('message', (event) => {
    if (event.source !== parent) return;
    const message = event.data || {};
    if (message.type === 'clideck.init') {
      const data = message.data || {};
      setTheme(data.theme);
      ctx = data.context && typeof data.context === 'object' ? data.context : {};
      visible = data.visible !== false;
      if (!started) { started = true; loadList(); } else if (visible) refresh();
    } else if (message.type === 'clideck.theme') setTheme(message.data && message.data.theme);
    else if (message.type === 'clideck.visible') {
      visible = !!(message.data && message.data.visible);
      if (visible) refresh(); else stopTimers();
    } else if (message.type === 'clideck.message') {
      const { event: name, data } = message.data || {};
      if (name === 'result' && data && pending.has(data.requestId)) {
        const waiting = pending.get(data.requestId); pending.delete(data.requestId); clearTimeout(waiting.timer);
        if (data.ok === false) waiting.reject(new Error(String(data.error || 'Voice Agent couldn’t do that.')));
        else waiting.resolve(data);
      } else if (name === 'updated' && started && visible) {
        loadList();
        if (data && data.callId && data.callId === selected) loadCall();
      }
    }
  });
  function setTheme(theme) { if (theme === 'light' || theme === 'dark') document.documentElement.setAttribute('data-theme', theme); }

  // ── data ──
  const list = (v) => (Array.isArray(v) ? v.filter((x) => x && typeof x === 'object') : []);
  // createdAt may be ISO text, epoch milliseconds or epoch seconds.
  const time = (v) => { const t = typeof v === 'number' ? (v < 1e12 ? v * 1000 : v) : Date.parse(String(v || '')); return Number.isFinite(t) && t > 0 ? t : 0; };
  const call = (c) => ({ id: String(c.id || ''), sessionId: String(c.sessionId || ''), destination: String(c.destination || ''),
    state: String(c.state || '').toLowerCase(), createdAt: time(c.createdAt), error: String(c.error || '') });
  function adoptList(data) {
    const s = data.setup && typeof data.setup === 'object' ? data.setup : null;
    const named = (k) => (typeof k === 'string' ? FIELD[k] || human(k) : k && typeof k === 'object' ? String(k.label || FIELD[k.key] || human(k.key) || '') : '');
    setup = s ? { ready: s.ready === true, missing: (Array.isArray(s.missing) ? s.missing : []).map(named).filter(Boolean),
      errors: (Array.isArray(s.errors) ? s.errors : []).filter((e) => typeof e === 'string' && e.trim()) } : setup;
    calls = list(data.calls).map(call).filter((c) => c.id).sort((a, b) => b.createdAt - a.createdAt);
    if (detail && detail.call) merge(detail.call);
    choose();
  }
  function adoptCall(id, data) {
    const known = (calls || []).find((c) => c.id === id);
    const c = data.call && typeof data.call === 'object' ? call(data.call) : known;
    const src = data.call && typeof data.call === 'object' ? data.call : {};
    const pick = (key) => (data[key] !== undefined ? data[key] : src[key]);
    const usage = pick('usageSeconds');
    detail = {
      id, call: c && c.id === id ? c : known || { id, sessionId: '', destination: '', state: '', createdAt: 0, error: '' },
      transcript: turns(list(pick('transcript'))),
      handoffs: list(pick('delegations')).map((d) => ({ id: String(d.id || ''), state: String(d.state || '').toLowerCase() })),
      usage: usage !== null && usage !== undefined && usage !== '' && Number.isFinite(+usage) ? +usage : null,
      delivery: String(pick('updateDelivery') || '').toLowerCase(),
      truncated: pick('truncated') === true,
      finalized: pick('finalized') === true,
    };
    merge(detail.call);
  }
  // Streaming fragments → turns: consecutive pieces from one speaker join into one line, timed from its first piece.
  function turns(items) {
    const out = [];
    for (const t of items) {
      const speaker = t.speaker === 'assistant' ? 'assistant' : 'caller', text = String(t.text || '');
      const at = t.startMs !== null && t.startMs !== undefined && t.startMs !== '' && Number.isFinite(+t.startMs) ? +t.startMs : null;
      const last = out[out.length - 1];
      if (last && last.speaker === speaker) { last.text += text; if (last.at === null) last.at = at; }
      else out.push({ speaker, text, at });
    }
    return out.map((t) => ({ ...t, text: t.text.trim() })).filter((t) => t.text);
  }
  // The selected call's own reply is fresher than the list: keep the row in step with it.
  function merge(c) { const i = (calls || []).findIndex((x) => x.id === c.id); if (i >= 0) calls[i] = Object.assign({}, calls[i], c, { createdAt: c.createdAt || calls[i].createdAt }); }
  // Default selection: a live call from this session, else this session's newest, else the newest — so a new call
  // from this session comes forward by itself. A row the person picked stays picked while it is still listed.
  function choose() {
    if (!calls) return;
    if (picked && calls.some((c) => c.id === selected)) return;
    const mine = calls.filter((c) => ctx.sessionId && c.sessionId === ctx.sessionId);
    const next = (mine.find((c) => isLive(c.state)) || mine[0] || calls[0] || {}).id || '';
    if (next !== selected) { selected = next; picked = false; detail = null; detailError = ''; hangError = ''; if (selected) loadCall(); }
  }
  const isLive = (state) => !!state && !FINAL.has(state);

  // ── refresh (only while visible) ──
  function stopTimers() { clearTimeout(listTimer); clearTimeout(callTimer); listTimer = callTimer = 0; }
  function refresh() { loadList(); if (selected) loadCall(); }
  function loadList() {
    if (listBusy) { listAgain = true; return; }
    listBusy = true; clearTimeout(listTimer);
    request('status').then((data) => { listError = ''; adoptList(data); }, (error) => { listError = error.message; })
      .then(() => { listBusy = false; paint(); if (listAgain) { listAgain = false; loadList(); } else if (visible) listTimer = setTimeout(loadList, LIST_EVERY); });
  }
  function loadCall() {
    const id = selected;
    if (!id) return;
    if (callBusy) { callAgain = true; return; }
    callBusy = true; clearTimeout(callTimer);
    request('status', { callId: id }).then((data) => { if (id === selected) { detailError = ''; adoptCall(id, data); } },
      (error) => { if (id === selected) detailError = error.message; })
      .then(() => {
        callBusy = false; paint();
        if (callAgain) { callAgain = false; loadCall(); }
        else if (visible && selected && !(detail && detail.id === selected && FINAL.has(detail.call.state))) callTimer = setTimeout(loadCall, CALL_EVERY);
      });
  }
  function pick(id) {
    picked = true;
    if (id === selected) return;
    selected = id; detail = null; detailError = ''; hangError = '';
    paint(); loadCall();
    const card = root.querySelector('[data-detail]');
    if (card && card.scrollIntoView) card.scrollIntoView({ block: 'nearest' });
  }
  function hangUp(id) {
    if (hanging) return;
    hanging = id; hangError = ''; paint();
    request('stop', { callId: id }).then((data) => {
      if (data.call && typeof data.call === 'object' && detail && detail.id === id) { detail.call = call(data.call); merge(detail.call); }
    }, (error) => { hangError = error.message; })
      .then(() => { hanging = ''; paint(); loadCall(); loadList(); });
  }

  // ── render ──
  function el(tag, cls, value) { const n = document.createElement(tag); if (cls) n.className = cls; if (value != null) n.textContent = value; return n; }
  const label = (state) => (STATE[state] || [human(state) || 'Unknown', 'disabled']);
  function human(key) {
    const words = String(key || '').replace(/([a-z0-9])([A-Z])/g, '$1 $2').split(/[-_.\s]+/).filter(Boolean).map((w) => w.toLowerCase());
    return words.map((w, i) => (BRAND[w] || (ACRONYM.has(w) ? w.toUpperCase() : i === 0 ? w[0].toUpperCase() + w.slice(1) : w))).join(' ');
  }
  function chip(state) { const [text, cls] = label(state); const c = el('span', 'plg-status ' + cls, text); return c; }
  function when(ms) {
    if (!ms) return '';
    const d = new Date(ms), t = d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
    return d.toDateString() === new Date().toDateString() ? 'Today ' + t : d.toLocaleDateString([], { month: 'short', day: 'numeric' }) + ', ' + t;
  }
  const clock = (seconds) => { const s = Math.max(0, Math.round(seconds)); return Math.floor(s / 60) + ':' + String(s % 60).padStart(2, '0'); };
  const dest = (c) => c.destination || 'Unknown number';

  function paint() {
    // Polls repeat the same answer most of the time: repaint only when something shown changed, so a
    // transcript selection or a focused button survives quiet refreshes.
    const signature = JSON.stringify([setup, calls, listError, selected, detail, detailError, hanging, hangError, ctx.sessionId || '']);
    if (signature === painted) return;
    painted = signature;
    const old = root.querySelector('.va-transcript');
    const keep = old && { top: old.scrollTop, bottom: old.scrollTop + old.clientHeight >= old.scrollHeight - 24, id: old.dataset.call };
    const focused = document.activeElement && root.contains && root.contains(document.activeElement) && document.activeElement.dataset ? document.activeElement.dataset.control : '';
    root.replaceChildren();
    root.appendChild(head());
    if (listError) root.appendChild(el('div', 'plg-notice bad', listError));
    if (setup && !setup.ready) root.appendChild(setupCard());
    root.appendChild(callsSection());
    if (selected) root.appendChild(detailSection());
    if (calls && calls.length) root.appendChild(el('div', 'va-foot', 'Closing this tab doesn’t end a call. Use Hang up to end one.'));
    const box = root.querySelector('.va-transcript');
    if (box) box.scrollTop = keep && keep.id === box.dataset.call && !keep.bottom ? keep.top : box.scrollHeight;
    if (focused) { const again = root.querySelector('[data-control="' + focused + '"]'); if (again && again.focus) again.focus(); }
    announce();
  }
  function announce() {
    const c = detail && detail.call;
    const text = c && c.state ? dest(c) + ': ' + label(c.state)[0] : '';
    if (text && text !== announced) { if (announced) live.textContent = text; announced = text; }
  }
  function head() {
    const box = el('div', 'va-head'), ic = el('span', 'va-ic'); ic.innerHTML = PHONE;
    const titles = el('div', 'va-titles');
    titles.append(el('div', 'va-name', 'Voice Agent'), el('div', 'va-sub', 'Calls that agents place, with a live transcript.'));
    box.append(ic, titles);
    if (setup) box.appendChild(el('span', 'plg-status ' + (setup.ready ? 'ready' : 'loading'), setup.ready ? 'Ready' : 'Setup needed'));
    return box;
  }
  function setupCard() {
    const card = el('div', 'set-card va-section');
    card.append(el('div', 'va-setup-t', 'Finish setup to place calls'),
      el('div', 'va-setup-s', 'Add the missing details in Settings → Plugins → Voice Agent. Keys and other secrets are entered there, not on this page.'));
    if (setup.missing.length) {
      const items = el('ul', 'va-missing'); items.setAttribute('aria-label', 'Still missing');
      for (const name of setup.missing) items.appendChild(el('li', '', name));
      card.appendChild(items);
    }
    for (const error of setup.errors) card.appendChild(el('div', 'set-hint warn', error));
    return card;
  }
  function callsSection() {
    const section = el('section', 'va-section'); section.setAttribute('aria-label', 'Calls');
    section.appendChild(el('div', 'set-sec-h', 'Calls'));
    const card = el('div', 'set-card va-list');
    if (!calls) card.appendChild(el('div', 'va-empty', listError ? 'Calls will appear once Voice Agent answers.' : 'Loading calls…'));
    else if (!calls.length) card.appendChild(el('div', 'va-empty', setup && !setup.ready ? 'No calls yet. Calls placed by agents appear here once setup is finished.' : 'No calls yet. Calls placed by agents appear here.'));
    for (const c of calls || []) {
      const row = el('button', 'va-call'); row.type = 'button';
      row.dataset.control = 'call:' + c.id; row.dataset.call = c.id;
      row.setAttribute('aria-pressed', String(c.id === selected));
      const main = el('div', 'va-call-main'); main.appendChild(el('div', 'va-dest', dest(c)));
      const meta = el('div', 'va-meta');
      if (c.createdAt) meta.appendChild(el('span', '', when(c.createdAt)));
      if (ctx.sessionId && c.sessionId === ctx.sessionId) meta.appendChild(el('span', 'va-here', (c.createdAt ? ' · ' : '') + 'This session'));
      main.appendChild(meta);
      row.append(main, chip(c.state));
      row.onclick = () => pick(c.id);
      card.appendChild(row);
    }
    section.appendChild(card);
    return section;
  }
  function detailSection() {
    const section = el('section', 'va-section'); section.setAttribute('aria-label', 'Selected call'); section.dataset.detail = selected;
    section.appendChild(el('div', 'set-sec-h', 'Selected call'));
    const card = el('div', 'set-card');
    const c = (detail && detail.call) || (calls || []).find((x) => x.id === selected) || { id: selected, destination: '', state: '', createdAt: 0, sessionId: '', error: '' };
    const top = el('div', 'va-detail-head'), main = el('div', 'va-detail-main');
    const line = el('div', 'va-detail-dest'); line.append(el('span', '', dest(c)));
    if (c.state) line.appendChild(chip(c.state));
    const facts = [];
    if (c.createdAt) facts.push('Started ' + when(c.createdAt).replace(/^Today /, ''));
    if (detail && detail.usage !== null) facts.push(clock(detail.usage) + ' call time');
    if (ctx.sessionId && c.sessionId === ctx.sessionId) facts.push('This session');
    main.append(line); if (facts.length) main.appendChild(el('div', 'va-detail-meta', facts.join(' · ')));
    top.appendChild(main);
    const liveCall = !!detail && detail.id === selected && isLive(c.state);
    if (liveCall) {
      const ending = hanging === c.id || ENDING.has(c.state);
      const button = el('button', 'tasks-stop-confirm va-hangup'); button.type = 'button'; button.dataset.control = 'hangup';
      button.innerHTML = HANG; button.appendChild(el('span', '', hanging === c.id ? 'Hanging up…' : ENDING.has(c.state) ? 'Ending…' : 'Hang up'));
      button.disabled = ending; button.onclick = () => hangUp(c.id);
      top.appendChild(button);
    }
    card.appendChild(top);
    if (c.error) card.appendChild(el('div', 'va-err', c.error));
    if (hangError) card.appendChild(el('div', 'va-err', 'Couldn’t hang up: ' + hangError));
    if (detailError) card.appendChild(el('div', 'va-err', 'Couldn’t refresh this call: ' + detailError));
    card.appendChild(el('div', 'va-sub-h', 'Transcript'));
    if (detail && detail.truncated && detail.transcript.length) card.appendChild(el('div', 'va-quiet va-trimmed', 'Earlier lines were trimmed; the newest are shown.'));
    if (!detail) card.appendChild(el('div', 'va-quiet', detailError ? 'The transcript will appear once Voice Agent answers.' : 'Loading the call…'));
    else if (!detail.transcript.length) card.appendChild(el('div', 'va-quiet', liveCall ? 'Words appear here as soon as someone speaks.' : 'Nothing was said on this call.'));
    else {
      const box = el('div', 'va-transcript'); box.dataset.call = detail.id; box.tabIndex = 0;
      box.setAttribute('role', 'log'); box.setAttribute('aria-label', 'Transcript');
      for (const t of detail.transcript) {
        const row = el('div', 'va-line ' + t.speaker), who = el('div', 'va-who');
        who.appendChild(el('span', '', t.speaker === 'assistant' ? 'Assistant' : 'Person'));
        if (t.at !== null) who.appendChild(el('span', 'va-at', clock(t.at / 1000)));
        row.append(who, el('div', 'va-said', t.text));
        box.appendChild(row);
      }
      card.appendChild(box);
    }
    if (detail && (detail.delivery || detail.handoffs.length)) {
      card.appendChild(el('div', 'va-sub-h', 'Sent to the session'));
      const items = el('ul', 'va-handoffs');
      const add = (name, state, bad) => { const item = el('li', 'va-handoff'); item.append(el('span', '', name), el('span', 'va-state' + (bad ? ' bad' : ''), state)); items.appendChild(item); };
      if (detail.delivery) add('Call updates', DELIVERY[detail.delivery] || human(detail.delivery), detail.delivery === 'error' || detail.delivery === 'failed');
      detail.handoffs.forEach((d, i) => add('Question ' + (i + 1), QUESTION[d.state] || human(d.state) || 'Unknown', false));
      card.appendChild(items);
    }
    section.appendChild(card);
    return section;
  }

  post({ type: 'clideck.ready' });
})();
