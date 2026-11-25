const { randomUUID } = require('node:crypto');
const { createServer } = require('node:http');
const { renderOAuthPage } = require('./oauth-page');

const FLAGS = ['--json', '--no-input', '--color=never'];
const LABELS = { gmail: 'Gmail', calendar: 'Calendar', drive: 'Drive', docs: 'Docs', sheets: 'Sheets', slides: 'Slides',
  contacts: 'Contacts', tasks: 'Tasks', people: 'People', chat: 'Chat', classroom: 'Classroom', forms: 'Forms',
  meet: 'Meet', sites: 'Sites', appscript: 'Apps Script', analytics: 'Analytics', searchconsole: 'Search Console',
  youtube: 'YouTube', photos: 'Photos', driveactivity: 'Drive activity', drivelabels: 'Drive labels',
  adsense: 'AdSense', ads: 'Google Ads', photospicker: 'Photo picker' };
// gog auth services returns display names; Google Console's enableapi flow needs
// service IDs. Keep these aligned with gog's apiServiceIDsByService metadata.
const APIS = { gmail: ['gmail'], calendar: ['calendar-json'], drive: ['drive'], docs: ['docs', 'drive'],
  sheets: ['sheets', 'drive'], slides: ['slides', 'drive'], contacts: ['people'], tasks: ['tasks'], people: ['people'],
  chat: ['chat'], classroom: ['classroom'], forms: ['forms'], meet: ['meet'], sites: ['drive'], appscript: ['script'],
  analytics: ['analyticsadmin', 'analyticsdata'], searchconsole: ['searchconsole'], youtube: ['youtube'],
  photos: ['photoslibrary'], driveactivity: ['driveactivity'], drivelabels: ['drivelabels'], adsense: ['adsense'],
  ads: ['googleads'], photospicker: ['photospicker'] };
const DEFAULT_CLIENT = 'clideck';
const BUILTIN_SERVICES = ['gmail', 'calendar', 'drive', 'docs', 'sheets'];
function supportsService(client, id) {
  return client.toLowerCase() !== DEFAULT_CLIENT || BUILTIN_SERVICES.includes(id);
}
const AUTH_TIMEOUT = 5 * 60_000;
const string = value => typeof value === 'string' ? value : '';
function clientName(value = 'default') {
  if (typeof value !== 'string' || !/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}$/.test(value) || value.toLowerCase() === 'all') throw Error('Use a connection name with letters, numbers, dashes or underscores; “all” is reserved.');
  return value.toLowerCase();
}
function emailAddress(value) {
  if (typeof value !== 'string' || value.length > 254 || !/^[^\s@\x00-\x1f]+@[^\s@\x00-\x1f]+\.[^\s@\x00-\x1f]+$/.test(value) || value.startsWith('-')) throw Error('Enter your Google account email address.');
  return value.toLowerCase();
}
function errorMessage(error) {
  // Authorization output contains an entire sign-in URL. Show the failure, not
  // that URL or an echoed authorization code/credential, in notices and logs.
  return String(error?.message || error || 'Google setup failed.').split('\n')
    .map(line => line.replace(/^Paste redirect URL \(Enter or Ctrl-D\):\s*/, ''))
    .filter(line => !/https:\/\/accounts\.google\.com\/|Opening browser|If the browser|Server listening|Authorization received|Google sign-in requires a Google Account|Visit this URL to authorize:|After authorizing, you'll be redirected|Copy the URL from your browser's address bar/.test(line))
    .join('\n').replace(/((?:client_secret|refresh_token|access_token|id_token|code)=)[^\s&]+/gi, '$1[hidden]')
    .replace(/("(?:client_secret|refresh_token|access_token|id_token|code)"\s*:\s*")[^"]*/gi, '$1[hidden]').trim().slice(0, 2000) || 'Google sign-in did not finish. Try again.';
}
function jsonResult(result) {
  if (result.exitCode) throw Error(errorMessage(result.stderr || 'Google could not complete this step.'));
  try { return JSON.parse(result.stdout); } catch { throw Error('The Google helper returned an unexpected response. Check its version in Advanced.'); }
}

// gog owns OAuth, PKCE, state verification and credential storage. Its supported
// manual flow lets us supply a loopback callback and a CliDeck completion page.
function createSetup({ execute, changed = () => {}, currentClient = () => 'default', timeoutMs = AUTH_TIMEOUT }) {
  let clients = [], services = [], metadataError = '', authorization = null, active = null, mutating = false, closed = false;
  const callbacks = new Set();
  const snapshot = () => ({ clients, services: services.filter(s => supportsService(currentClient(), s.id)), error: metadataError, authorization: authorization && { ...authorization } });
  const notify = () => { if (!closed) changed(); };
  async function openCallback(job) {
    let timer;
    const server = createServer({ maxHeaderSize: 16 * 1024, headersTimeout: 5000, requestTimeout: 10_000 }, async (req, res) => {
      res.setHeader('Cache-Control', 'no-store');
      res.setHeader('Referrer-Policy', 'no-referrer');
      res.setHeader('X-Content-Type-Options', 'nosniff');
      res.setHeader('Content-Security-Policy', "default-src 'none'; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'");
      const page = (status, outcome) => {
        res.writeHead(status, { 'Content-Type': 'text/html; charset=utf-8' });
        res.end(renderOAuthPage(outcome));
      };
      try {
        if (req.method !== 'GET' || req.headers.host !== job.callback.host || !req.url?.startsWith('/') || req.url.length > 16384) throw Error('This sign-in address is not valid. Return to CliDeck to try again.');
        const url = new URL(req.url, job.callback);
        if (url.pathname === '/done' && !url.search && job.outcome) return page(200, job.outcome);
        if (url.pathname !== '/oauth2/callback') { res.writeHead(404).end(); return; }
        await complete({ id: job.id, url: url.href });
        // Strip the one-time code from the address bar before showing any links.
        res.writeHead(303, { Location: '/done' }).end();
      } catch (error) { page(400, { status: 'failed', message: errorMessage(error) }); }
    });
    job.closeCallback = () => { clearTimeout(timer); callbacks.delete(job.closeCallback); server.close(() => {}); };
    job.finishCallback = () => {
      if (closed || !job.submitted) job.closeCallback();
      else { timer = setTimeout(job.closeCallback, 120_000); timer.unref(); }
    };
    callbacks.add(job.closeCallback);
    await new Promise((resolve, reject) => {
      server.once('error', reject);
      server.listen(0, '127.0.0.1', resolve);
    });
    server.unref();
    job.callback = new URL(`http://127.0.0.1:${server.address().port}/oauth2/callback`);
  }
  async function read() {
    const results = await Promise.allSettled([
      execute([...FLAGS, 'auth', 'credentials', 'list'], { timeout: 10_000 }),
      execute([...FLAGS, 'auth', 'services'], { timeout: 10_000 }),
    ]);
    const errors = [];
    for (let i = 0; i < results.length; i++) {
      try {
        if (results[i].status === 'rejected') throw results[i].reason;
        const payload = jsonResult(results[i].value);
        if (i === 0) {
          if (!Array.isArray(payload.clients)) throw Error('Could not read saved Google connections. Check the helper version in Advanced.');
          clients = payload.clients.map(item => ({ name: string(item.client) })).filter(item => item.name);
        } else {
          if (!Array.isArray(payload.services)) throw Error('Could not read available Google services. Check the helper version in Advanced.');
          services = payload.services.filter(item => LABELS[item.service]).map(item => ({ id: item.service, label: LABELS[item.service],
            apis: APIS[item.service].map(name => `${name}.googleapis.com`), supportsReadonly: item.service !== 'ads' }));
        }
      } catch (error) { if (i === 0) clients = []; else services = []; errors.push(errorMessage(error)); }
    }
    metadataError = errors.join('\n');
    return snapshot();
  }
  async function accountList() {
    const payload = jsonResult(await execute([...FLAGS, 'auth', 'list'], { timeout: 10_000 }));
    if (!Array.isArray(payload.accounts)) throw Error('Could not read saved Google accounts.');
    return payload.accounts;
  }
  function idle() {
    if (closed) throw Error('Google Workspace is stopping.');
    if (active || mutating) throw Error('Finish or cancel the current Google setup step first.');
  }
  async function credentialsSave(request) {
    const client = clientName(request.client);
    if (typeof request.json !== 'string' || Buffer.byteLength(request.json) > 64 * 1024) throw Error('Choose the small JSON connection file downloaded from Google.');
    let file;
    try { file = JSON.parse(request.json); } catch { throw Error('This is not a valid Google connection file. Download the JSON file for a Desktop app from Google Cloud.'); }
    const credentials = file?.installed;
    if (!credentials || typeof credentials !== 'object' || !/^[\w.-]+\.apps\.googleusercontent\.com$/.test(string(credentials.client_id))
      || !string(credentials.client_secret) || credentials.client_secret.length > 4096 || credentials.client_secret.includes('\0')) {
      throw Error('Choose a Desktop app connection file from Google Cloud, not a web app or service account file.');
    }
    await read();
    if (metadataError) throw Error(metadataError);
    if (clients.some(item => item.name === client) && request.replace !== true) throw Error('This connection already exists. Confirm replacement or choose another name.');
    // Do not forward unneeded file fields or let a malformed file select an endpoint.
    const stdin = JSON.stringify({ installed: { client_id: credentials.client_id, client_secret: credentials.client_secret } });
    const result = jsonResult(await execute([...FLAGS, '--client', client, 'auth', 'credentials', 'set', '-'], { stdin, timeout: 30_000 }));
    if (result.saved !== true) throw Error('Google did not confirm that the connection file was saved.');
    await read();
  }
  async function credentialsRemove(request) {
    const client = clientName(request.client), accounts = await accountList();
    if (accounts.some(item => (item.client || 'default') === client)) throw Error('Disconnect the accounts using this connection before removing it.');
    jsonResult(await execute([...FLAGS, '--force', 'auth', 'credentials', 'remove', client], { timeout: 15_000 }));
    await read();
    if (metadataError || clients.some(item => item.name === client)) throw Error(metadataError || 'The connection file is still saved. Refresh before trying again.');
  }
  async function accountRemove(request) {
    const email = emailAddress(request.email), client = clientName(request.client);
    const accounts = await accountList();
    const account = accounts.find(item => string(item.email).toLowerCase() === email && (item.client || 'default') === client);
    if (!account) throw Error('This Google account is no longer saved. Refresh the page.');
    if (account.auth && account.auth !== 'oauth') throw Error('This is a service account. Manage its credentials with your Google Workspace administrator.');
    jsonResult(await execute([...FLAGS, '--client', client, '--force', 'auth', 'remove', email], { timeout: 15_000 }));
    if ((await accountList()).some(item => string(item.email).toLowerCase() === email && (item.client || 'default') === client)) throw Error('The account is still saved. Check connections before trying again.');
  }
  async function start(request) {
    const email = emailAddress(request.email), client = clientName(request.client);
    if (typeof request.readonly !== 'boolean') throw Error('Choose whether Google access should be read-only.');
    await read();
    if (metadataError) throw Error(metadataError);
    if (!clients.some(item => item.name === client)) throw Error('Add your Google connection file first.');
    if (!Array.isArray(request.services) || !request.services.length || request.services.length > 30
      || request.services.some(id => !services.some(item => item.id === id))) throw Error('Choose at least one supported Google service.');
    if (request.services.some(id => !supportsService(client, id))) throw Error('The built-in Google connection supports Gmail, Calendar, Drive, Docs and Sheets. Choose a custom Google connection for other services.');
    if (request.readonly && request.services.includes('ads')) throw Error('Google Ads requires permission to make changes. Remove Google Ads or explicitly choose Read and change.');
    const args = [...FLAGS, '--client', client, ...(request.readonly ? ['--readonly'] : []), 'auth', 'add', email,
      '--services', [...new Set(request.services)].join(','), '--force-consent', '--manual', `--timeout=${Math.ceil(timeoutMs / 1000)}s`];
    // Gog's full preset includes gmail.settings.sharing, which only works with
    // Workspace domain-wide delegation. Normal Desktop OAuth cannot use it.
    const gmailFull = !request.readonly && request.services.includes('gmail')
      && (request.gmailScope === undefined || request.gmailScope === 'full');
    for (const [field, name, choices] of [['driveScope', 'drive-scope', ['full', 'readonly', 'file']], ['gmailScope', 'gmail-scope', ['full', 'readonly', 'send', 'read-send']]]) {
      let value = field === 'gmailScope' && gmailFull ? 'send' : request[field];
      // Docs and Sheets use Drive for file creation. Editing their contents
      // does not require write access to every other file in Drive.
      if (field === 'driveScope' && client === DEFAULT_CLIENT && !request.readonly && !request.services.includes('drive')
        && request.services.some(id => id === 'docs' || id === 'sheets')) value = 'file';
      if (value === undefined) continue;
      if (!choices.includes(value)) throw Error('Choose a supported Google permission option.');
      if (request.readonly && ['file', 'send', 'read-send'].includes(value)) throw Error('Sending or editing cannot be combined with read-only access.');
      args.push(`--${name}=${value}`);
    }
    if (gmailFull) {
      const extra = ['https://www.googleapis.com/auth/gmail.modify'];
      if (client !== DEFAULT_CLIENT) extra.push('https://www.googleapis.com/auth/gmail.settings.basic');
      args.push('--extra-scopes=' + extra.join(','));
    }
    const controller = new AbortController();
    const job = { id: randomUUID(), controller, done: null, callback: null, state: '', submitted: false };
    const input = new Promise(resolve => { job.sendInput = resolve; });
    for (const close of callbacks) close();
    active = job;
    authorization = { id: job.id, status: 'starting', email, client, url: '', message: 'Opening Google sign-in…', expiresAt: new Date(Date.now() + timeoutMs).toISOString() };
    let output = '', ready;
    const started = new Promise(resolve => { ready = resolve; });
    const onStderr = chunk => {
      output = (output + chunk).slice(-64 * 1024);
      const match = output.match(/https:\/\/accounts\.google\.com\/[^\s]+(?=\s)/);
      if (!match || job.state || controller.signal.aborted) return;
      const url = new URL(match[0]), callback = new URL(url.searchParams.get('redirect_uri'));
      if (callback.href !== job.callback.href || url.searchParams.getAll('state').length !== 1 || !url.searchParams.get('state')) throw Error('Unexpected Google sign-in callback.');
      job.state = url.searchParams.get('state');
      authorization = { ...authorization, status: 'waiting', url: url.href, message: 'Finish signing in with Google, then return here.' };
      ready(); notify();
    };
    job.done = (async () => {
      try {
        await openCallback(job);
        const result = await execute([...args, `--redirect-uri=${job.callback.href}`], {
          stdin: () => input, timeout: timeoutMs + 5000, signal: controller.signal, onStderr,
        });
        if (controller.signal.aborted) return;
        const payload = jsonResult(result);
        if (payload.stored !== true || string(payload.email).toLowerCase() !== email || payload.client !== client) throw Error('Google did not confirm that this account was saved. Check connections before trying again.');
        authorization = { ...authorization, status: 'connected', url: '', message: `${email} is connected.` };
      } catch (error) {
        if (!controller.signal.aborted) authorization = { ...authorization, status: 'failed', url: '', message: errorMessage(error) };
      } finally {
        job.sendInput('');
        job.outcome = { status: authorization.status, email, message: authorization.message };
        job.finishCallback?.();
        if (active === job) active = null;
        ready(); notify();
      }
    })();
    notify();
    // Usually the URL is available immediately. Still answer if the OS keychain
    // needs user interaction; the later URL/result arrives through updated.
    let timer;
    await Promise.race([started, new Promise(resolve => { timer = setTimeout(resolve, 1500); })]);
    clearTimeout(timer);
  }
  function currentJob(id) {
    if (!active || active.id !== id) throw Error('This sign-in has ended. Start a new sign-in if needed.');
    return active;
  }
  async function cancel(id) {
    const job = currentJob(id);
    authorization = { ...authorization, status: 'cancelled', url: '', message: 'Sign-in stopped. Check connections before starting again.' };
    job.controller.abort();
    await job.done;
  }
  async function complete(request) {
    const job = currentJob(request.id);
    if (!job.callback || !job.state) throw Error('Google sign-in is still starting.');
    if (job.submitted) throw Error('This sign-in response was already submitted. Wait for the result.');
    let url;
    try { if (typeof request.url !== 'string' || request.url.length > 16384) throw Error(); url = new URL(request.url.trim()); }
    catch { throw Error('Paste the full address from the browser after signing in with Google.'); }
    if (url.origin !== job.callback.origin || url.pathname !== job.callback.pathname || url.username || url.password || url.hash
      || url.searchParams.getAll('state').length !== 1 || url.searchParams.get('state') !== job.state
      || url.searchParams.getAll('code').length > 1 || url.searchParams.getAll('error').length > 1
      || Boolean(url.searchParams.get('code')) === Boolean(url.searchParams.get('error'))) throw Error('That address does not match this sign-in. Copy the address from the current Google sign-in window.');
    job.submitted = true;
    if (url.searchParams.get('error')) {
      authorization = { ...authorization, status: 'failed', url: '', message: 'Google sign-in was not approved. Return to CliDeck to try again.' };
      job.controller.abort();
    } else {
      // Gog verifies the same state/redirect and exchanges the code with its PKCE
      // verifier. Never log the callback, put it on argv, or repeat a submission.
      job.sendInput(url.href + '\n');
    }
    await job.done;
  }
  async function action(request) {
    if (request.action === 'auth-cancel') return cancel(request.id);
    if (request.action === 'auth-complete') return complete(request);
    idle(); mutating = true;
    try {
      switch (request.action) {
        case 'credentials-save': return await credentialsSave(request);
        case 'credentials-remove': return await credentialsRemove(request);
        case 'account-remove': return await accountRemove(request);
        case 'auth-start': return await start(request);
        default: throw Error('Unknown Google setup action.');
      }
    } finally { mutating = false; }
  }
  async function close() {
    closed = true;
    if (active) { const job = active; job.controller.abort(); await job.done; }
    for (const close of callbacks) close();
  }
  return { read, snapshot, action, close };
}

module.exports = { createSetup, errorMessage, emailAddress, DEFAULT_CLIENT, supportsService };
