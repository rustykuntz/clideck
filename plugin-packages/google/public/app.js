// Google Workspace page. Plain script in a sandboxed frame: talks only to `parent` (the CliDeck host) and,
// through it, to the plugin server ('request' → 'result' {requestId, ok, ...snapshot}; 'updated' broadcasts).
//
// Everything a person normally needs happens here, without a terminal or outside docs:
//   1. gog is found or installed automatically ('status'; progress via 'install-progress').
//   2. If there is no Google sign-in file (OAuth client) yet, an inline guide walks through Google Cloud and the
//      downloaded JSON is uploaded here ('credentials-save'); it goes straight to gog and is never shown again.
//   3. "Sign in with Google" ('auth-start') with services and access level chosen explicitly; the person opens
//      Google's page with a button (never automatically) and the page follows the snapshot until gog confirms.
//      If the browser can't reach the final local page, its address can be pasted ('auth-complete').
//   4. Accounts can be checked, reconnected (permissions chosen again) or disconnected after a confirmation.
// Explicit checks verify saved sign-ins with Google; ordinary status reuses recent local metadata. Each
// account has one state: Connected, or Needs reconnecting with its next step first and the exact error collapsed
// under Details. Agent access is a local draft that only becomes the shown state when 'access-save' answers ok.
// New sign-ins use the configured client (defaults.client), the everyday services and Read and change; Reconnect
// starts from the account's actual grant. Technical details live under Advanced. Nothing here is optimistic:
// every change shows only after the server's snapshot says so.
(function () {
  'use strict';
  const SETUP_ICON = '<svg viewBox="0 0 16 16" aria-hidden="true"><circle cx="8" cy="8" r="6.25"/><path d="M8 4.9v3.6"/><circle cx="8" cy="11" r=".4" fill="currentColor"/></svg>';
  const ARROW_ICON = '<svg class="gw-setup-go" viewBox="0 0 16 16" aria-hidden="true"><path d="M6 4l4 4-4 4"/></svg>';
  const G = '<svg width="19" height="19" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M20.5 12.2c0 4.8-3.4 8.3-8.4 8.3a8.5 8.5 0 1 1 5.8-14.7"/><path d="M12.4 12.2h8.1"/></svg>';
  const SERVICE = { gmail: 'Gmail', calendar: 'Calendar', drive: 'Drive', docs: 'Docs', sheets: 'Sheets', slides: 'Slides', contacts: 'Contacts', people: 'People', tasks: 'Tasks', chat: 'Chat', keep: 'Keep', forms: 'Forms', groups: 'Groups', classroom: 'Classroom', admin: 'Admin', youtube: 'YouTube' };
  // Google's own pages for the one-time setup. Never gog's docs: everything else happens on this page.
  const CONSOLE = {
    project: 'https://console.cloud.google.com/projectcreate',
    apis: (ids) => 'https://console.cloud.google.com/flows/enableapi?apiid=' + ids.map(encodeURIComponent).join(','),
    auth: 'https://console.cloud.google.com/auth/overview',
    audience: 'https://console.cloud.google.com/auth/audience',
    client: 'https://console.cloud.google.com/auth/clients/create',
    permissions: 'https://myaccount.google.com/permissions',
    twoStep: 'https://support.google.com/accounts/answer/185834',
    recovery: 'https://support.google.com/accounts/answer/9412469',
  };
  const GMAIL = { full: 'full access', readonly: 'read only', send: 'send only', 'read-send': 'read and send' };
  const DRIVE = { full: 'full access', readonly: 'read only', file: 'only files it creates or opens' };
  const ACTIVE = new Set(['starting', 'waiting']);
  const MAX_FILE = 100 * 1024;
  const root = document.getElementById('root');
  const pageId = 'gw-p-' + Math.random().toString(36).slice(2, 9);
  let initialized = false;
  let snapshot = null, loadError = '', seq = 0, updates = 0, busy = '', notice = null;
  let draft = null, draftBase = '', accessNotice = null;   // unsaved Agent access edits; base = the saved state they started from
  let install = null;   // gog setup: {state, source, message, percent?} from replies and 'install-progress', even before a snapshot
  // Preparing the connection is one honest step to the person; what is being fetched stays under Details.
  const WORKING = { checking: 'One moment…', downloading: 'Downloading what CliDeck needs to talk to Google. This happens once on this computer.', verifying: 'Checking the download…' };
  const SUPPORTED = 'CliDeck can install gog by itself on macOS 15 or later and on Ubuntu (Intel/AMD or ARM).';
  // New sign-ins start with the everyday services; six are always in view, the rest wait under More services.
  const CORE = ['gmail', 'calendar', 'drive'];
  const VISIBLE = ['gmail', 'calendar', 'drive', 'docs', 'sheets', 'contacts'];
  // Connect flow — all local, never overwritten by broadcasts.
  let form = null;                // {mode:'add'|'reconnect', email, client, services[], readonly:true|false|null, gmailScope, driveScope}
  let startedAuth = '', watchedAuth = '', dismissedAuth = '', pastedUrl = '', manualCopyUrl = '';
  let requestNotice = null;      // {id, text}: why approving or dismissing a connection request failed
  let connectNotice = null, clientNotice = null, upload = { control: '', text: '' }, removing = '', removingClient = '', clientName = 'default', replaceClient = false;
  const folds = new Set();        // which <details> are open, so a repaint never snaps them shut
  const pending = new Map();

  // ── bridge ──
  const post = (message) => parent.postMessage(message, '*');
  function request(action, fields) {
    return new Promise((resolve, reject) => {
      const requestId = pageId + '-' + (++seq), seen = updates;
      // The first status/check may download and verify gog (up to ~3 min); starting or finishing a Google
      // sign-in waits on gog; everything else is quick.
      const wait = action === 'status' || action === 'check' ? 210000 : action === 'auth-start' || action === 'auth-complete' ? 60000 : 20000;
      const timer = setTimeout(() => { pending.delete(requestId); reject(new Error(action === 'check' ? 'Google didn’t answer in time. Try again in a moment.' : 'The Google Workspace plugin didn’t answer. Check that CliDeck is connected, then try again.')); }, wait);
      pending.set(requestId, { resolve, reject, timer, action, seen });
      post({ type: 'clideck.send', event: 'request', data: Object.assign({ requestId, action }, fields || {}) });
    });
  }
  const valid = (data) => !!data && typeof data === 'object' && (typeof data.available === 'boolean' || Array.isArray(data.accounts));
  const list = (v) => (Array.isArray(v) ? v.filter((x) => x && typeof x === 'object') : []);
  function adopt(data) {
    if (!valid(data)) return false;
    const setup = data.setup && typeof data.setup === 'object' ? data.setup : null;
    snapshot = {
      available: data.available !== false,
      version: String(data.version || ''), executable: String(data.executable || ''),
      accounts: list(data.accounts),
      defaults: data.defaults && typeof data.defaults === 'object' ? data.defaults : {},
      checked: data.checked === true, error: String(data.error || ''),
      next: data.next && typeof data.next === 'object' && data.next.message ? data.next : null,
      // An older installed backend sends no access/setup fields: those parts stay hidden rather than pretending.
      accessSupported: !!data.access && typeof data.access === 'object' && Array.isArray(data.accessOptions),
      // Per-account access (v2). The server moves an older single policy over once it has read the accounts.
      accessByAccount: !!data.access && Array.isArray(data.access.accounts),
      accessOptions: list(data.accessOptions),
      accessError: String(data.accessError || ''),
      setupSupported: !!setup && Array.isArray(setup.clients),
      clients: setup ? list(setup.clients).filter((c) => c.name) : [],
      services: setup ? list(setup.services).filter((x) => x.id) : [],
      setupError: setup ? String(setup.error || '') : '',
      authorization: setup && setup.authorization && typeof setup.authorization === 'object' ? setup.authorization : null,
      requests: list(data.connectionRequests).filter((r) => r.id),
    };
    snapshot.access = normalize(data.access, snapshot.accessOptions);
    if (data.installation && typeof data.installation === 'object') install = data.installation;
    const a = snapshot.authorization;
    if (!a || a.status !== 'waiting' || a.url !== manualCopyUrl) manualCopyUrl = '';
    // Results are shown only for a sign-in this page watched while it ran, not for an old one at page load.
    if (a && ACTIVE.has(a.status)) watchedAuth = a.id;
    if (a && a.id === startedAuth && a.status === 'connected') { form = null; startedAuth = ''; pastedUrl = ''; }
    loadError = ''; return true;
  }
  window.addEventListener('message', (event) => {
    if (event.source !== parent) return;
    const message = event.data || {};
    if (message.type === 'clideck.init') { setTheme(message.data && message.data.theme); if (!initialized) { initialized = true; load(); } }
    else if (message.type === 'clideck.theme') setTheme(message.data && message.data.theme);
    else if (message.type === 'clideck.message') {
      const { event: name, data } = message.data || {};
      if (name === 'updated' && valid(data)) { updates++; adopt(data); render(); }
      else if (name === 'install-progress' && data && typeof data.state === 'string') { install = data; render(); }
      else if (name === 'result' && data && pending.has(data.requestId)) {
        const waiting = pending.get(data.requestId); pending.delete(data.requestId); clearTimeout(waiting.timer);
        if (data.ok === false) waiting.reject(new Error(data.message || 'Google Workspace couldn’t do that.'));
        else {
          // A local status read that a newer broadcast (a check, a settings change) overtook must not roll it back.
          if (waiting.action !== 'status' || waiting.seen === updates || !snapshot) adopt(data);
          waiting.resolve(data);
        }
      }
    }
  });
  function setTheme(theme) { if (theme === 'light' || theme === 'dark') document.documentElement.setAttribute('data-theme', theme); }
  function load() {
    busy = 'check'; render();
    request('check').then(() => { busy = ''; render(); }, (error) => { busy = ''; loadError = notice = error.message; render(); });
  }
  function run(action) {
    busy = action; notice = null; render();
    request(action).then(() => { busy = ''; render(); }, (error) => { busy = ''; notice = error.message; render(); });
  }
  // One explicit action with its own error place; `done(result)` may update local state before the repaint.
  function act(action, fields, onError, done) {
    busy = action; render();
    return request(action, fields).then((result) => { busy = ''; if (done) done(result); render(); },
      (error) => { busy = ''; onError(error.message); render(); });
  }
  function saveAccess() {
    const access = normalize(draft, snapshot.accessOptions);
    busy = 'access-save'; accessNotice = null; render();
    request('access-save', { access }).then(() => { busy = ''; draft = null; accessNotice = { ok: true, text: 'Access saved.' }; render(); },
      (error) => { busy = ''; accessNotice = { ok: false, text: error.message }; render(); });
  }
  const openLink = (url) => { if (/^https:\/\//i.test(String(url || ''))) post({ type: 'clideck.open', url: String(url) }); };
  // Keeps "Link expires in N min" honest while Google's page is open; nothing else is polled.
  setInterval(() => { const a = snapshot && snapshot.authorization; if (a && a.status === 'waiting' && a.expiresAt) render(); }, 15000);

  // ── tiny DOM kit ──
  function el(tag, cls, value) { const n = document.createElement(tag); if (cls) n.className = cls; if (value != null) n.textContent = value; return n; }
  function button(label, cls, onClick, control) {
    const b = el('button', cls, label); b.type = 'button'; b.disabled = !!busy;
    if (control) b.dataset.control = control;
    b.addEventListener('click', (event) => { if (!b.disabled) onClick(event); }); return b;
  }
  function link(label, url, control) { const b = el('button', 'gw-link', label); b.type = 'button'; b.title = url; if (control) b.dataset.control = control; b.addEventListener('click', () => openLink(url)); return b; }
  function bad(text) { const box = el('div', 'plg-notice bad', text); box.setAttribute('role', 'alert'); return box; }
  function good(text) { const box = el('div', 'plg-notice ok', text); box.setAttribute('role', 'status'); return box; }
  function row(title, value, mono) { const r = el('div', 'set-row'), lbl = el('div', 'set-row-lbl'); lbl.append(el('div', 'set-row-t', title)); r.append(lbl, el('div', 'gw-value' + (mono ? ' gw-mono' : ''), value)); return r; }
  function fold(control, summary, cls) {
    const d = el('details', 'gw-fold' + (cls ? ' ' + cls : '')); d.dataset.control = control; d.open = folds.has(control);
    d.addEventListener('toggle', () => { if (d.open) folds.add(control); else folds.delete(control); });
    d.append(el('summary', '', summary)); return d;
  }
  const serviceName = (s) => SERVICE[String(s).toLowerCase()] || (String(s).charAt(0).toUpperCase() + String(s).slice(1));
  const same = (a, b) => !!a && !!b && String(a).toLowerCase() === String(b).toLowerCase();
  const clientsOf = (s) => s.clients.map((c) => String(c.name));
  // The configured client (defaults.client, e.g. "clideck") wins; otherwise gog's "default", else the first saved one.
  const defaultClient = (s) => (s.defaults.client ? String(s.defaults.client).toLowerCase() : clientsOf(s).includes('default') ? 'default' : clientsOf(s)[0] || 'default');
  const hasClient = (s, name) => clientsOf(s).map((n) => n.toLowerCase()).includes(String(name || '').toLowerCase());

  // ── gog setup ──
  const working = () => !!install && Object.prototype.hasOwnProperty.call(WORKING, install.state);
  function progressCard() {
    const card = el('div', 'set-card gw-install'); card.setAttribute('role', 'status');
    card.append(el('div', 'set-row-t', 'Preparing Google connection'), el('div', 'set-row-s', WORKING[install.state]));
    if (install.state !== 'checking') {
      const pct = typeof install.percent === 'number' && isFinite(install.percent) ? Math.max(0, Math.min(100, Math.round(install.percent))) : null;
      const bar = el('div', 'gw-progress' + (pct == null ? ' gw-indeterminate' : '')), fill = el('div', 'gw-progress-fill');
      bar.setAttribute('role', 'progressbar'); bar.setAttribute('aria-label', 'Preparing Google connection');
      if (pct != null) { fill.style.width = pct + '%'; bar.setAttribute('aria-valuenow', String(pct)); bar.setAttribute('aria-valuemin', '0'); bar.setAttribute('aria-valuemax', '100'); }
      bar.append(fill);
      const line = el('div', 'gw-progress-line'); line.append(bar); if (pct != null) line.append(el('span', 'gw-pct', pct + '%'));
      card.append(line);
    }
    return card;
  }
  // A failed setup says what actually went wrong; Retry is one explicit status request, never automatic.
  function failedSetup() {
    const card = el('div', 'set-card');
    card.append(el('div', 'set-row-t', 'CliDeck couldn’t prepare the Google connection.'),
      el('div', 'set-row-s', 'Check that this computer is online, then try again.'));
    const again = el('div', 'gw-actions gw-retry'); again.append(button(busy === 'status' ? 'Retrying…' : 'Try again', 'plg-primary', () => { loadError = ''; snapshot ? run('status') : load(); }, 'install-retry'));
    card.append(again, technical('fold-setup-details', [install.message || 'Setup failed.', SUPPORTED + ' Elsewhere, install gog yourself or set its full path in Settings → Plugins → Google Workspace.']));
    return card;
  }
  // Technical detail, collapsed: the exact message for whoever needs it, never the headline.
  function technical(control, lines) {
    const d = fold(control, 'Details', 'gw-tech');
    for (const line of lines.filter(Boolean)) d.append(el('div', 'gw-tech-line', String(line)));
    return d;
  }
  const SOURCE = { system: 'Existing gog on this computer', custom: 'The gog location set in Settings', managed: 'Installed by CliDeck' };

  // ── one state per account: Connected · Needs reconnecting (· Checking while Google is asked) ──
  // Page entry and Check again verify sign-ins with Google.
  // Only an explicit refusal from Google (revoked / expired / invalid token) sends someone back to sign in. Any
  // other failed check (offline, timeout, keyring) is "Couldn't check" with Check again: no needless re-consent.
  const failing = (a) => a.valid === false || !!a.error;
  const revoked = (a) => failing(a) && /invalid_grant|invalid_token|expired or revoked|been expired|been revoked|token (?:has )?expired|revoked/i.test(String(a.error || ''));
  const asking = () => busy === 'check' || busy === 'status';
  function overall(s) {
    if (working() && install.state !== 'checking') return ['loading', 'Preparing'];
    if (!s.available) return ['failed', 'Not available'];
    if (s.accounts.some(revoked)) return ['failed', 'Needs attention'];
    if (s.accounts.some(failing)) return asking() ? ['loading', 'Checking'] : ['loading', 'Couldn’t check'];
    if (s.error) return ['failed', 'Needs attention'];
    if (!s.accounts.length) return ['disabled', 'Not connected'];
    if (s.accounts.every((a) => a.valid === true)) return ['ready', 'Connected'];
    return asking() ? ['loading', 'Checking'] : ['loading', 'Signed in'];
  }
  function accountState(a) {
    if (revoked(a)) return ['failed', 'Needs reconnecting'];
    if (failing(a)) return asking() ? ['loading', 'Checking'] : ['loading', 'Couldn’t check'];
    if (a.valid === true) return ['ready', 'Connected', 'Google confirmed this sign-in.'];
    return asking() ? ['loading', 'Checking'] : ['loading', 'Signed in', 'Saved on this computer. Check again verifies current access with Google.'];
  }
  function chip(pair) { const c = el('span', 'plg-status ' + pair[0], pair[1]); if (pair[2]) c.title = pair[2]; return c; }
  // Plain words for an account's granted scopes; the exact list stays in the tooltip.
  const realScopes = (scopes) => (Array.isArray(scopes) ? scopes : []).filter((x) => typeof x === 'string' && x && !/^(openid|email|profile)$/.test(x) && !/userinfo\./.test(x));
  function permission(scopes) {
    const real = realScopes(scopes);
    if (!real.length) return null;
    return { text: real.every((x) => /readonly/.test(x)) ? 'Read only' : 'Can make changes', detail: real.join('\n') };
  }
  // What this account was actually granted, so Reconnect starts from it instead of asking for more.
  // readonly:null = unknown (no scopes reported).
  function granted(scopes) {
    const real = realScopes(scopes);
    if (!real.length) return { readonly: null, gmail: '', drive: '' };
    const readonly = real.every((x) => /readonly/.test(x)), has = (re) => real.some((x) => re.test(x));
    let gmail = '', drive = '';
    if (!readonly) {
      const gFull = has(/mail\.google\.com\/?$|gmail\.modify|gmail\.compose|gmail\.insert/), gRead = has(/gmail\.readonly/), gSend = has(/gmail\.send/);
      gmail = gFull ? '' : gRead && gSend ? 'read-send' : gSend ? 'send' : gRead ? 'readonly' : '';
      drive = has(/\/auth\/drive$/) ? '' : has(/drive\.file/) ? 'file' : has(/drive\.readonly/) ? 'readonly' : '';
    }
    return { readonly, gmail, drive };
  }

  // ── accounts ──
  function accountsHead(s) {
    const sh = el('div', 'gw-sec-head'), actions = el('div', 'gw-actions');
    const check = button(busy === 'check' ? 'Checking…' : 'Check again', 'plg-btn', () => run('check'), 'check');
    check.disabled = !!busy || !s.available || !s.accounts.length;
    check.title = 'Asks Google again whether each sign-in still works. Reads no mail or files.';
    actions.append(check);
    if (s.setupSupported && s.available && s.accounts.length && !form && !authActive(s)) actions.append(button('Add account', 'plg-primary', () => openForm(s), 'connect-open'));
    sh.append(el('div', 'set-sec-h', 'Accounts'), actions); return sh;
  }
  function accountsSection(s, inlineAccount, connect) {
    const sec = el('div', 'set-section'); sec.append(accountsHead(s));
    const card = el('div', 'set-card'); card.dataset.app = 'google';
    for (const a of ordered(s)) {
      const id = String(a.email || '') + '|' + String(a.client || '');
      const item = el('div', 'gw-acct'), main = el('div', 'gw-acct-main'), email = el('div', 'gw-email');
      item.dataset.account = String(a.email || '');
      email.append(el('span', '', String(a.email || 'Unnamed account')));
      if (a !== inlineAccount && needsAccess(s, a)) {
        const setup = button('', 'gw-setup', () => goToAccess(a), 'setup-access-' + a.email);
        const ic = el('i', 'gw-setup-ic'), go = el('i', 'gw-setup-ic'); ic.innerHTML = SETUP_ICON; go.innerHTML = ARROW_ICON;
        setup.append(ic, el('span', '', 'Set up access to projects and agents'), go);
        setup.title = 'No agent can use this account yet. Choose which projects and agents can.';
        email.append(setup);
      }
      main.append(email);
      const off = !!busy || authActive(s);
      if (a === inlineAccount) {
        main.append(connect);
        item.append(main); card.append(item);
        continue;
      }
      // A failing account says so first, with its one next step, before any list of services.
      if (revoked(a)) {
        const fail = el('div', 'gw-fail'); fail.setAttribute('role', 'alert');
        fail.append(el('span', 'gw-fail-t', 'Google no longer accepts this sign-in. Reconnect to keep using this account.'));
        if (s.setupSupported) { const fix = button('Reconnect', 'plg-primary', () => openForm(s, a), 'reconnect-' + a.email); fix.disabled = off; fail.append(fix); }
        main.append(fail);
      } else if (failing(a)) {
        const fail = el('div', 'gw-fail gw-unsure'); fail.setAttribute('role', 'status');
        fail.append(el('span', 'gw-fail-t', 'CliDeck couldn’t check this connection with Google. The sign-in may still work.'));
        const again = button(busy === 'check' ? 'Checking…' : 'Check again', 'plg-btn', () => run('check'), 'recheck-' + a.email); fail.append(again);
        main.append(fail);
      }
      const services = Array.isArray(a.services) ? a.services.filter(Boolean).map(serviceName) : [];
      const line = el('div', 'gw-services'); line.append(el('span', '', services.length ? services.join(' · ') : 'No services allowed'));
      const perm = permission(a.scopes);
      if (perm) { const p = el('span', 'gw-perm', perm.text); p.title = perm.detail; line.append(el('span', 'gw-dash', ' — '), p); }
      main.append(line);
      if (s.setupSupported) {
        const acts = el('div', 'gw-acct-actions');
        if (!revoked(a)) { const again = button('Reconnect', 'gw-act', () => openForm(s, a), 'reconnect-' + a.email); again.disabled = off; acts.append(again); }
        const drop = button('Disconnect…', 'gw-act danger', () => { removing = id; connectNotice = null; render(); }, 'disconnect-' + a.email); drop.disabled = off;
        acts.append(drop); main.append(acts);
      }
      // Details only when there is something to know: the exact error, an unusual sign-in file or type.
      const usual = String(s.defaults.client || 'default').toLowerCase();
      const facts = [a.error ? String(a.error) : '', a.client && String(a.client).toLowerCase() !== usual ? 'Sign-in file: ' + a.client : '', a.auth && a.auth !== 'oauth' ? 'Sign-in type: ' + a.auth : ''];
      if (facts.some(Boolean)) main.append(technical('details-' + a.email, facts));
      const state = accountState(a); item.append(main); if (state) item.append(chip(state)); card.append(item);
      if (removing === id) card.append(disconnectConfirm(a));
    }
    sec.append(card);
    return sec;
  }
  function disconnectConfirm(a) {
    const box = el('div', 'gw-confirm'); box.setAttribute('role', 'alertdialog'); box.setAttribute('aria-label', 'Disconnect ' + a.email);
    box.append(el('div', 'set-row-t', 'Disconnect ' + a.email + '?'),
      el('div', 'set-row-s', 'This removes its saved sign-in from this computer. Agents and other tools here that use this sign-in lose access to the account until you connect it again. Your Google account itself isn’t changed.'));
    const more = el('div', 'set-row-s'); more.append(document.createTextNode('To also remove the app’s access at Google, open '), link('Google Account permissions', CONSOLE.permissions, 'permissions'), document.createTextNode('.'));
    const bar = el('div', 'gw-confirm-actions');
    bar.append(button('Cancel', 'plg-btn', () => { removing = ''; render(); }, 'disconnect-cancel'),
      button(busy === 'account-remove' ? 'Disconnecting…' : 'Disconnect', 'plg-remove', () => act('account-remove', { email: a.email, client: a.client || 'default' },
        (message) => { connectNotice = { ok: false, text: message }; }, () => { removing = ''; connectNotice = { ok: true, text: 'Disconnected ' + a.email + '.' }; }), 'disconnect-yes'));
    box.append(more, bar); return box;
  }

  // ── Connection requests: an agent asked to connect an account (google/setup connect-request) ──
  // Nothing starts until the person approves here. Approval runs the usual Google sign-in below; after it succeeds
  // the server allows only the asking agent in its project. Every state comes from the server's snapshot.
  const REQUEST_ACTIVE = new Set(['starting', 'waiting']);
  function requestSection(s) {
    if (!s.requests.length) return null;
    const sec = el('div', 'set-section gw-requests'); sec.append(el('div', 'set-sec-h', s.requests.length === 1 ? 'Connection request' : 'Connection requests'));
    for (const r of s.requests) sec.append(requestCard(s, r));
    return sec;
  }
  function requestCard(s, r) {
    const id = String(r.id), status = String(r.status || 'pending'), email = String(r.email || 'a Google account');
    const agent = String(r.sessionName || 'An agent'), project = r.projectId == null ? '' : String(r.projectName || 'its project');
    const where = project ? agent + ' in ' + project : agent;
    const card = el('div', 'set-card gw-request'); card.dataset.request = id; card.setAttribute('role', 'group'); card.setAttribute('aria-label', 'Connection request from ' + agent);
    const head = el('div', 'gw-request-head'), main = el('div', 'gw-request-main');
    main.append(el('div', 'set-row-t', status === 'connected' ? 'Connected ' + email : 'Connect ' + email),
      el('div', 'set-row-s', status === 'connected' ? where + ' can use it now.' : where + ' asks to use this account.'));
    const services = (Array.isArray(r.services) ? r.services : []).filter(Boolean).map((x) => String((s.services.find((y) => y.id === x) || {}).label || serviceName(x)));
    const what = el('div', 'gw-services'); what.append(el('span', '', services.length ? services.join(' · ') : 'No services named'), el('span', 'gw-dash', ' — '), el('span', 'gw-perm', r.readonly === false ? 'Read and change' : 'Read only'));
    main.append(what);
    head.append(main);
    const chipFor = { pending: ['loading', 'Waiting for you'], starting: ['loading', 'Signing in'], waiting: ['loading', 'Signing in'], connected: ['ready', 'Connected'], failed: ['failed', 'Didn’t finish'], cancelled: ['disabled', 'Stopped'] }[status];
    if (chipFor) head.append(chip(chipFor));
    card.append(head);
    if (status === 'pending') {
      card.append(el('div', 'set-hint', 'Only ' + agent + (project ? ' in ' + project : '') + ' will be allowed to use it. Change that any time under Agent access.'));
      const noClient = s.setupSupported && !hasClient(s, defaultClient(s));
      const reason = !s.setupSupported ? 'Update the Google Workspace plugin to connect accounts here.' : noClient ? (defaultClient(s) === 'clideck' ? 'Preparing CliDeck’s Google connection. Use Check connections to retry if needed.' : 'Add your custom Google connection under Advanced.')
        : authActive(s) ? 'Finish or cancel the sign-in in progress first.' : '';
      const bar = el('div', 'gw-go');
      if (reason) bar.append(el('span', 'gw-why', reason));
      bar.append(button(busy === 'connect-dismiss' ? 'Dismissing…' : 'Dismiss', 'plg-btn', () => decide('connect-dismiss', id), 'request-dismiss-' + id));
      const go = button(busy === 'connect-approve' ? 'Starting…' : 'Connect and allow this agent', 'plg-primary', () => decide('connect-approve', id), 'request-approve-' + id);
      go.disabled = !!busy || !!reason; bar.append(go); card.append(bar);
    } else if (REQUEST_ACTIVE.has(status)) {
      card.append(el('div', 'set-hint', 'Finish the Google sign-in below. ' + agent + ' gets access only after Google confirms.'));
    } else {
      if (status === 'failed') card.append(bad('Sign-in didn’t finish' + (r.message ? ': ' + String(r.message).replace(/[.\s]+$/, '') : '') + '. ' + agent + ' wasn’t given access.'));
      else if (status === 'cancelled') card.append(el('div', 'set-hint', r.message ? String(r.message) : 'The sign-in was stopped. ' + agent + ' wasn’t given access.'));
      const bar = el('div', 'gw-go'); bar.append(button(busy === 'connect-dismiss' ? 'Dismissing…' : 'Dismiss', 'plg-btn', () => decide('connect-dismiss', id), 'request-dismiss-' + id)); card.append(bar);
    }
    if (requestNotice && requestNotice.id === id) card.append(bad(requestNotice.text));
    return card;
  }
  function decide(action, id) {
    requestNotice = null;
    act(action, { id }, (message) => { requestNotice = { id, text: message }; });
  }

  // ── connect: sign-in file guide, sign-in form, Google's page ──
  const authActive = (s) => !!(s.authorization && ACTIVE.has(s.authorization.status));
  function newForm(s, account) {
    const known = new Set(s.services.map((x) => x.id));
    if (account) {
      // Reconnect starts from what Google actually granted this account; when that is unknown, from Read only.
      // It never asks for more on its own.
      const grant = granted(account.scopes), readonly = grant.readonly !== false;
      const saved = (Array.isArray(account.services) ? account.services : []).filter((x) => known.has(x));
      // Starting at Read only must not keep a service Google offers only with changes (Google Ads) selected but
      // unusable: leave it out and say so; Read and change lets the person tick it again.
      const writeOnly = (id) => (s.services.find((x) => x.id === id) || {}).supportsReadonly === false;
      const dropped = readonly ? saved.filter(writeOnly) : [];
      return { mode: 'reconnect', email: String(account.email || ''), client: String(account.client || defaultClient(s)),
        services: saved.filter((id) => !dropped.includes(id)), dropped,
        readonly, grantKnown: grant.readonly !== null, gmailScope: grant.gmail, driveScope: grant.drive };
    }
    // A new sign-in: the everyday services, read and change. Never everything, never Google Ads.
    const core = CORE.filter((id) => known.has(id));
    return { mode: 'add', email: '', client: defaultClient(s), services: core.length ? core : s.services.filter((x) => x.supportsReadonly !== false).slice(0, 1).map((x) => x.id),
      dropped: [], readonly: false, grantKnown: false, gmailScope: '', driveScope: '' };
  }
  function openForm(s, account) {
    form = newForm(s, account); removing = ''; connectNotice = null;
    if (account && revoked(account) && form.grantKnown && form.services.length && !form.dropped.length
      && form.services.length === account.services.length && hasClient(s, form.client)) startSignIn();
    else render();
    document.getElementById('google-connect-heading')?.focus();
  }
  const listed = (names) => (names.length < 2 ? names.join('') : names.slice(0, -1).join(', ') + ' and ' + names[names.length - 1]);
  // One plain sentence: what agents will be able to do, with any narrower Gmail/Drive choice in brackets.
  function summary(s) {
    if (!form.services.length) return '';
    const names = form.services.map((id) => {
      const svc = s.services.find((x) => x.id === id), name = svc ? String(svc.label || serviceName(id)) : serviceName(id);
      const narrower = form.readonly ? '' : id === 'gmail' && form.gmailScope ? GMAIL[form.gmailScope] : id === 'drive' && form.driveScope ? DRIVE[form.driveScope] : '';
      return narrower ? name + ' (' + narrower + ')' : name;
    });
    return form.readonly ? 'Agents can read ' + listed(names) + '. They can’t send, change or delete anything.'
      : 'Agents can read and make changes in ' + listed(names) + ', including sending and deleting.';
  }
  function connectSection(s) {
    const sec = el('div', 'set-section gw-connect');
    // A sign-in started from a connection request reports its outcome on that request's card instead.
    const a = s.authorization, fromRequest = !!a && s.requests.some((r) => r.authorizationId && r.authorizationId === a.id);
    const showResult = !!a && !ACTIVE.has(a.status) && a.id !== dismissedAuth && a.id === watchedAuth && !fromRequest;
    if (!s.setupSupported) {
      if (!s.accounts.length) { sec.append(el('div', 'set-sec-h', 'Connect your Google account'), el('div', 'set-hint', 'Update the Google Workspace plugin to connect accounts from here.')); return sec; }
      return null;
    }
    const firstTime = !s.accounts.length;
    if (!form && firstTime && !authActive(s)) form = newForm(s);
    // The configured client governs new sign-ins, even if it changed while this form was open.
    if (form && form.mode === 'add' && s.defaults.client && form.client !== defaultClient(s)) form.client = defaultClient(s);
    if (!form && !authActive(s) && !showResult && !connectNotice && !s.setupError) return null;
    const heading = el('div', 'set-sec-h', authActive(s) ? 'Sign in with Google' : form && form.mode === 'reconnect' ? 'Reconnect ' + form.email : firstTime ? 'Connect your Google account' : 'Add a Google account');
    heading.id = 'google-connect-heading'; heading.tabIndex = -1; sec.append(heading);
    if (form && busy === 'auth-start' && !authActive(s)) {
      const status = el('div', 'gw-wait', 'Preparing Google sign-in for ' + form.email + '…');
      status.setAttribute('role', 'status'); sec.append(status);
    }
    if (s.setupError) sec.append(bad(s.setupError));
    if (connectNotice) sec.append(connectNotice.ok ? good(connectNotice.text) : bad(connectNotice.text));
    if (showResult) sec.append(resultCard(a));
    if (authActive(s)) { sec.append(authCard(s, a)); return sec; }
    if (form && busy !== 'auth-start') sec.append(formCard(s));
    return sec;
  }
  function resultCard(a) {
    // A new account starts with no agent access; say where to allow it (a reconnected one keeps its access).
    const unassigned = a.status === 'connected' && snapshot.accessByAccount && !snapshot.access.accounts.some((r) => same(r.email, a.email));
    const box = a.status === 'connected' ? good('Connected ' + (a.email || 'your account') + '.' + (unassigned ? ' Choose which agents can use it under Agent access.' : ''))
      : a.status === 'cancelled' ? el('div', 'gw-next', a.message || 'Sign-in cancelled.') : bad('Sign-in didn’t finish' + (a.message ? ': ' + a.message : '.'));
    box.classList.add('gw-result');
    const bar = el('span', 'gw-result-actions');
    bar.append(button('Dismiss', 'gw-link', () => { dismissedAuth = a.id; if (a.id === startedAuth) startedAuth = ''; render(); }, 'auth-dismiss'));
    box.append(bar); return box;
  }
  function authCard(s, a) {
    const card = el('div', 'set-card gw-auth'); card.setAttribute('role', 'status');
    const who = a.email || (form && form.email) || 'your account';
    if (a.status === 'starting') {
      const line = el('div', 'gw-wait'); line.append(el('i', 'plg-spinner'), el('span', '', 'Getting Google sign-in ready for ' + who + '…'));
      card.append(line);
    } else {
      card.append(el('div', 'set-row-t', 'Approve access for ' + who),
        el('div', 'set-row-s', a.message || 'Open Google’s sign-in page, choose ' + who + ' and allow access. This page updates by itself when Google confirms.'));
      if (form && a.id === startedAuth) card.append(el('div', 'gw-summary', summary(s)));
      const bar = el('div', 'gw-auth-actions');
      const open = button('Open Google sign-in', 'plg-primary', () => openLink(a.url), 'auth-open');
      const ends = typeof a.expiresAt === 'number' ? a.expiresAt : Date.parse(String(a.expiresAt || ''));   // ISO string or ms
      const left = isFinite(ends) ? Math.ceil((ends - Date.now()) / 60000) : null;
      const field = el('input', 'set-input mono');
      field.readOnly = true; field.value = a.url || ''; field.dataset.control = 'auth-copy-url';
      field.setAttribute('aria-label', 'Google sign-in link to copy');
      field.hidden = !a.url || manualCopyUrl !== a.url || (left !== null && left <= 0);
      const copy = button('Copy link', 'plg-btn', async () => {
        try {
          await navigator.clipboard.writeText(a.url);
        } catch {
          if (!bar.isConnected) return;
          field.hidden = false; field.focus(); field.select();
          // Sandboxed plugin pages may only support selection-based copying.
          let copied = false;
          try { copied = document.execCommand('copy'); } catch {}
          if (!copied) {
            manualCopyUrl = a.url;
            post({ type: 'clideck.toast', kind: 'info', title: 'Google Workspace', body: 'The sign-in link is selected. Use Copy to copy it.' });
            return;
          }
          copy.focus();
        }
        if (!bar.isConnected) return;
        manualCopyUrl = ''; field.hidden = true;
        copy.textContent = 'Copied';
      }, 'auth-copy');
      open.disabled = copy.disabled = !/^https:\/\//i.test(String(a.url || '')) || (left !== null && left <= 0);
      bar.append(open, copy);
      if (left != null) bar.append(el('span', 'gw-expiry', left > 0 ? 'Link expires in ' + left + ' min' : 'This link has expired. Cancel and start again.'));
      card.append(bar, field);
      // The browser may not be on the computer running CliDeck: then Google's last page can't load.
      const help = fold('fold-paste', 'Google’s last page didn’t load?');
      help.append(el('div', 'set-row-s', 'That happens when this browser isn’t on the computer running CliDeck. After you allow access, copy the address of the page that didn’t load from the address bar and paste it here.'));
      const pasteRow = el('div', 'gw-paste'), input = el('input', 'set-input mono');
      input.type = 'url'; input.placeholder = 'http://127.0.0.1:…/?code=…'; input.value = pastedUrl; input.spellcheck = false; input.autocomplete = 'off';
      input.setAttribute('aria-label', 'Address of the page that didn’t load'); input.dataset.control = 'auth-url';
      const finish = button(busy === 'auth-complete' ? 'Finishing…' : 'Finish sign-in', 'plg-btn', () => {
        act('auth-complete', { id: a.id, url: pastedUrl.trim() }, (message) => { connectNotice = { ok: false, text: message }; }, () => { pastedUrl = ''; });
      }, 'auth-complete');
      finish.disabled = !!busy || !/^https?:\/\//i.test(pastedUrl.trim());
      input.addEventListener('input', () => { pastedUrl = input.value; finish.disabled = !!busy || !/^https?:\/\//i.test(pastedUrl.trim()); });
      pasteRow.append(input, finish); help.append(pasteRow); card.append(help, blockedHelp('Cancel this sign-in below, then sign in again.'), passkeyHelp());
    }
    const cancel = button(busy === 'auth-cancel' ? 'Cancelling…' : 'Cancel sign-in', 'gw-link gw-cancel', () => act('auth-cancel', { id: a.id }, (message) => { connectNotice = { ok: false, text: message }; }), 'auth-cancel');
    card.append(cancel); return card;
  }
  function startSignIn() {
    const s = snapshot;
    const readonlyOk = (id) => !form.readonly || (s.services.find((x) => x.id === id) || {}).supportsReadonly !== false;
    const fields = { email: form.email.trim(), client: form.client || defaultClient(s), services: form.services.filter(readonlyOk), readonly: form.readonly === true };
    if (!form.readonly) { if (form.gmailScope && form.services.includes('gmail')) fields.gmailScope = form.gmailScope; if (form.driveScope && form.services.includes('drive')) fields.driveScope = form.driveScope; }
    connectNotice = null;
    act('auth-start', fields, (message) => { connectNotice = { ok: false, text: message }; }, (result) => {
      const a = result && result.setup && result.setup.authorization; if (a && a.id) startedAuth = watchedAuth = a.id;
    });
  }
  function formCard(s) {
    const card = el('div', 'set-card gw-form');
    // Some services (Google Ads) have no read-only access at Google. Say so; never switch the level for the person.
    const writeOnly = form.services.map((id) => s.services.find((x) => x.id === id)).filter((x) => x && x.supportsReadonly === false).map((x) => String(x.label || serviceName(x.id)));
    // Access level first: it decides which services can be ticked.
    const level = el('div', 'gw-level'), seg = el('div', 'tasks-seg'); seg.setAttribute('role', 'group'); seg.setAttribute('aria-label', 'Access level');
    for (const [value, label] of [[false, 'Read and change'], [true, 'Read only']]) {
      const b = button(label, 'tasks-seg-b', () => { form.readonly = value; render(); }, 'level-' + (value ? 'read' : 'write'));
      b.setAttribute('aria-pressed', String(form.readonly === value));
      // Read only can't be combined with a service Google offers only with changes (Google Ads): say why upfront.
      if (value && writeOnly.length) { b.disabled = true; b.title = writeOnly.join(', ') + ' can’t be read only. Untick it to choose Read only.'; }
      seg.append(b);
    }
    const grantNote = form.mode !== 'reconnect' ? '' : form.grantKnown ? ' Kept from this account’s current access.'
      : form.readonly ? ' CliDeck can’t tell this account’s current access, so Read only is chosen. Choose Read and change if agents should send or change things.' : '';
    const lbl = el('div', 'set-row-lbl'); lbl.append(el('div', 'set-row-t', 'Access'),
      el('div', 'set-row-s', (form.readonly ? 'Agents can read, but not send, change or delete anything.' : 'Agents can read, send, change and delete.') + grantNote));
    level.append(lbl, seg); card.append(level);
    if (writeOnly.length) card.append(el('div', 'set-hint gw-readonly-note', writeOnly.join(', ') + ' works only with Read and change. Untick ' + (writeOnly.length === 1 ? 'it' : 'them') + ' to choose Read only.'));
    const left = (form.dropped || []).filter((id) => !form.services.includes(id)).map((id) => String((s.services.find((x) => x.id === id) || {}).label || serviceName(id)));
    if (left.length) card.append(el('div', 'set-hint gw-readonly-note gw-dropped', listed(left) + ' ' + (left.length === 1 ? 'was' : 'were') + ' left out because ' + (left.length === 1 ? 'it needs' : 'they need')
      + ' Read and change. To include ' + (left.length === 1 ? 'it' : 'them') + ', choose Read and change and tick ' + (left.length === 1 ? 'it' : 'them') + ' again.'));
    // Services: the everyday ones in view, everything else under More services (open when one of them is chosen).
    card.append(el('div', 'set-row-t', 'Services'));
    const service = (svc) => {
      const blocked = form.readonly && svc.supportsReadonly === false;
      const item = el('label', 'gw-agent' + (blocked ? ' off' : '')), box = el('input'); box.type = 'checkbox';
      box.checked = form.services.includes(svc.id) && !blocked; box.dataset.control = 'service-' + svc.id; box.disabled = !!busy || blocked;
      box.addEventListener('change', () => { form.services = s.services.map((x) => x.id).filter((id) => id === svc.id ? box.checked : form.services.includes(id)); render(); });
      item.append(box, el('span', 'gw-agent-name', String(svc.label || serviceName(svc.id))));
      if (blocked) { item.title = 'Needs Read and change'; item.append(el('span', 'gw-agent-meta', 'Needs Read and change')); }
      return item;
    };
    const main = s.services.filter((x) => VISIBLE.includes(x.id)).sort((a, b) => VISIBLE.indexOf(a.id) - VISIBLE.indexOf(b.id));
    const rest = s.services.filter((x) => !VISIBLE.includes(x.id));
    const grid = el('div', 'gw-agents gw-services-pick'); main.forEach((x) => grid.append(service(x))); card.append(grid);
    if (rest.length) {
      const chosen = rest.filter((x) => form.services.includes(x.id)).length;
      if (chosen) folds.add('fold-more-services');
      const more = fold('fold-more-services', chosen ? 'More services (' + chosen + ' chosen)' : 'More services');
      const extra = el('div', 'gw-agents gw-services-pick gw-more'); rest.forEach((x) => extra.append(service(x))); more.append(extra); card.append(more);
    }
    if (form.readonly === false) {
      const more = fold('fold-scopes', 'Fine-tune access');
      const pick = (label, map, key, control) => {
        const sel = el('select', 'set-select gw-select'); sel.setAttribute('aria-label', label); sel.dataset.control = control;
        for (const [v, t] of [['', 'Read and change']].concat(Object.entries(map).map(([k, t]) => [k, t.charAt(0).toUpperCase() + t.slice(1)]))) { const o = el('option', '', t); o.value = v; sel.append(o); }
        sel.value = form[key]; sel.addEventListener('change', () => { form[key] = sel.value; render(); });
        const r = el('div', 'set-row'), l = el('div', 'set-row-lbl'); l.append(el('div', 'set-row-t', label)); r.append(l, sel); return r;
      };
      if (form.services.includes('gmail')) more.append(pick('Gmail', { full: GMAIL.full, send: GMAIL.send, 'read-send': GMAIL['read-send'], readonly: GMAIL.readonly }, 'gmailScope', 'gmail-scope'));
      if (form.services.includes('drive')) more.append(pick('Drive', { full: DRIVE.full, file: DRIVE.file, readonly: DRIVE.readonly }, 'driveScope', 'drive-scope'));
      if (form.services.includes('gmail') || form.services.includes('drive')) card.append(more);
    }
    // One-time Google sign-in file, only while the one this form uses isn't saved; afterwards only sign-in help remains.
    if (!hasClient(s, form.client)) card.append(el('div', 'set-hint', form.client === 'clideck' ? 'Preparing CliDeck’s Google connection. Use Check connections to retry if needed.' : 'Add your custom Google connection under Advanced.')); else card.append(blockedHelp('Then sign in again.'));
    // Account + go
    const who = el('div', 'gw-who'), email = el('input', 'set-input');
    email.type = 'email'; email.placeholder = 'you@gmail.com'; email.value = form.email; email.autocomplete = 'email'; email.spellcheck = false;
    email.setAttribute('aria-label', 'Google account email'); email.dataset.control = 'auth-email'; email.readOnly = form.mode === 'reconnect';
    const wl = el('div', 'set-row-lbl'); wl.append(el('div', 'set-row-t', 'Google account'));
    who.append(wl, email); card.append(who);
    // Choosing a sign-in file is only offered when no client is configured for this view.
    if (clientsOf(s).length > 1 && !s.defaults.client) {
      const sel = el('select', 'set-select gw-select'); sel.setAttribute('aria-label', 'Sign-in file'); sel.dataset.control = 'auth-client';
      for (const name of clientsOf(s)) { const o = el('option', '', name); o.value = name; sel.append(o); }
      sel.value = form.client; sel.disabled = form.mode === 'reconnect'; sel.addEventListener('change', () => { form.client = sel.value; });
      const r = el('div', 'set-row gw-client-row'), l = el('div', 'set-row-lbl'); l.append(el('div', 'set-row-t', 'Sign-in file'), el('div', 'set-row-s', 'Which Google Cloud client to sign in with.')); r.append(l, sel);
      const adv = fold('fold-client', 'More options'); adv.append(r); card.append(adv);
    }
    const why = () => (!hasClient(s, form.client) ? (form.client === 'clideck' ? 'CliDeck’s Google connection is not ready. Check connections to retry.' : 'Add your custom Google connection under Advanced.') : !form.services.length ? 'Choose at least one service.'
      : !/^[^\s@]+@[^\s@]+$/.test(form.email.trim()) ? 'Enter the Google account’s email.' : '');
    const go = el('div', 'gw-go'), reason = el('span', 'gw-why', why());
    const start = button(busy === 'auth-start' ? 'Starting…' : 'Sign in with Google', 'plg-primary', startSignIn, 'auth-start');
    start.disabled = !!busy || !!why();
    email.addEventListener('input', () => { form.email = email.value; reason.textContent = why(); start.disabled = !!busy || !!why(); });
    if (form.services.length) card.append(el('div', 'gw-summary', summary(s)));
    go.append(reason);
    if (s.accounts.length) go.append(button('Cancel', 'plg-btn', () => { form = null; connectNotice = null; render(); }, 'connect-cancel'));
    go.append(start); card.append(go);
    return card;
  }
  // Google's "Access blocked … app is being tested" page means the email isn't a test user yet. Only that case is
  // covered here; other blocks say their own reason on Google's page.
  function blockedHelp(retry) {
    const help = fold('fold-blocked', 'Google blocked the sign-in?');
    help.append(el('div', 'set-row-s', 'Google may say this app hasn’t been verified yet. That can appear until Google finishes reviewing it.'),
      el('div', 'set-row-s', 'If Google says the app is being tested and only approved testers can use it, add this email as a test user:'));
    const steps = el('ol', 'gw-mini-steps');
    for (const t of ['Open the same Google Cloud project as the sign-in file you added.', 'Google Auth Platform → Audience → Test users → Add users.', 'Enter the exact email you’re signing in with, then Save.', retry])
      steps.append(el('li', '', t));
    const l = el('div', 'gw-step-links'); l.append(link('Open Audience', CONSOLE.audience, 'blocked-audience'));
    help.append(steps, l); return help;
  }
  // Google decides how you prove it's you. CliDeck can point to Google's own help; it can't skip or speed up a step.
  function passkeyHelp() {
    const help = fold('fold-passkey', 'Trouble with your passkey or 2-Step Verification?');
    help.append(el('div', 'set-row-s', 'On Google’s page, choose Try another way to use a different sign-in method.'),
      el('div', 'set-row-s', 'If Google asks you to wait while it confirms it’s you, only Google decides how long that takes.'));
    const l = el('div', 'gw-step-links'); l.append(link('2-Step Verification help', CONSOLE.twoStep, 'help-2sv'), link('Why recovery can take time', CONSOLE.recovery, 'help-recovery'));
    help.append(l); return help;
  }
  // The one-time Google Cloud steps, inline. Links go straight to Google's console pages.
  function guide(s) {
    const box = el('div', 'gw-guide');
    box.append(el('div', 'set-row-t', 'One-time setup: a Google sign-in file'),
      el('div', 'set-row-s', 'Set this up once. Google asks each app to use its own sign-in file from a Google Cloud project.'));
    const steps = el('ol', 'gw-steps');
    const step = (title, text, ...links) => { const li = el('li', 'gw-step'), t = el('div', 'gw-step-t', title); li.append(t); if (text) li.append(el('div', 'gw-step-s', text)); if (links.length) { const l = el('div', 'gw-step-links'); l.append(...links); li.append(l); } steps.append(li); return li; };
    step('Create a Google Cloud project', 'Any name works.', link('Create project', CONSOLE.project, 'guide-project'));
    const apis = [].concat(...form.services.map((id) => (s.services.find((x) => x.id === id) || {}).apis || [])).filter(Boolean);
    const names = form.services.map((id) => String((s.services.find((x) => x.id === id) || {}).label || serviceName(id)));
    const apiLink = link('Turn on the APIs', apis.length ? CONSOLE.apis(apis) : CONSOLE.project, 'guide-apis'); apiLink.disabled = !apis.length;
    step('Turn on the APIs', names.length ? 'For ' + names.join(', ') + '. Choose the project you just made if Google asks.' : 'Choose the services above first.', apiLink);
    step('Set up Google sign-in for the project', 'In Google Auth Platform press Get started, give the app a name and your email, and choose External.',
      link('Open Google Auth Platform', CONSOLE.auth, 'guide-auth'));
    step('Add yourself as a test user', 'While the app is in Testing, Google lets only its test users sign in. In the same project: Google Auth Platform → Audience → Test users → Add users, enter the exact email you’ll sign in with, then Save.',
      link('Open Audience', CONSOLE.audience, 'guide-audience'));
    step('Create an OAuth client', 'Create OAuth client → Application type: Desktop app → Create.', link('Create OAuth client', CONSOLE.client, 'guide-client'));
    const last = step('Download its JSON file and add it here', 'Google offers Download JSON right after creating the OAuth client.');
    last.append(uploadBox(form.client || 'default', false, 'credentials-file'));
    box.append(steps, el('div', 'set-hint', 'Your sign-in file stays on the computer running CliDeck.'));
    return box;
  }
  // Reads the chosen file in the page, checks it is a Desktop app client, and hands the text to the server.
  function uploadBox(client, replace, control, disabled) {
    const zone = el('div', 'gw-drop' + (disabled ? ' off' : '')), input = el('input'); input.type = 'file'; input.accept = '.json,application/json'; input.className = 'gw-file';
    input.dataset.control = control; input.setAttribute('aria-label', 'Google sign-in file (JSON)'); input.disabled = !!disabled;
    const choose = button(busy === 'credentials-save' && upload.control === control ? 'Saving…' : 'Choose JSON file', 'plg-btn', () => input.click(), control + '-choose');
    choose.disabled = !!busy || !!disabled;
    zone.append(choose, el('span', 'gw-drop-t', 'or drop it here'));
    const fail = (text) => { upload = { control, text }; render(); };
    const take = (file) => {
      upload = { control, text: '' };
      if (!file || disabled || busy) return;
      if (file.size > MAX_FILE) { fail('That file is too large to be a Google sign-in file.'); return; }
      Promise.resolve(file.text()).then((text) => {
        let parsed = null; try { parsed = JSON.parse(text); } catch (e) { /* reported below */ }
        if (!parsed || typeof parsed !== 'object') { fail('That isn’t a JSON file from Google. Download the client’s JSON again and choose it here.'); return; }
        if (!parsed.installed) { fail(parsed.web ? 'This file is for a Web application. In Google Cloud, create a Desktop app client and use its JSON instead.' : 'That isn’t a Google sign-in file. Use the JSON downloaded for a Desktop app client.'); return; }
        // The file text goes to the server once and is not kept here.
        act('credentials-save', { json: text, client, replace }, (message) => { upload = { control, text: message }; },
          () => { (control === 'credentials-file' ? (connectNotice = { ok: true, text: 'Google sign-in file saved. Now sign in below.' }) : (clientNotice = { ok: true, text: 'Sign-in file “' + client + '” saved.' })); replaceClient = false; });
      }, () => fail('CliDeck couldn’t read that file.'));
    };
    input.addEventListener('change', () => { const file = input.files && input.files[0]; input.value = ''; take(file); });
    zone.addEventListener('dragover', (e) => { e.preventDefault(); zone.classList.add('over'); });
    zone.addEventListener('dragleave', () => zone.classList.remove('over'));
    zone.addEventListener('drop', (e) => { e.preventDefault(); zone.classList.remove('over'); take(e.dataTransfer && e.dataTransfer.files && e.dataTransfer.files[0]); });
    const wrap = el('div', 'gw-upload'); wrap.append(zone, input);
    if (upload.control === control && upload.text) wrap.append(bad(upload.text));
    return wrap;
  }

  // ── Agent access ──
  // v2: each account has its own projects/agents ({email, client, mode, projects}); an account without a row can't
  // be used by any agent (new accounts start that way). defaults pick the account for a project that can use more
  // than one. One canonical shape for comparing and saving: known projects only (once each, in option order),
  // chosen agents only if they still belong to that project, accounts in a stable order, rows that equal "no
  // access" dropped, defaults only for a known project and an account allowed there.
  const key = (id) => (id == null ? 'none' : 'p-' + id);
  const who = (email, client) => String(email || '').toLowerCase() + '|' + String(client || 'default').toLowerCase();
  const accountKey = (a) => who(a.email, a.client);
  function normalizeProjects(list, options) {
    const wanted = new Map();
    for (const p of (Array.isArray(list) ? list : [])) if (p && typeof p === 'object' && !wanted.has(key(p.projectId))) wanted.set(key(p.projectId), p);
    const projects = [];
    for (const o of options) {
      const p = wanted.get(key(o.id)); if (!p) continue;
      const chosen = new Set(Array.isArray(p.sessionIds) ? p.sessionIds : []);
      const sessions = Array.isArray(o.sessions) ? o.sessions : [];
      const agents = p.agents === 'selected' ? 'selected' : 'all';
      projects.push({ projectId: o.id == null ? null : o.id, agents, sessionIds: agents === 'all' ? [] : sessions.filter((x) => chosen.has(x.id)).map((x) => x.id) });
    }
    return projects;
  }
  // Same rule as the server: a project counts only if some agent there may use the account.
  const allows = (row, projectId) => !!row && (row.mode === 'all' || row.projects.some((p) => key(p.projectId) === key(projectId) && (p.agents === 'all' || p.sessionIds.length > 0)));
  function normalize(access, options) {
    const rows = new Map();
    for (const r of (access && Array.isArray(access.accounts) ? access.accounts : [])) {
      if (!r || typeof r !== 'object' || !r.email || rows.has(who(r.email, r.client))) continue;
      const mode = r.mode === 'all' ? 'all' : 'selected', projects = mode === 'all' ? [] : normalizeProjects(r.projects, options);
      if (mode === 'all' || projects.length) rows.set(who(r.email, r.client), { email: String(r.email).toLowerCase(), client: String(r.client || 'default').toLowerCase(), mode, projects });
    }
    const accounts = [...rows.keys()].sort().map((k) => rows.get(k));
    const chosen = new Map();
    for (const d of (access && Array.isArray(access.defaults) ? access.defaults : [])) {
      if (d && typeof d === 'object' && !chosen.has(key(d.projectId)) && allows(rows.get(who(d.email, d.client)), d.projectId)) chosen.set(key(d.projectId), d);
    }
    const defaults = options.filter((o) => chosen.has(key(o.id))).map((o) => { const d = chosen.get(key(o.id)), r = rows.get(who(d.email, d.client)); return { projectId: o.id == null ? null : o.id, email: r.email, client: r.client }; });
    return { version: 2, accounts, defaults };
  }
  function edit(change) {
    if (!draft) { draft = JSON.parse(JSON.stringify(snapshot.access)); draftBase = JSON.stringify(snapshot.access); }
    change(draft); draft = normalize(draft, snapshot.accessOptions); accessNotice = null; render();
  }
  // Edits one account's row, creating it (as "no access") first when the account has none yet.
  function editAccount(a, change) {
    edit((d) => {
      let r = d.accounts.find((x) => accountKey(x) === accountKey(a));
      if (!r) { r = { email: String(a.email).toLowerCase(), client: String(a.client || 'default').toLowerCase(), mode: 'selected', projects: [] }; d.accounts.push(r); }
      change(r);
    });
  }
  function select(label, options, value, onChange, control) {
    const sel = el('select', 'set-select gw-select'); sel.setAttribute('aria-label', label); sel.dataset.control = control;
    for (const [v, text] of options) { const o = el('option', '', text); o.value = v; sel.append(o); }
    sel.value = value; sel.disabled = busy === 'access-save';
    sel.addEventListener('change', () => onChange(sel.value)); return sel;
  }
  // An account's name on this page: its email, plus the sign-in file only when two accounts share that email.
  const accountName = (s, a) => String(a.email || 'Unnamed account') + (s.accounts.filter((x) => same(x.email, a.email)).length > 1 ? ' · ' + String(a.client || 'default') : '');
  const rowOf = (access, a) => access.accounts.find((r) => accountKey(r) === accountKey(a)) || null;
  // A connected account no agent may use yet — almost always one just added. Judged on what is SAVED, so the
  // prompt stays until access is really in place, not while a draft is half made.
  const needsAccess = (s, a) => s.accessSupported && s.accessByAccount && !revoked(a) && !rowOf(s.access, a);
  // The account you just connected first, then any others still waiting for access, then the rest as Google
  // lists them — the same order in Accounts and Agent access, so the new one is where you look.
  function ordered(s) {
    const auth = s.authorization, fresh = auth && auth.status === 'connected' ? auth.email : '';
    const rank = (a) => (fresh && same(a.email, fresh) && needsAccess(s, a) ? 0 : needsAccess(s, a) ? 1 : 2);
    return s.accounts.map((a, i) => [a, i]).sort((x, y) => rank(x[0]) - rank(y[0]) || x[1] - y[1]).map((x) => x[0]);
  }
  // From the account row to its access controls: glide there, focus the first choice, and flash the block once.
  function goToAccess(a) {
    const block = root.querySelector('[data-access="' + CSS.escape(accountKey(a)) + '"]');
    if (!block) return;
    const reduce = window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    block.scrollIntoView({ behavior: reduce ? 'auto' : 'smooth', block: 'center' });
    const first = block.querySelector('select'); if (first) first.focus({ preventScroll: true });
    block.classList.remove('gw-flash'); void block.offsetWidth; block.classList.add('gw-flash');
    block.addEventListener('animationend', () => block.classList.remove('gw-flash'), { once: true });
  }
  function accountAccess(s, a, access, nameOf) {
    const id = accountKey(a), row = rowOf(access, a) || { mode: 'selected', projects: [] }, name = accountName(s, a);
    const block = el('div', 'gw-acct-access'); block.dataset.access = id;
    const top = el('div', 'set-row'), lbl = el('div', 'set-row-lbl');
    lbl.append(el('div', 'set-row-t gw-access-email', name),
      el('div', 'set-row-s', row.mode === 'all' ? 'Every agent, in every project, now and later.' : row.projects.length ? 'Only the projects and agents chosen below.' : 'No agent can use this account yet.'));
    top.append(lbl, select('Projects that can use ' + name, [['all', 'All projects'], ['selected', 'Selected projects']], row.mode, (v) => editAccount(a, (r) => { r.mode = v; }), 'access-mode-' + id));
    block.append(top);
    if (row.mode === 'all') return block;
    const projects = el('div', 'gw-projects');
    for (const p of row.projects) {
      const k = key(p.projectId), option = s.accessOptions.find((o) => key(o.id) === k) || { sessions: [] };
      const sessions = Array.isArray(option.sessions) ? option.sessions : [];
      const card = el('div', 'gw-project'), head = el('div', 'gw-project-head');
      const target = (r) => r.projects.find((x) => key(x.projectId) === k);
      head.append(el('div', 'gw-project-name', nameOf.get(k)),
        select('Agents in ' + nameOf.get(k), [['all', 'All agents'], ['selected', 'Selected agents']], p.agents, (v) => editAccount(a, (r) => { target(r).agents = v; }), 'agents-' + id + '-' + k));
      const remove = button('', 'gw-remove', () => editAccount(a, (r) => { r.projects = r.projects.filter((x) => key(x.projectId) !== k); }), 'remove-' + id + '-' + k);
      remove.innerHTML = '<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" aria-hidden="true"><path d="m6 6 12 12M18 6 6 18"/></svg>';
      remove.setAttribute('aria-label', 'Remove ' + nameOf.get(k)); remove.title = 'Remove'; remove.disabled = busy === 'access-save';
      head.append(remove); card.append(head);
      if (p.agents === 'selected') {
        const agents = el('div', 'gw-agents');
        if (!sessions.length) agents.append(el('div', 'set-hint', 'No agents in this project yet.'));
        for (const x of sessions) {
          const item = el('label', 'gw-agent'), box = el('input'); box.type = 'checkbox';
          box.checked = p.sessionIds.includes(x.id); box.disabled = busy === 'access-save'; box.dataset.control = 'agent-' + id + '-' + x.id;
          box.addEventListener('change', () => editAccount(a, (r) => {
            const t = target(r); t.sessionIds = box.checked ? t.sessionIds.concat(x.id) : t.sessionIds.filter((sid) => sid !== x.id);
          }));
          const meta = [x.provider, x.live === false ? 'stopped' : ''].filter(Boolean).join(' · ');
          item.append(box, el('span', 'gw-agent-name', String(x.name || 'Agent')));
          if (meta) item.append(el('span', 'gw-agent-meta', meta));
          agents.append(item);
        }
        if (sessions.length && !p.sessionIds.length) agents.append(el('div', 'set-hint warn gw-none', 'No agent chosen: nobody in this project can use this account.'));
        card.append(agents);
      }
      projects.append(card);
    }
    block.append(projects);
    const rest = s.accessOptions.filter((o) => !row.projects.some((p) => key(p.projectId) === key(o.id)));
    if (rest.length) {
      const add = select('Add a project for ' + name, [['', 'Add a project…']].concat(rest.map((o) => [key(o.id), nameOf.get(key(o.id))])), '', (v) => {
        const o = rest.find((x) => key(x.id) === v); if (o) editAccount(a, (r) => { r.projects.push({ projectId: o.id == null ? null : o.id, agents: 'all', sessionIds: [] }); });
      }, 'access-add-' + id);
      add.classList.add('gw-add'); block.append(add);
    }
    return block;
  }
  // A project that more than one connected account may serve picks which one agents get when they don't name one.
  function defaultsCard(s, access, nameOf) {
    const rows = [];
    for (const o of s.accessOptions) {
      const allowed = s.accounts.filter((a) => allows(rowOf(access, a), o.id));
      if (allowed.length < 2) continue;
      const k = key(o.id), current = access.defaults.find((d) => key(d.projectId) === k);
      const r = el('div', 'set-row'), l = el('div', 'set-row-lbl'); l.append(el('div', 'set-row-t', nameOf.get(k)));
      r.append(l, select('Default account for ' + nameOf.get(k), [['', 'No default']].concat(allowed.map((a) => [accountKey(a), accountName(s, a)])), current ? who(current.email, current.client) : '', (v) => edit((d) => {
        d.defaults = d.defaults.filter((x) => key(x.projectId) !== k);
        const a = allowed.find((x) => accountKey(x) === v); if (a) d.defaults.push({ projectId: o.id == null ? null : o.id, email: String(a.email).toLowerCase(), client: String(a.client || 'default').toLowerCase() });
      }), 'default-' + k));
      rows.push(r);
    }
    if (!rows.length) return null;
    const card = el('div', 'set-card gw-defaults');
    card.append(el('div', 'set-row-t', 'Default account'), el('div', 'set-row-s gw-defaults-s', 'For projects that can use more than one account. Agents use the default unless they name another account; with No default, they must name one.'), ...rows);
    return card;
  }
  function accessSection(s) {
    const sec = el('div', 'set-section gw-access'); sec.append(el('div', 'set-sec-h', 'Agent access'));
    if (!s.accessSupported) {
      sec.append(el('div', 'set-hint', 'Update the Google Workspace plugin to choose which agents can use each account.'));
      return sec;
    }
    if (!s.accessByAccount) {
      if (s.accessError) sec.append(bad(s.accessError));
      sec.append(el('div', 'set-hint', 'Access per account appears once CliDeck has read your Google accounts. Until then, the earlier choice still applies.'));
      return sec;
    }
    const access = draft || s.access, dirty = !!draft && JSON.stringify(draft) !== JSON.stringify(s.access);
    const nameOf = new Map(s.accessOptions.map((o) => [key(o.id), String(o.name || (o.id == null ? 'No project' : 'Project'))]));
    if (s.accessError) sec.append(bad(s.accessError));
    if (!s.accounts.length) {
      sec.append(el('div', 'set-hint', 'Once an account is connected, choose here which projects and agents can use it.'));
      return sec;
    }
    const card = el('div', 'set-card gw-access-card');
    for (const a of ordered(s)) card.append(accountAccess(s, a, access, nameOf));
    sec.append(card);
    const defaults = defaultsCard(s, access, nameOf); if (defaults) sec.append(defaults);
    const tail = el('div', 'gw-access-tail');
    if (dirty && JSON.stringify(s.access) !== draftBase) tail.append(el('div', 'gw-next gw-elsewhere', 'Access was changed elsewhere while you were editing. Save to keep your version, or Discard to see the current one.'));
    if (accessNotice) { const n = el('div', 'plg-notice ' + (accessNotice.ok ? 'ok' : 'bad'), accessNotice.text); n.setAttribute('role', accessNotice.ok ? 'status' : 'alert'); tail.append(n); }
    const bar = el('div', 'gw-save');   // only when there is something to save (or it is being saved)
    if (dirty) {
      const discard = button('Discard', 'plg-btn', () => { draft = null; accessNotice = null; render(); }, 'access-discard');
      discard.disabled = busy === 'access-save'; bar.append(el('span', 'gw-unsaved', 'Unsaved changes'), discard);
    }
    const save = button(busy === 'access-save' ? 'Saving…' : 'Save', 'plg-primary', saveAccess, 'access-save');
    save.disabled = !!busy || !dirty; bar.append(save);
    if (dirty || busy === 'access-save') tail.append(bar);
    if (tail.firstElementChild) sec.append(tail);
    sec.append(el('div', 'set-hint', 'New accounts start with no agent access. These choices apply to this plugin; agents may still access Google through other tools on this computer.'));
    return sec;
  }

  // ── Advanced: defaults, gog, sign-in files ──
  function advancedSection(s) {
    const adv = fold('fold-advanced', 'Advanced', 'gw-advanced');
    const dc = el('div', 'set-card');
    // Which account an agent uses is chosen per project under Agent access; only the sign-in file override remains here.
    dc.append(row('Default sign-in file', s.defaults.client || 'gog’s own default'));
    if (s.available) {
      // Say plainly whose gog this is: the one already here, the Settings path, or the copy CliDeck installed.
      const source = install && install.state === 'ready' && SOURCE[install.source];
      const value = el('div', 'gw-value'); value.append(el('div', '', [s.version, source].filter(Boolean).join(' · ') || 'Found'));
      if (s.executable) value.append(el('div', 'gw-mono gw-path', s.executable));
      const r = el('div', 'set-row'), lbl = el('div', 'set-row-lbl'); lbl.append(el('div', 'set-row-t', 'gog')); r.append(lbl, value); dc.append(r);
    }
    const agents = el('div', 'set-row'), al = el('div', 'set-row-lbl'), cmd = el('div', 'gw-value'); al.append(el('div', 'set-row-t', 'Agents use it with'));
    cmd.append(el('code', 'gw-mono', 'google/run')); agents.append(al, cmd); dc.append(agents);
    adv.append(dc, el('div', 'set-hint', 'CliDeck prepares its Google connection automatically. Custom OAuth clients and gog’s location can be changed in Settings → Plugins → Google Workspace.'));
    if (s.available && form && form.client !== 'clideck' && !hasClient(s, form.client)) adv.append(guide(s));
    if (s.setupSupported && s.available) {
      const files = el('div', 'set-card gw-clients');
      files.append(el('div', 'set-row-t', 'Sign-in files'), el('div', 'set-row-s', 'CliDeck’s connection is prepared automatically. Custom Google Cloud clients are optional.'));
      if (clientNotice) files.append(clientNotice.ok ? good(clientNotice.text) : bad(clientNotice.text));
      for (const c of s.clients) {
        const name = String(c.name), users = s.accounts.filter((a) => (a.client || 'default') === name).length;
        const r = el('div', 'set-row'), l = el('div', 'set-row-lbl');
        l.append(el('div', 'set-row-t', name), el('div', 'set-row-s', users ? 'Used by ' + users + ' account' + (users === 1 ? '' : 's') : 'Not used by any account'));
        const rm = button('Remove…', 'gw-act danger', () => { removingClient = name; clientNotice = null; render(); }, 'client-remove-' + name);
        rm.disabled = !!busy || users > 0 || name === 'clideck'; if (users) rm.title = 'Disconnect the accounts that use it first.';
        r.append(l, rm); files.append(r);
        if (removingClient === name) {
          const box = el('div', 'gw-confirm'); box.setAttribute('role', 'alertdialog');
          box.append(el('div', 'set-row-s', 'Remove the sign-in file “' + name + '” from gog? You’d need to upload it again to connect accounts with it.'));
          const bar = el('div', 'gw-confirm-actions');
          bar.append(button('Cancel', 'plg-btn', () => { removingClient = ''; render(); }, 'client-remove-cancel'),
            button(busy === 'credentials-remove' ? 'Removing…' : 'Remove', 'plg-remove', () => act('credentials-remove', { client: name },
              (message) => { removingClient = ''; clientNotice = { ok: false, text: message }; }, () => { removingClient = ''; clientNotice = { ok: true, text: 'Sign-in file “' + name + '” removed.' }; }), 'client-remove-yes'));
          box.append(bar); files.append(box);
        }
      }
      const add = el('div', 'gw-client-add'), nameInput = el('input', 'set-input mono');
      nameInput.value = clientName; nameInput.placeholder = 'default'; nameInput.spellcheck = false; nameInput.setAttribute('aria-label', 'Sign-in file name'); nameInput.dataset.control = 'client-name';
      const wanted = (clientName.trim() || 'default').toLowerCase(), exists = clientsOf(s).map((n) => n.toLowerCase()).includes(wanted);
      const nameOk = /^[a-z0-9][a-z0-9_-]{0,63}$/i.test(wanted) && wanted !== 'all';   // gog's rule; “all” is reserved
      const l = el('div', 'set-row-lbl'); l.append(el('div', 'set-row-t', 'Add a sign-in file'), el('div', 'set-row-s', 'Give it a name, then choose its JSON file.'));
      add.append(l, nameInput);
      if (!nameOk) add.append(el('div', 'set-hint warn', 'Use letters, numbers, dashes or underscores. “all” is reserved.'));
      else if (exists) {
        const opt = el('label', 'gw-agent gw-replace'), box = el('input'); box.type = 'checkbox'; box.checked = replaceClient; box.dataset.control = 'client-replace';
        box.addEventListener('change', () => { replaceClient = box.checked; render(); });
        opt.append(box, el('span', 'gw-agent-name', 'Replace the saved “' + wanted + '” file')); add.append(opt);
      }
      nameInput.addEventListener('change', () => { clientName = nameInput.value; render(); });
      add.append(uploadBox(wanted, exists && replaceClient, 'client-file', !nameOk || (exists && !replaceClient))); files.append(add); adv.append(files);
    }
    return adv;
  }

  // ── render ──
  function render() {
    const active = document.activeElement, focus = active && active.dataset ? active.dataset.control : '';
    let caret = null; try { if (focus && typeof active.selectionStart === 'number') caret = [active.selectionStart, active.selectionEnd]; } catch (e) { caret = null; }
    paint();
    if (focus) {
      const again = [...root.querySelectorAll('[data-control]')].find((n) => n.dataset.control === focus);
      if (again && !again.disabled) { again.focus(); if (caret) try { again.setSelectionRange(caret[0], caret[1]); } catch (e) { /* not a text field */ } }
    }
  }
  function paint() {
    root.replaceChildren();
    const head = el('div', 'gw-head'), ic = el('span', 'gw-ic'); ic.innerHTML = G;
    const titles = el('div', 'gw-titles');
    titles.append(el('div', 'gw-name', 'Google Workspace'), el('div', 'gw-sub', 'Let your agents use Gmail, Calendar, Drive and more with the Google accounts you connect here.'));
    head.append(ic, titles); root.append(head);
    if (!snapshot) {
      // First use can download gog before the first snapshot: show that work, or its real error.
      if (working() && install.state !== 'checking') { head.append(chip(['loading', 'Preparing'])); root.append(progressCard()); }
      else if (install && install.state === 'error') { head.append(chip(['failed', 'Not available'])); root.append(failedSetup()); }
      else if (loadError) root.append(bad(loadError), button('Try again', 'plg-btn', () => { loadError = ''; load(); }, 'retry'));
      else root.append(el('div', 'gw-loading', 'Checking Google connections…'));
      return;
    }
    const s = snapshot;
    const state = overall(s); if (state) head.append(chip(state));
    if (notice) root.append(bad(notice));
    if (working() && install.state !== 'checking') root.append(progressCard());
    // The page says what to do next itself (per account, or the sign-in form). The server's own summary lines
    // would repeat or contradict it, so only an error that isn't about one account is shown here.
    if (s.error && s.available && !s.accounts.some(failing)) {
      const box = el('div', 'set-card gw-problem'); box.setAttribute('role', 'alert');
      box.append(el('div', 'set-row-t', 'CliDeck couldn’t read your Google sign-ins.'), el('div', 'set-row-s', 'Try Check again. If it keeps happening, reconnect the account.'), technical('fold-error-details', [s.error]));
      root.append(box);
    }
    if (!s.available) {
      // Nothing can be connected until the Google connection is ready: say so, offer Try again.
      const sec = el('div', 'set-section');
      if (install && install.state === 'error' && !working()) sec.append(failedSetup());
      else if (!working()) {
        const card = el('div', 'set-card'); card.dataset.app = 'google';
        card.append(el('div', 'set-row-t', 'Google connection isn’t ready on this computer.'),
          el('div', 'set-row-s', 'Try again. If it still isn’t ready, open Details.'));
        const again = el('div', 'gw-actions gw-retry'); again.append(button(busy === 'status' ? 'Retrying…' : 'Try again', 'plg-primary', () => run('status'), 'install-retry'));
        card.append(again, technical('fold-setup-details', [s.error, s.executable ? 'Looked for gog at ' + s.executable + '.' : '', SUPPORTED + ' Elsewhere, install gog yourself or set its full path in Settings → Plugins → Google Workspace.']));
        sec.append(card);
      }
      root.append(sec);
    } else {
      const requests = requestSection(s); if (requests) root.append(requests);
      const connect = connectSection(s);
      const inlineAccount = connect && form?.mode === 'reconnect' && s.accounts.find(a =>
        same(a.email, form.email) && same(a.client || defaultClient(s), form.client));
      if (s.accounts.length) root.append(accountsSection(s, inlineAccount, connect));
      if (connect && !inlineAccount) root.append(connect);
      if (!s.accounts.length && !s.setupSupported) {
        const card = el('div', 'set-card'); card.dataset.app = 'google'; card.append(el('div', 'set-row-t', 'No Google accounts yet.'));
        const sec = el('div', 'set-section'); sec.append(accountsHead(s), card); root.append(sec);
      }
    }
    root.append(accessSection(s), advancedSection(s));
  }

  post({ type: 'clideck.ready' });
})();
