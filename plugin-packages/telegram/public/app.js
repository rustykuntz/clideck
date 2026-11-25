// Telegram setup page. Plain script in a sandboxed frame: talks only to `parent` (the CliDeck host) and,
// through it, to the plugin server. Shows the server snapshot; never optimistic — a switch shows On only once
// the server says so. Requests use this page's own requestIds; replies meant for the plugin Worker are ignored.
(function () {
  'use strict';
  const UNSUPPORTED = 'Phone works with Claude and Codex sessions for now.';
  const UNCERTAIN = 'A phone message may not have reached this session completely. Check its terminal, then clear it. It won’t be sent again.';
  const AWAY_COPY = 'While you’re away, replies to what you asked at the desk in sessions with Phone on also go to Telegram. Agent-to-agent asks and monitors stay here.';
  const PLANE = '<svg width="19" height="19" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M21 4 3 11.2l6.6 2.3L18 7.5l-6.3 7.2.2 5.3 3.3-3.9 4.1 3z"/></svg>';
  const root = document.getElementById('root');
  const pageId = 'tg-p-' + Math.random().toString(36).slice(2, 9);
  let snapshot = null, loadError = '', context = {}, seq = 0, clockTimer = null;
  let tokenDraft = '', busy = '', notice = null, confirmingDisconnect = false, confirmingClear = '';
  const pending = new Map();

  // ── bridge ──
  const post = (message) => parent.postMessage(message, '*');
  function request(action, fields) {
    return new Promise((resolve, reject) => {
      const requestId = pageId + '-' + (++seq);
      const timer = setTimeout(() => { pending.delete(requestId); reject(new Error('Telegram didn’t answer in time. Check that CliDeck is connected, then try again.')); }, 20000);
      pending.set(requestId, { resolve, reject, timer });
      post({ type: 'clideck.send', event: 'request', data: Object.assign({ requestId, action }, fields || {}) });
    });
  }
  function adopt(data) {
    if (!data || typeof data !== 'object' || !data.telegram) return false;
    snapshot = { telegram: data.telegram || {}, sessions: Array.isArray(data.sessions) ? data.sessions : [], presence: data.presence || {} };
    loadError = ''; return true;
  }
  window.addEventListener('message', (event) => {
    if (event.source !== parent) return;
    const message = event.data || {};
    if (message.type === 'clideck.init') {
      context = (message.data && message.data.context) || {};
      setTheme(message.data && message.data.theme);
      if (!snapshot) load();
    } else if (message.type === 'clideck.theme') setTheme(message.data && message.data.theme);
    else if (message.type === 'clideck.message') {
      const { event: name, data } = message.data || {};
      if (name === 'updated' && adopt(data)) render();
      else if (name === 'result' && data && pending.has(data.requestId)) {
        const waiting = pending.get(data.requestId); pending.delete(data.requestId); clearTimeout(waiting.timer);
        if (data.ok === false) waiting.reject(new Error(data.message || 'Telegram couldn’t do that.'));
        else { adopt(data); waiting.resolve(data); }
      }
    }
  });
  function setTheme(theme) { if (theme === 'light' || theme === 'dark') document.documentElement.setAttribute('data-theme', theme); }
  function load() { request('status').then(() => render(), (error) => { loadError = error.message; render(); }); }
  function run(action, fields, done) {
    busy = action; notice = null; render();
    return request(action, fields).then(() => {
      busy = ''; notice = done ? { ok: true, text: done } : null; if (action === 'connect') tokenDraft = ''; render();
    }, (error) => { busy = ''; notice = { ok: false, text: error.message }; render(); });
  }
  const openLink = (url) => post({ type: 'clideck.open', url });

  // ── tiny DOM kit ──
  function el(tag, cls, value) { const n = document.createElement(tag); if (cls) n.className = cls; if (value != null) n.textContent = value; return n; }
  function button(label, cls, onClick, opts) {
    opts = opts || {};
    const b = el('button', cls, label); b.type = 'button'; b.disabled = !!opts.disabled || !!busy;
    if (opts.control) b.dataset.control = opts.control;
    b.addEventListener('click', onClick); return b;
  }
  function linkButton(label, url) { const b = el('button', 'ca-link', label); b.type = 'button'; b.title = url; b.addEventListener('click', () => openLink(url)); return b; }
  function section(title) { const s = el('div', 'set-section'); s.append(el('div', 'set-sec-h', title)); return s; }
  function row(title, sub, control) {
    const r = el('div', 'set-row'), lbl = el('div', 'set-row-lbl');
    lbl.append(el('div', 'set-row-t', title));
    if (sub) lbl.append(typeof sub === 'object' ? sub : el('div', 'set-row-s', sub));
    r.append(lbl); if (control) r.append(control); return r;
  }
  function noticeEl(n) { const box = el('div', 'plg-notice ' + (n.ok ? 'ok' : 'bad'), n.text); box.setAttribute('role', n.ok ? 'status' : 'alert'); return box; }
  const minutes = (s) => Math.max(1, Math.round((Number(s) || 600) / 60));
  const person = (p) => [p && p.name, p && p.username ? '@' + p.username : ''].filter(Boolean).join(' ');
  const uncertain = (s) => (s && s.pending && s.pending.state === 'uncertain' && s.pending.id ? s.pending : null);
  const nameOf = (s) => s.name || s.sessionName || (s.sessionId === context.sessionId ? 'This session' : 'Session');
  function expiresIn(ms) { const s = Math.round((ms - Date.now()) / 1000); return s <= 0 ? '' : s < 90 ? 'Link expires in under 2 min' : 'Link expires in ' + Math.round(s / 60) + ' min'; }
  function copy(text, input) {
    const fallback = () => { input.focus(); input.select(); let ok = false; try { ok = document.execCommand('copy'); } catch (e) {} return ok; };
    const say = (ok) => post({ type: 'clideck.toast', kind: ok ? 'success' : 'info', title: 'Telegram', body: ok ? 'Pairing link copied.' : 'The link is selected. Press ⌘C to copy it.' });
    if (navigator.clipboard && navigator.clipboard.writeText) navigator.clipboard.writeText(text).then(() => say(true), () => say(fallback()));
    else say(fallback());
  }

  // ── render ──
  function statusChip(t) {
    const pair = !t.connected ? ['disabled', 'Not connected'] : t.error || t.topicsEnabled === false ? ['failed', 'Needs attention'] : t.paired ? ['ready', 'Connected'] : ['loading', 'Pair your phone'];
    return el('span', 'plg-status ' + pair[0], pair[1]);
  }
  function render() {
    const focused = document.activeElement && document.activeElement.dataset && document.activeElement.dataset.control === 'token';
    clearInterval(clockTimer); clockTimer = null;
    root.replaceChildren();
    const head = el('div', 'ca-head'), ic = el('span', 'ca-ic'); ic.innerHTML = PLANE;
    const titles = el('div', 'ca-titles');
    titles.append(el('div', 'ca-name', 'Telegram'), el('div', 'ca-sub', 'Talk to your sessions from your phone. Each session you turn on gets its own private topic.'));
    head.append(ic, titles); root.append(head);
    if (!snapshot) {
      if (loadError) { root.append(noticeEl({ ok: false, text: loadError }), button('Try again', 'plg-btn', () => { loadError = ''; render(); load(); })); }
      else root.append(el('div', 'ca-loading', 'Loading…'));
      return;
    }
    const t = snapshot.telegram;
    head.append(statusChip(t));
    const card = el('div', 'set-card'); card.dataset.app = 'telegram';
    if (notice) card.append(noticeEl(notice));
    if (t.connected && t.error) card.append(noticeEl({ ok: false, text: t.error }));

    if (!t.connected) {
      const steps = el('ol', 'ca-steps');
      const s1 = el('li'); s1.append(document.createTextNode('In Telegram, open '), linkButton('@BotFather', 'https://t.me/BotFather'), document.createTextNode(' and send '), el('code', '', '/newbot'), document.createTextNode('.'));
      const s2 = el('li'); s2.append(document.createTextNode('In the bot’s settings there, turn on '), el('b', '', 'Threaded Mode'), document.createTextNode(' so each session gets its own topic.'));
      steps.append(s1, s2, el('li', '', 'Paste the token BotFather gives you here.'));
      const field = el('div', 'ca-connect');
      const input = el('input', 'set-input mono'); input.type = 'password'; input.autocomplete = 'off'; input.spellcheck = false;
      input.placeholder = '123456789:AA…'; input.value = tokenDraft; input.setAttribute('aria-label', 'Bot token'); input.dataset.control = 'token';
      const connect = button(busy === 'connect' ? 'Checking…' : 'Connect', 'plg-primary', () => { const token = input.value.trim(); if (token) run('connect', { token }); }, { control: 'connect', disabled: !tokenDraft.trim() });
      input.addEventListener('input', () => { tokenDraft = input.value; connect.disabled = !tokenDraft.trim() || !!busy; });
      input.addEventListener('keydown', (e) => { if (e.key === 'Enter' && !connect.disabled) connect.click(); });
      field.append(input, connect);
      card.append(steps, field, el('div', 'set-hint', 'The token stays on this Mac. CliDeck never shows it again.'));
      const sec = section('Setup'); sec.append(card); root.append(sec);
      if (focused) input.focus();
      return;
    }

    const bot = t.bot || {};
    card.append(row('Bot', bot.name || 'Telegram bot', bot.username ? linkButton('@' + bot.username, 'https://t.me/' + encodeURIComponent(bot.username)) : null));
    if (t.topicsEnabled === false) {
      const warn = el('div', 'plg-notice bad ca-topics');
      warn.append(el('div', '', 'Topics are off for this bot. In @BotFather, open the bot’s settings and turn on Threaded Mode.'),
        button(busy === 'connect' ? 'Checking…' : 'Check again', 'plg-btn', () => run('connect', {}), { control: 'recheck' }));
      card.append(warn);
    }
    if (t.paired) {
      card.append(row('Phone', 'Paired with ' + person(t.paired), button(busy === 'test' ? 'Sending…' : 'Send test', 'plg-btn', () => run('test', {}, 'Test message sent. Check Telegram on your phone.'), { control: 'test' })));
    } else if (t.pairing && t.pairing.url && expiresIn(t.pairing.expiresAt)) {
      const pair = el('div', 'ca-pair');
      pair.append(el('div', 'ca-pair-t', 'Open this link on your phone and tap Start.'));
      const actions = el('div', 'ca-pair-actions');
      const url = el('input', 'set-input mono ca-pair-url'); url.readOnly = true; url.value = t.pairing.url; url.setAttribute('aria-label', 'Pairing link');
      actions.append(url, button('Copy', 'plg-btn', () => copy(t.pairing.url, url), { control: 'copy' }), button('Open in Telegram', 'plg-primary', () => openLink(t.pairing.url), { control: 'open' }));
      const clock = el('div', 'ca-expiry', expiresIn(t.pairing.expiresAt));
      clockTimer = setInterval(() => { const left = expiresIn(t.pairing.expiresAt); if (left) clock.textContent = left; else render(); }, 15000);
      const wait = el('div', 'ca-wait'); wait.append(el('i', 'plg-spinner'), el('span', '', 'Waiting for you to tap Start…'));
      pair.append(actions, wait, clock); card.append(pair);
    } else {
      const expired = !!t.pairing;
      card.append(row('Phone', expired ? 'That pairing link expired.' : 'Not paired yet', button(busy === 'pair' ? 'Creating link…' : expired ? 'New link' : 'Pair phone', 'plg-primary', () => run('pair', {}), { control: 'pair' })));
    }
    const manage = el('div', 'plg-manage ca-manage');
    if (confirmingDisconnect) {
      const confirm = el('div', 'plg-remove-confirm');
      confirm.append(el('span', '', 'Disconnect Telegram? CliDeck stops reading and sending messages. Your Telegram chats stay.'),
        button('Cancel', 'plg-quiet', () => { confirmingDisconnect = false; render(); }),
        button(busy === 'disconnect' ? 'Disconnecting…' : 'Disconnect', 'plg-remove', () => { confirmingDisconnect = false; run('disconnect', {}); }, { control: 'disconnect-yes' }));
      manage.append(confirm);
    } else manage.append(button('Disconnect', 'plg-remove', () => { confirmingDisconnect = true; render(); }, { control: 'disconnect' }));
    card.append(manage);
    const setup = section('Setup'); setup.append(card); root.append(setup);
    if (!t.paired) return;

    const presence = snapshot.presence || {};
    const ps = section('Presence');
    const seg = el('div', 'tasks-seg'); seg.setAttribute('role', 'group'); seg.setAttribute('aria-label', 'Presence');
    [['auto', 'Auto'], ['here', 'Here'], ['away', 'Away']].forEach(([mode, label]) => {
      const b = button(label, 'tasks-seg-b', () => { if (presence.mode !== mode) run('presence', { mode }); }, { disabled: mode === 'auto' && presence.supported === false });
      b.dataset.value = mode; b.setAttribute('aria-pressed', String(presence.mode === mode)); seg.append(b);
    });
    const ph = el('div', 'ca-presence-head'); ph.append(el('div', 'set-row-t', presence.away ? 'You’re away' : 'You’re here'), seg);
    const sub = presence.supported === false ? 'Auto isn’t available on this Mac. Choose Here or Away.' : 'Auto switches to Away after ' + minutes(presence.idleSeconds) + ' min without keyboard or mouse use.';
    ps.append(ph, el('div', 'set-hint ca-presence-sub', sub + ' ' + AWAY_COPY));
    root.append(ps);

    const ss = section('Sessions on your phone');
    const list = snapshot.sessions.filter((s) => s.enabled || s.topicId != null || uncertain(s) || s.sessionId === context.sessionId || (s.error && s.supported !== false));
    if (context.sessionId && !list.some((s) => s.sessionId === context.sessionId)) list.unshift({ sessionId: context.sessionId, enabled: false });
    if (!list.length) ss.append(el('div', 'set-hint', 'None yet. Turn a session on from the plugin menu in its header.'));
    for (const s of list) {
      const supported = s.supported !== false, name = nameOf(s);
      const subEl = s.error ? el('div', 'set-row-s ca-err', s.error)
        : el('div', 'set-row-s', !supported && !s.enabled ? UNSUPPORTED : s.enabled ? 'On · its own topic in Telegram' : s.topicId != null ? 'Off · topic kept and marked Off' : 'Off');
      const sw = el('button', 'set-switch' + (s.enabled ? ' on' : '')); sw.type = 'button'; sw.setAttribute('role', 'switch');
      sw.setAttribute('aria-checked', String(!!s.enabled)); sw.setAttribute('aria-label', 'Phone for ' + name);
      sw.disabled = !!busy || (!supported && !s.enabled);
      sw.addEventListener('click', () => run('phone', { sessionId: s.sessionId, enabled: !s.enabled }));
      ss.append(row(name, subEl, sw));
      const p = uncertain(s);
      if (p) {
        const box = el('div', 'plg-notice bad ca-pending'); box.setAttribute('role', 'alert');
        box.append(el('div', '', p.message || UNCERTAIN));
        const actions = el('div', 'ca-pending-actions');
        if (confirmingClear === p.id) actions.append(el('span', 'ca-pending-q', 'Clear it without sending again?'),
          button('Cancel', 'plg-quiet', () => { confirmingClear = ''; render(); }),
          button(busy === 'acknowledge' ? 'Clearing…' : 'Clear pending', 'plg-remove', () => { confirmingClear = ''; run('acknowledge', { id: p.id }); }, { control: 'clear-yes' }));
        else actions.append(button('Clear pending', 'plg-btn', () => { confirmingClear = p.id; render(); }, { control: 'clear' }));
        box.append(actions); ss.append(box);
      }
    }
    root.append(ss);
  }

  post({ type: 'clideck.ready' });
})();
