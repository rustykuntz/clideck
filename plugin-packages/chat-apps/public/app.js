// Chat apps page. Plain script in a sandboxed frame: talks only to `parent` (the CliDeck host) and, through it,
// to the plugin server. Shows the server snapshot and is never optimistic — a group shows as connected only once
// the server says so. Requests carry this page's own requestIds; replies meant for the plugin Worker are ignored.
// The QR code is shown here and nowhere else: it is never logged, copied or sent anywhere.
(function () {
  'use strict';
  const PENDING = 'A WhatsApp message may not have reached this agent completely. Check its terminal, then clear it. It won’t be sent again.';
  const svg = (size, body, sw) => '<svg width="' + size + '" height="' + size + '" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="' + (sw || 1.9) + '" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' + body + '</svg>';
  const BUBBLES = svg(19, '<path d="M14 9a2 2 0 0 1-2 2H6l-4 4V4a2 2 0 0 1 2-2h8a2 2 0 0 1 2 2z"/><path d="M18 9h2a2 2 0 0 1 2 2v11l-4-4h-6a2 2 0 0 1-2-2v-1"/>');
  const WA = svg(17, '<path d="M3.5 20.5 5 16a8.5 8.5 0 1 1 3 3z"/><path d="M9 8.6c0 3.4 2.9 6.4 6.4 6.4l1.1-1.6-1.9-1-1 .9a4.7 4.7 0 0 1-2.9-2.9l.9-1-1-1.9z"/>', 1.7);
  const HASH = svg(14, '<path d="M5 9h14M5 15h14M10 4 8 20M16 4l-2 16"/>', 1.8);
  const ARROW = svg(12, '<path d="M5 12h14M13 6l6 6-6 6"/>', 2);
  const REFRESH = svg(12, '<path d="M20 12a8 8 0 1 1-2.3-5.6L20 8.7"/><path d="M20 3.5v5.2h-5.2"/>', 2.1);
  const root = document.getElementById('root');
  const pageId = 'ca-p-' + Math.random().toString(36).slice(2, 9);
  let snapshot = null, loadError = '', context = {}, seq = 0;
  let busy = '', notice = null, confirming = '', groupsAsked = false;
  let chosenGroup = '', chosenAgent = '';
  const pending = new Map();

  // ── bridge ──
  const post = (message) => parent.postMessage(message, '*');
  function request(action, fields) {
    return new Promise((resolve, reject) => {
      const requestId = pageId + '-' + (++seq);
      const timer = setTimeout(() => { pending.delete(requestId); reject(new Error('Chat apps didn’t answer in time. Check that CliDeck is connected, then try again.')); }, 20000);
      pending.set(requestId, { resolve, reject, timer });
      post({ type: 'clideck.send', event: 'request', data: Object.assign({ requestId, action }, fields || {}) });
    });
  }
  const list = (v) => (Array.isArray(v) ? v.filter((x) => x && typeof x === 'object') : []);
  function adopt(data) {
    if (!data || typeof data !== 'object' || !data.whatsapp) return false;
    snapshot = { whatsapp: data.whatsapp || {}, sessions: list(data.sessions), groups: list(data.groups), routes: list(data.routes), pending: list(data.pending) };
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
        if (data.ok === false) waiting.reject(new Error(data.message || 'Chat apps couldn’t do that.'));
        else { adopt(data); waiting.resolve(data); }
      }
    }
  });
  function setTheme(theme) { if (theme === 'light' || theme === 'dark') document.documentElement.setAttribute('data-theme', theme); }
  function load() { request('status').then(() => render(), (error) => { loadError = error.message; render(); }); }
  // `key` names what is busy (e.g. "test:g1") so only that control says "Sending…"; every control waits meanwhile.
  function run(key, action, fields, done, scope) {
    busy = key; notice = null; confirming = ''; render();
    return request(action, fields).then(() => {
      busy = ''; notice = done ? { ok: true, text: done, scope: scope || 'groups' } : null;
      if (action === 'bind') chosenGroup = '';
      render();
    }, (error) => { busy = ''; notice = { ok: false, text: error.message, scope: scope || 'groups' }; render(); });
  }

  // ── tiny DOM kit ──
  function el(tag, cls, value) { const n = document.createElement(tag); if (cls) n.className = cls; if (value != null) n.textContent = value; return n; }
  function icon(cls, markup) { const n = el('span', cls); n.innerHTML = markup; return n; }
  function button(label, cls, onClick, opts) {
    opts = opts || {};
    const b = el('button', cls, label); b.type = 'button'; b.disabled = !!opts.disabled || !!busy;
    if (opts.control) b.dataset.control = opts.control;
    if (opts.aria) b.setAttribute('aria-label', opts.aria);
    b.addEventListener('click', onClick); return b;
  }
  function section(title) { const s = el('div', 'set-section'); s.append(el('div', 'set-sec-h', title)); return s; }
  function noticeEl(n, cls) { const box = el('div', 'plg-notice ' + (n.ok ? 'ok' : 'bad') + (cls ? ' ' + cls : ''), n.text); box.setAttribute('role', n.ok ? 'status' : 'alert'); return box; }
  function wait(text) { const w = el('div', 'cx-wait'); w.append(el('i', 'plg-spinner'), el('span', '', text)); return w; }
  const sessionOf = (id) => snapshot.sessions.find((s) => s.sessionId === id) || null;
  const groupName = (id) => { const g = snapshot.groups.find((x) => x.id === id); return g && g.name; };

  // ── render ──
  const STATUS = {
    disconnected: ['disabled', 'Not connected'], preparing: ['loading', 'Preparing'], connecting: ['loading', 'Connecting'],
    pairing: ['loading', 'Scan to link'], connected: ['ready', 'Connected'], error: ['failed', 'Needs attention'],
  };
  function render() {
    root.replaceChildren();
    const head = el('div', 'cx-head'), titles = el('div', 'cx-titles');
    titles.append(el('div', 'cx-name', 'Chat apps'), el('div', 'cx-sub', 'Talk to your agents from WhatsApp on your phone. Each group you connect goes to one agent.'));
    head.append(icon('cx-ic', BUBBLES), titles); root.append(head);
    if (!snapshot) {
      if (loadError) root.append(noticeEl({ ok: false, text: loadError }), button('Try again', 'plg-btn', () => { loadError = ''; render(); load(); }));
      else root.append(el('div', 'cx-loading', 'Loading…'));
      return;
    }
    const w = snapshot.whatsapp, status = STATUS[w.status] ? w.status : 'disconnected';
    root.append(whatsappSection(w, status));
    if (status === 'connected') {
      if (!groupsAsked) { groupsAsked = true; request('groups').then(render, () => {}); }
      root.append(groupsSection());
    } else groupsAsked = false;
    root.append(notesSection());
  }

  function whatsappSection(w, status) {
    const sec = section('WhatsApp'), card = el('div', 'set-card'); card.dataset.app = 'whatsapp';
    const app = el('div', 'cx-app'), t = el('div', 'cx-app-t');
    t.append(el('div', 'cx-app-name', 'WhatsApp'));
    if (status === 'connected' && w.account) t.append(el('div', 'cx-app-acct', String(w.account)));
    const chip = STATUS[status];
    app.append(icon('cx-app-ic', WA), t, el('span', 'plg-status ' + chip[0], chip[1]));
    if (status === 'connected' && confirming !== 'whatsapp') app.append(button('Disconnect', 'plg-quiet cx-app-off', () => { confirming = 'whatsapp'; render(); }, { control: 'disconnect' }));
    card.append(app);
    const body = el('div', 'cx-body');
    let filled = status !== 'connected' || confirming === 'whatsapp';
    if (notice && notice.scope === 'whatsapp') { body.append(noticeEl(notice)); filled = true; }
    if (w.error && (status === 'error' || status === 'connected')) { body.append(noticeEl({ ok: false, text: String(w.error) })); filled = true; }
    const cancel = () => button(busy === 'disconnect' ? 'Stopping…' : 'Cancel', 'plg-quiet', () => run('disconnect', 'disconnect', {}, '', 'whatsapp'), { control: 'cancel' });

    if (status === 'disconnected' || status === 'error') {
      body.append(el('p', 'cx-lede', 'Use the WhatsApp you already have. CliDeck links to it as one more device, the way WhatsApp Web does — no extra number or SIM.'));
      const actions = el('div', 'cx-actions');
      actions.append(button(busy === 'connect' ? 'Starting…' : status === 'error' ? 'Try again' : 'Connect WhatsApp', 'plg-primary', () => run('connect', 'connect', {}, '', 'whatsapp'), { control: 'connect' }));
      body.append(actions);
    } else if (status === 'pairing') {
      const pair = el('div', 'cx-pair'), qr = el('div', 'cx-qr');
      if (w.qrDataUrl) { const img = el('img'); img.src = w.qrDataUrl; img.alt = 'WhatsApp link code'; img.dataset.control = 'qr'; qr.append(img); }
      else qr.append(el('i', 'plg-spinner'));
      const copy = el('div', 'cx-pair-copy'), steps = el('ol', 'cx-steps');
      const s2 = el('li'); s2.append(document.createTextNode('Tap '), el('b', '', 'Settings'), document.createTextNode(' → '), el('b', '', 'Linked devices'), document.createTextNode('.'));
      const s3 = el('li'); s3.append(document.createTextNode('Tap '), el('b', '', 'Link a device'), document.createTextNode(' and scan this code.'));
      steps.append(el('li', '', 'Open WhatsApp on your phone.'), s2, s3);
      const row = el('div', 'cx-wait-row'); row.append(wait(w.qrDataUrl ? 'Waiting for your phone…' : 'Making a code…'), cancel());
      copy.append(steps, row); pair.append(qr, copy); body.append(pair);
    } else if (status === 'preparing' || status === 'connecting') {
      const row = el('div', 'cx-wait-row');
      row.append(wait(status === 'preparing' ? 'Getting WhatsApp ready. The first time can take a minute.' : 'Connecting to WhatsApp…'), cancel());
      body.append(row);
    } else if (confirming === 'whatsapp') {
      const actions = el('div', 'cx-actions');
      actions.append(el('span', 'cx-ask', 'Disconnect WhatsApp? Your groups stay in WhatsApp; agents stop answering them.'),
        button('Cancel', 'plg-quiet', () => { confirming = ''; render(); }),
        button(busy === 'disconnect' ? 'Disconnecting…' : 'Disconnect', 'plg-remove', () => run('disconnect', 'disconnect', {}, '', 'whatsapp'), { control: 'disconnect-yes' }));
      body.append(actions);
    }
    if (filled) card.append(body);
    sec.append(card); return sec;
  }

  function pendingEl(p) {
    const box = el('div', 'plg-notice bad cx-pending'); box.setAttribute('role', 'alert'); box.dataset.pending = p.id;
    box.append(el('div', '', p.message ? String(p.message) : PENDING));
    const actions = el('div', 'cx-pending-actions');
    if (confirming === 'clear:' + p.id) actions.append(el('span', 'cx-pending-q', 'Clear it without sending again?'),
      button('Cancel', 'plg-quiet', () => { confirming = ''; render(); }),
      button(busy === 'ack:' + p.id ? 'Clearing…' : 'Clear', 'plg-remove', () => run('ack:' + p.id, 'acknowledge', { id: p.id }), { control: 'clear-yes' }));
    else actions.append(button('Clear', 'plg-btn', () => { confirming = 'clear:' + p.id; render(); }, { control: 'clear' }));
    box.append(actions); return box;
  }

  function groupsSection() {
    const sec = section('Groups');
    if (notice && notice.scope === 'groups') sec.append(noticeEl(notice));
    const routes = snapshot.routes, linked = new Set(routes.map((r) => r.groupId));
    const routedSessions = new Set(routes.map((r) => r.sessionId));
    // A pending item for an agent with no group still has to be seen and cleared.
    for (const p of snapshot.pending) if (p.id && !routedSessions.has(p.sessionId)) sec.append(pendingEl(p));

    // Connect a group
    const card = el('div', 'set-card'); card.dataset.part = 'connect';
    const open = snapshot.groups.filter((g) => g.id && !linked.has(g.id));
    const refreshing = busy === 'groups';
    const refreshGroups = () => run('groups', 'groups', {});
    if (!open.length) {
      const empty = el('div', 'cx-empty');
      empty.append(el('div', '', snapshot.groups.length
        ? 'Every group is connected. To add another agent, create a new group in WhatsApp, then refresh.'
        : 'No groups yet. In WhatsApp, create a group with only you in it — for example “Legal assistant” — then refresh.'),
        button(refreshing ? 'Refreshing…' : 'Refresh', 'plg-btn', refreshGroups, { control: 'refresh' }));
      card.append(empty);
    } else {
      if (chosenGroup && !open.some((g) => g.id === chosenGroup)) chosenGroup = '';
      const agents = snapshot.sessions.filter((s) => s.sessionId);
      if (!chosenAgent) { const here = agents.find((s) => s.sessionId === context.sessionId && s.supported !== false); if (here) chosenAgent = here.sessionId; }
      if (chosenAgent && !agents.some((s) => s.sessionId === chosenAgent && s.supported !== false)) chosenAgent = '';

      const form = el('div', 'cx-form');
      const refresh = button('', 'cx-refresh' + (refreshing ? ' spin' : ''), refreshGroups, { control: 'refresh', aria: 'Refresh groups' });
      refresh.innerHTML = REFRESH; refresh.append(el('span', '', refreshing ? 'Refreshing' : 'Refresh'));
      const gField = el('div', 'cx-field'), gLab = el('span', 'cx-field-l');
      gLab.append(el('span', '', 'Group'), refresh);
      const gSel = el('select', 'set-select'); gSel.dataset.control = 'group'; gSel.setAttribute('aria-label', 'WhatsApp group');
      gSel.append(placeholder('Choose a group'));
      for (const g of open) { const o = el('option', '', String(g.name || 'Untitled group')); o.value = g.id; gSel.append(o); }
      gSel.value = chosenGroup; gSel.disabled = !!busy;
      gField.append(gLab, gSel);

      const aField = el('div', 'cx-field'), aLab = el('span', 'cx-field-l'); aLab.append(el('span', '', 'Agent'));
      const aSel = el('select', 'set-select'); aSel.dataset.control = 'agent'; aSel.setAttribute('aria-label', 'Agent');
      aSel.append(placeholder(agents.length ? 'Choose an agent' : 'No agents open'));
      const byProject = new Map();
      for (const s of agents) { const p = String(s.projectName || 'No project'); if (!byProject.has(p)) byProject.set(p, []); byProject.get(p).push(s); }
      for (const [project, members] of byProject) {
        const grp = el('optgroup'); grp.label = project;
        for (const s of members) {
          const o = el('option', '', String(s.name || 'Agent') + (s.supported === false ? ' — not supported' : ''));
          o.value = s.sessionId; o.disabled = s.supported === false; grp.append(o);
        }
        aSel.append(grp);
      }
      aSel.value = chosenAgent; aSel.disabled = !!busy || !agents.length;
      aField.append(aLab, aSel);

      const go = button(busy === 'bind' ? 'Connecting…' : 'Connect group', 'plg-primary', () => {
        const g = groupName(chosenGroup) || 'the group', s = sessionOf(chosenAgent);
        run('bind', 'bind', { groupId: chosenGroup, sessionId: chosenAgent }, '“' + g + '” now goes to ' + ((s && s.name) || 'that agent') + '. Send a message there to try it.');
      }, { control: 'bind', disabled: !chosenGroup || !chosenAgent });
      gSel.addEventListener('change', () => { chosenGroup = gSel.value; go.disabled = !chosenGroup || !chosenAgent || !!busy; });
      aSel.addEventListener('change', () => { chosenAgent = aSel.value; go.disabled = !chosenGroup || !chosenAgent || !!busy; });
      form.append(gField, aField, go);
      card.append(form, el('div', 'set-hint', 'Only groups where you’re the only member are listed.'));
    }
    sec.append(card);

    // Connected groups
    if (routes.length) {
      const links = el('div', 'set-card cx-links'); links.dataset.part = 'links';
      for (const r of routes) {
        const s = sessionOf(r.sessionId), name = String(r.name || groupName(r.groupId) || 'Group');
        const item = el('div', 'cx-link'); item.dataset.group = r.groupId;
        const t = el('div', 'cx-link-t'), to = el('div', 'cx-link-to');
        t.append(el('div', 'cx-link-name', name));
        to.innerHTML = ARROW;
        if (s) { const who = el('span', '', String(s.name || 'Agent')); to.append(who); if (s.projectName) to.append(el('span', 'cx-proj', '· ' + s.projectName)); }
        else to.append(el('span', 'cx-gone', 'Agent isn’t open'));
        t.append(to);
        const actions = el('div', 'cx-actions');
        if (confirming === 'unbind:' + r.groupId) {
          actions.append(el('span', 'cx-ask', 'Disconnect?'),
            button('Cancel', 'plg-quiet', () => { confirming = ''; render(); }),
            button(busy === 'unbind:' + r.groupId ? 'Disconnecting…' : 'Disconnect', 'plg-remove', () => run('unbind:' + r.groupId, 'unbind', { groupId: r.groupId }, '“' + name + '” is disconnected. The group stays in WhatsApp.'), { control: 'unbind-yes' }));
        } else {
          actions.append(
            button(busy === 'test:' + r.groupId ? 'Sending…' : 'Send test', 'plg-btn', () => run('test:' + r.groupId, 'test', { groupId: r.groupId }, 'Test sent to “' + name + '”. Check WhatsApp.'), { control: 'test', disabled: !s }),
            button('Disconnect', 'plg-quiet', () => { confirming = 'unbind:' + r.groupId; render(); }, { control: 'unbind', aria: 'Disconnect ' + name }));
        }
        item.append(icon('cx-hash', HASH), t, actions);
        links.append(item);
        for (const p of snapshot.pending) if (p.id && p.sessionId === r.sessionId) links.append(pendingEl(p));
      }
      sec.append(links);
    }
    return sec;
  }
  function placeholder(text) { const o = el('option', '', text); o.value = ''; o.disabled = true; return o; }

  function notesSection() {
    const sec = section('Good to know'), ul = el('ul', 'cx-notes');
    const item = (lead, rest) => { const li = el('li'); li.append(el('b', '', lead), document.createTextNode(' ' + rest)); return li; };
    ul.append(
      item('Your own number.', 'No extra SIM — CliDeck links to your WhatsApp as a device.'),
      item('Only your own groups.', 'A group can be connected only while you’re its only member.'),
      item('Everything shows as you.', 'Your messages and the agent’s replies both come from your account; replies are labelled with the agent’s name.'),
      item('Notifications aren’t guaranteed.', 'Your phone may stay quiet for replies, since they come from your own account.'),
      item('Early prototype.', 'This uses an unofficial WhatsApp connection.'));
    sec.append(ul); return sec;
  }

  post({ type: 'clideck.ready' });
})();
