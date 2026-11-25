const { randomUUID } = require('node:crypto');
// Distributed Desktop OAuth app configuration; each user's tokens stay in Gog.
const DESKTOP_CLIENT = require('./desktop-client.json');
const { findGog, createRunner } = require('./runner');
const { Access, accountKey } = require('./access');
const { createInstaller } = require('./install');
const { createSetup, errorMessage, emailAddress, DEFAULT_CLIENT, supportsService } = require('./setup');

const text = value => typeof value === 'string' ? value : '';
const flag = (args, names) => args.slice(0, args.includes('--') ? args.indexOf('--') : args.length).some(arg => names.some(name => arg === name || arg.startsWith(name + '='))
  || names.includes('-a') && /^-a[^-]/.test(arg));
const SETUP_ACTIONS = ['credentials-save', 'credentials-remove', 'auth-start', 'auth-cancel', 'auth-complete', 'account-remove'];

// Keep account selection in the plugin. Auth/config/backup and nested command
// runners must not provide another route to credentials or account switching.
const RUN_COMMANDS = new Set(('gmail mail email calendar cal drive drv docs doc sheets sheet slides slide contacts contact tasks task people person chat classroom class forms form meet meeting sites site appscript script apps-script analytics ga searchconsole gsc search-console webmasters youtube yt photos photo adsense ads driveactivity drivelabels photospicker send ls list search find open browse download dl upload up put me whoami who-am-i time schema help-json helpjson version').split(' '));
const ROOT_VALUES = new Set(['--color', '--quota-project', '--enable-commands', '--enable-commands-exact', '--disable-commands', '--select', '--pick', '--project']);
const ROOT_BOOLS = new Set(['--readonly', '--gmail-no-send', '--json', '-j', '--machine', '--plain', '-p', '--tsv', '--wrap-untrusted', '--results-only', '--dry-run', '--noop', '--preview', '--dryrun', '-n', '--force', '--yes', '--assume-yes', '-y', '--no-input', '--non-interactive', '--noninteractive', '--verbose', '-v', '--help', '-h', '--version']);
function scopedArgs(args) {
  const requested = {}, clean = [];
  let root = '', literal = false;
  for (let i = 0; i < args.length; i++) {
    const arg = args[i], name = arg.split('=')[0];
    if (literal) { clean.push(arg); continue; }
    if (arg === '--') { literal = true; clean.push(arg); continue; }
    const shortAccount = /^-a[^-]/.test(arg);
    if (['--account', '--acct', '-a', '--client'].includes(name) || shortAccount) {
      const key = name === '--client' ? 'client' : 'email';
      const value = shortAccount ? arg.slice(2).replace(/^=/, '') : arg.includes('=') ? arg.slice(arg.indexOf('=') + 1) : args[++i];
      if (!value || value.startsWith('-') || requested[key]) throw Error('Specify each Google account/client once, with a value.');
      requested[key] = value; continue;
    }
    if (['--home', '--access-token', '--impersonate', '--service-account'].includes(name)) throw Error('Credential overrides are unavailable through Google Workspace. Choose an allowed account.');
    if (/^-[^-].+/.test(arg)) throw Error('Use separate short flags or full flag names for Google commands.');
    if (!root) {
      if (ROOT_VALUES.has(name)) {
        clean.push(arg);
        if (!arg.includes('=')) { if (!args[i + 1] || args[i + 1].startsWith('-')) throw Error('Missing Google flag value.'); clean.push(args[++i]); }
        continue;
      }
      if (ROOT_BOOLS.has(name)) { clean.push(arg); continue; }
      if (!RUN_COMMANDS.has(arg)) throw Error('Use a Google service command, google/status, or Google Workspace → Configure for account management. Put the service before its options.');
      root = arg;
    }
    clean.push(arg);
  }
  if (!root && !args.some(arg => ['--help', '-h', '--version'].includes(arg))) throw Error('Choose a Google service command.');
  return { args: clean, requested };
}

function commandArgs(args, settings) {
  const defaults = ['--no-input', '--color=never'];
  if (!flag(args, ['--json', '-j', '--machine', '--plain', '-p', '--tsv'])) defaults.push('--json');
  if (settings.account && !flag(args, ['--account', '--acct', '-a'])) defaults.push('--account', settings.account);
  if (settings.client && !flag(args, ['--client'])) defaults.push('--client', settings.client);
  if (args.some(arg => /^--(?:no-input|non-interactive|noninteractive)=(?:false|0)$/i.test(arg))) {
    throw Error('Plugin commands run without interactive prompts. Open Google Workspace → Configure to connect an account.');
  }
  return [...defaults, ...args];
}

function createService(api, { runner = createRunner({ env: { ...process.env, GOG_ACCESS_TOKEN: '', GOG_AUTH_MODE: 'stored' } }), locate = findGog, ...installOptions } = {}) {
  const installer = createInstaller({ dataDir: api.dataDir, locate, ...installOptions,
    onProgress: state => api.sendToClients('install-progress', state) });
  let pendingStatus = null, latest = null, revision = 0, onChange = () => {};
  let cachedSettings = '', cachedRevision = -1, cachedAt = 0;
  const invalidate = () => { revision++; };
  const settings = () => ({ ...Object.fromEntries(['executable', 'account', 'client'].map(key => [key, text(api.getSetting(key)).trim()])), client: text(api.getSetting('client')).trim() || DEFAULT_CLIENT });
  const setup = createSetup({ currentClient: () => settings().client, execute: async (args, options) => runner.run(await installer.ensure(settings().executable), args, options),
    changed: () => { invalidate(); onChange(); } });
  const initialState = check => {
    const config = settings();
    return { available: false, version: '', executable: '', accounts: [], accountsLoaded: false, defaults: { account: config.account, client: config.client },
      checked: check, error: '', next: { message: '', url: '' }, setup: setup.snapshot() };
  };
  async function status(check = false, startedRevision = revision) {
    const config = settings(), state = initialState(check);
    try {
      state.executable = await installer.ensure(config.executable);
      const version = await runner.run(state.executable, ['--version'], { timeout: 10_000 });
      if (version.exitCode) throw Error(version.stderr.trim() || 'gog could not report its version.');
      state.available = true; state.version = version.stdout.trim();
      const result = await runner.run(state.executable, ['--json', '--no-input', '--color=never', ...(config.client ? ['--client', config.client] : []),
        'auth', 'list', ...(check ? ['--check', '--timeout', '8s'] : [])], { timeout: 60_000 });
      if (result.exitCode) throw Error(result.stderr.trim() || 'gog could not read its accounts.');
      const payload = JSON.parse(result.stdout);
      if (!Array.isArray(payload.accounts)) throw Error('gog returned an unexpected account list. Check its version and configuration.');
      state.accountsLoaded = true;
      state.accounts = payload.accounts.filter(account => !config.client || (text(account.client) || 'default') === config.client)
        .map(account => ({ email: text(account.email), client: text(account.client) || 'default',
        services: Array.isArray(account.services) ? account.services.filter(value => typeof value === 'string') : [],
        scopes: Array.isArray(account.scopes) ? account.scopes.filter(value => typeof value === 'string') : [], auth: text(account.auth),
        ...(check && typeof account.valid === 'boolean' && { valid: account.valid }), ...(account.error && { error: errorMessage(account.error) }) }));
      if (state.accounts.some(account => account.valid === false || account.error)) state.error = 'A Google connection needs attention.';
      state.next.message = state.accounts.length ? ''
        : 'Connect your Google account to use Gmail, Calendar, Drive and more in CliDeck.';
    } catch (error) { state.error = errorMessage(error); state.next.message = state.error; }
    if (state.available) {
      state.setup = await setup.read();
      if (!state.setup.error && config.client === DEFAULT_CLIENT && !state.setup.clients.some(client => client.name === DEFAULT_CLIENT)) {
        try {
          await setup.action({ action: 'credentials-save', client: DEFAULT_CLIENT, json: JSON.stringify(DESKTOP_CLIENT) });
          state.setup = setup.snapshot();
        } catch (error) { state.error = `Could not prepare CliDeck's Google connection: ${errorMessage(error)}`; }
      }
      if (state.setup.error && !state.error) state.error = state.setup.error;
    }
    // A sign-in or removal can finish during a keychain read. Never publish the
    // account list from before that change over its completed result.
    const result = { ...state, installation: installer.snapshot() };
    if (startedRevision === revision) {
      latest = result; cachedSettings = JSON.stringify(config); cachedRevision = revision; cachedAt = Date.now();
    }
    return result;
  }
  function sharedStatus(check = false) {
    // Refresh is on demand. Share reads, and finish an older read before starting
    // a new one so concurrent browser updates cannot exhaust the child limit.
    const config = settings(), key = JSON.stringify([config, check]), startedRevision = revision;
    // Reopening Configure and setup broadcasts need not reopen the Keychain.
    // Explicit checks and changes to credentials/settings always refresh.
    if (!check && latest?.accountsLoaded && cachedSettings === JSON.stringify(config)
      && cachedRevision === revision && Date.now() - cachedAt < 60_000) return Promise.resolve({ ...latest, setup: setup.snapshot() });
    if (pendingStatus) return pendingStatus.key === key ? pendingStatus.promise : pendingStatus.promise.then(() => sharedStatus(check));
    const promise = status(check).finally(() => { if (pendingStatus?.promise === promise) pendingStatus = null; })
      .then(state => startedRevision === revision && key === JSON.stringify([settings(), check]) ? state : sharedStatus(check));
    pendingStatus = { key, promise }; return promise;
  }
  async function run({ args, stdin = '', sessionId, identity }, help = false) {
    if (!args.length && !help) throw Error('Use clideck google/help to discover commands, then clideck google/run <gog arguments>.');
    if (help && args.some(arg => !/^[a-z][a-z0-9-]*$/.test(arg))) throw Error('Use google/help with a command path, for example google/help gmail search.');
    const config = settings(), executable = await installer.ensure(config.executable);
    const session = await api.getSession(sessionId);
    if (!session?.cwd) throw Error('The calling session is no longer available.');
    return runner.run(executable, help ? [...args, '--help'] : commandArgs(args, identity ? { account: identity.email, client: identity.client } : config), { cwd: session.cwd, stdin });
  }
  return { status: sharedStatus, current: () => ({ ...(latest || { ...initialState(false), installation: installer.snapshot() }), setup: setup.snapshot() }),
    onChange: callback => { onChange = callback; },
    setup: async request => { invalidate(); try { await setup.action(request); } finally { invalidate(); } },
    run, close: () => Promise.all([setup.close(), installer.close(), runner.close()]) };
}

function activate(api, options) {
  const service = createService(api, options);
  const access = new Access(api);
  const setupCallers = new Map(), connections = new Map();
  const connectionRows = () => [...connections.values()].map(({ policy, ...row }) => ({ ...row }));
  const connectionFor = (id, sessionId) => {
    const row = connections.get(id);
    if (!row || sessionId && row.sessionId !== sessionId) throw Error('This connection request is no longer available.');
    return row;
  };
  let settling = Promise.resolve();
  const settleConnections = () => {
    settling = settling.then(async () => {
      const auth = service.current().setup.authorization;
      for (const row of connections.values()) {
        if (!row.authorizationId || row.authorizationId !== auth?.id || !['starting', 'waiting'].includes(row.status)) continue;
        if (['starting', 'waiting'].includes(auth.status)) { row.status = auth.status; continue; }
        try {
          if (auth.status !== 'connected') throw Error(auth.message || 'Google sign-in did not finish.');
          if (accountKey(row) !== accountKey(auth)) throw Error('Google connected a different account.');
          await access.grantSession(row.sessionId, row.projectId, row, row.policy);
          row.status = 'connected'; row.message = `${row.email} is connected and allowed for ${row.sessionName} in ${row.projectName}.`;
        } catch (error) { row.status = auth.status === 'cancelled' ? 'cancelled' : 'failed'; row.message = errorMessage(error); }
        delete row.policy;
      }
    });
    return settling;
  };
  const snapshot = async (check = false) => {
    const state = await service.status(check);
    if (state.accountsLoaded) access.migrate(state.accounts);
    const permissions = await access.snapshot();
    return { ...state, setup: service.current().setup, ...permissions, connectionRequests: connectionRows() };
  };
  service.onChange(() => {
    const current = service.current(), waiting = ['starting', 'waiting'].includes(current.setup.authorization?.status);
    const auth = current.setup.authorization, caller = auth && setupCallers.get(auth.id);
    if (caller && !waiting) {
      setupCallers.delete(auth.id);
      if (auth.status === 'failed') api.reportError(caller, `google-auth:${auth.id}`, `Google sign-in for ${auth.email} failed: ${auth.message}. Inspect google/status, then repair the setup.`)
        .catch(error => api.log('Could not deliver Google sign-in failure:', errorMessage(error)));
    }
    settleConnections().then(() => waiting ? access.snapshot().then(state => ({ ...service.current(), ...state, connectionRequests: connectionRows() })) : snapshot(false)).then(state => api.sendToClients('updated', state))
      .catch(error => api.sendToClients('updated', { ...service.current(), error: errorMessage(error) }));
  });
  const command = handler => async context => {
    try {
      await access.assert(context.sessionId);
      if (access.value.version !== 2) {
        const state = await snapshot();
        if (!state.accountsLoaded) throw Error(state.error || 'Could not read Google accounts.');
      }
      await access.assert(context.sessionId);
      return await handler(context);
    }
    catch (error) { return { stdout: '', stderr: `Google Workspace: ${error.message}\n`, exitCode: 1 }; }
  };
  const agentSnapshot = async (sessionId, check = false) => {
    const state = await service.status(check), { accounts, session } = await access.allowed(sessionId);
    const allowed = new Set(accounts.map(accountKey));
    const visibleAccounts = state.accounts.filter(account => allowed.has(accountKey(account)));
    const defaults = access.value.defaults.filter(row => row.projectId === (session.projectId || null) && allowed.has(accountKey(row)));
    const preferred = visibleAccounts.length === 1 ? visibleAccounts[0] : defaults[0];
    const auth = state.setup.authorization;
    return { ...state, accounts: visibleAccounts, error: state.accountsLoaded ? (visibleAccounts.some(account => account.valid === false || account.error) ? 'A Google connection needs attention.' : '') : state.error,
      defaults: { account: preferred?.email || '', client: preferred?.client || '' },
      setup: { ...state.setup, clients: state.setup.clients.filter(client => accounts.some(account => account.client === client.name)),
        authorization: auth && allowed.has(accountKey(auth)) ? auth : null },
    };
  };
  api.registerCommand('status', command(async ({ args, sessionId }) => {
    if (args.length > 1 || args.length && args[0] !== '--check') throw Error('Use google/status [--check].');
    const state = await agentSnapshot(sessionId, args[0] === '--check');
    return { stdout: JSON.stringify(state, null, 2) + '\n', stderr: state.error ? `Google Workspace: ${state.error}\n` : '', exitCode: state.error ? 1 : 0 };
  }));
  api.registerCommand('help', command(context => service.run(context, true)));
  api.registerCommand('run', command(async context => {
    const parsed = scopedArgs(context.args), identity = await access.resolve(context.sessionId, parsed.requested);
    return service.run({ ...context, args: parsed.args, identity });
  }));
  const authorizedSetup = command(async ({ args, stdin = '', sessionId }) => {
    if (args.length !== 1 || !SETUP_ACTIONS.includes(args[0])) throw Error('Use google/setup <credentials-save|credentials-remove|auth-start|auth-cancel|auth-complete|account-remove> with a JSON object on stdin. Use google/status to inspect setup.');
    let fields;
    try { fields = JSON.parse(stdin); } catch { throw Error('Provide setup fields as a JSON object on stdin. Do not put credentials or callback addresses in command arguments.'); }
    if (!fields || typeof fields !== 'object' || Array.isArray(fields)) throw Error('Setup fields must be a JSON object.');
    if (args[0].startsWith('credentials-')) throw Error('Manage shared Google connection files in Google Workspace → Configure.');
    let target = fields;
    if (['auth-cancel', 'auth-complete'].includes(args[0])) {
      target = service.current().setup.authorization;
      if (!target || target.id !== fields.id) throw Error('This Google sign-in is no longer available.');
    }
    const identity = await access.resolve(sessionId, { email: target.email, client: target.client || 'default' });
    await service.setup({ ...fields, email: identity.email, client: identity.client, action: args[0] });
    const state = await agentSnapshot(sessionId), auth = state.setup.authorization;
    if (args[0] === 'auth-start' && ['starting', 'waiting'].includes(auth?.status)) setupCallers.set(auth.id, sessionId);
    const error = state.error || (['auth-start', 'auth-complete'].includes(args[0]) && auth?.status === 'failed' ? auth.message : '');
    return { stdout: JSON.stringify(state, null, 2) + '\n', stderr: error ? `Google Workspace: ${error}\n` : '', exitCode: error ? 1 : 0 };
  });
  api.registerCommand('setup', async context => {
    if (!['connect-request', 'connect-status', 'connect-complete'].includes(context.args[0])) return authorizedSetup(context);
    try {
      if (context.args.length !== 1) throw Error('Use google/setup connect-request|connect-status|connect-complete with JSON on stdin.');
      const fields = JSON.parse(context.stdin || '{}');
      if (!fields || typeof fields !== 'object' || Array.isArray(fields)) throw Error('Provide a JSON object on stdin.');
      const session = await api.getSession(context.sessionId);
      if (!session) throw Error('The calling session is no longer available.');
      let row;
      if (context.args[0] === 'connect-request') {
        if (Object.keys(fields).some(key => !['email', 'services', 'readonly'].includes(key))) throw Error('Use only email, services and readonly for a connection request.');
        const email = emailAddress(fields.email);
        if (!Array.isArray(fields.services) || !fields.services.length || fields.services.length > 30
          || fields.services.some(id => typeof id !== 'string' || !/^[a-z][a-z0-9]*$/.test(id)) || typeof fields.readonly !== 'boolean') throw Error('Specify services and readonly explicitly.');
        const client = text(api.getSetting('client')).trim() || DEFAULT_CLIENT;
        if (fields.services.some(id => !supportsService(client, id))) throw Error('Choose Gmail, Calendar, Drive, Docs or Sheets for the built-in Google connection.');
        row = [...connections.values()].find(item => item.sessionId === context.sessionId && ['pending', 'starting', 'waiting'].includes(item.status));
        if (row) {
          if (row.email !== email || row.readonly !== fields.readonly || JSON.stringify(row.services) !== JSON.stringify([...new Set(fields.services)])) throw Error('This agent already has a connection request. Finish or dismiss it in Google Workspace first.');
        } else {
          const projects = await api.getProjects(), projectId = session.projectId || null;
          const project = projects.find(item => item.id === projectId);
          if (projectId !== null && !project) throw Error('The current project no longer exists.');
          for (const [id, item] of connections) if (item.sessionId === context.sessionId && !['pending', 'starting', 'waiting'].includes(item.status)) connections.delete(id);
          if (connections.size >= 20) throw Error('Too many Google connection requests. Dismiss unused requests in Google Workspace.');
          row = { id: randomUUID(), sessionId: context.sessionId, sessionName: session.name || context.sessionId,
            projectId, projectName: project?.name || projectId || 'No project', email,
            client, services: [...new Set(fields.services)], readonly: fields.readonly,
            status: 'pending', message: 'Approve this connection request in Google Workspace, then sign in with Google. No account access has been granted.' };
          connections.set(row.id, row);
        }
        api.sendToClients('connection-requested', { sessionId: context.sessionId });
        api.sendToClients('updated', { ...service.current(), ...await access.snapshot(), connectionRequests: connectionRows() });
      } else {
        row = connectionFor(fields.id, context.sessionId);
        if (context.args[0] === 'connect-complete') {
          if (!row.authorizationId || !['starting', 'waiting'].includes(row.status)) throw Error('This request is not waiting for Google sign-in.');
          await service.setup({ action: 'auth-complete', id: row.authorizationId, url: fields.url });
        }
        await settleConnections();
      }
      const { policy, ...result } = row;
      // This path never returns accounts, credentials, other requests or OAuth URLs.
      return { stdout: JSON.stringify({ connectionRequest: result }) + '\n', stderr: '', exitCode: row.status === 'failed' ? 1 : 0 };
    } catch (error) { return { stdout: '', stderr: `Google Workspace: ${errorMessage(error)}\n`, exitCode: 1 }; }
  });
  async function approveConnection(id) {
    const row = connectionFor(id);
    if (row.status !== 'pending') throw Error('This connection request has already been handled.');
    row.status = 'starting';
    try {
      const session = await api.getSession(row.sessionId);
      if (!session || (session.projectId || null) !== row.projectId) throw Error('The requesting agent moved or is no longer available. Request the connection again.');
      if ((text(api.getSetting('client')).trim() || DEFAULT_CLIENT) !== row.client) throw Error('The Google connection changed. Request the connection again.');
      const state = await snapshot();
      if (!state.accountsLoaded || access.error) throw Error(state.error || access.error || 'Could not read Google connections.');
      if (row.status !== 'starting') throw Error('Connection request dismissed.');
      row.policy = access.value;
      await service.setup({ action: 'auth-start', email: row.email, client: row.client, services: row.services, readonly: row.readonly });
      const auth = service.current().setup.authorization;
      if (!auth || accountKey(auth) !== accountKey(row)) throw Error('Google sign-in did not start for this request.');
      row.authorizationId = auth.id;
      if (row.status === 'cancelled') { await service.setup({ action: 'auth-cancel', id: auth.id }); return; }
      await settleConnections();
    } catch (error) { if (row.status !== 'cancelled') row.status = 'failed'; row.message = errorMessage(error); delete row.policy; throw error; }
  }
  api.onClientMessage('request' , async (request, context) => {
    if (!request || typeof request.requestId !== 'string' || request.requestId.length > 200) return;
    try {
      if (!['status', 'check', 'access-save', 'connect-approve', 'connect-dismiss', ...SETUP_ACTIONS].includes(request.action)) throw Error('Unknown Google Workspace action.');
      if (request.action === 'access-save') await access.save(request.access);
      else if (request.action === 'connect-approve') await approveConnection(request.id);
      else if (request.action === 'connect-dismiss') {
        const row = connectionFor(request.id);
        if (row.authorizationId && ['starting', 'waiting'].includes(row.status)) await service.setup({ action: 'auth-cancel', id: row.authorizationId });
        row.status = 'cancelled'; row.message = 'Connection request dismissed.'; delete row.policy; connections.delete(row.id);
      }
      else if (!['status', 'check'].includes(request.action)) {
        // Freeze legacy access before a newly connected account can appear.
        if (access.value.version !== 2) {
          const state = await snapshot();
          if (!state.accountsLoaded) throw Error(state.error || 'Could not read Google accounts.');
        }
        await service.setup(request);
      }
      // Saving access must not start or wait for a dependency download.
      const signingIn = ['starting', 'waiting'].includes(service.current().setup.authorization?.status);
      const state = request.action === 'access-save' ? { ...service.current(), ...await access.snapshot(), connectionRequests: connectionRows() }
        : await snapshot(request.action === 'check' && !signingIn);
      context.reply('result', { requestId: request.requestId, ok: true, ...state });
      if (request.action !== 'status') api.sendToClients('updated', state);
    } catch (error) { context.reply('result', { requestId: request.requestId, ok: false, message: errorMessage(error) }); }
  });
  api.onSettingsChange(async () => api.sendToClients('updated', await snapshot(false)));
  api.onShutdown(service.close);
  return service;
}

module.exports = { activate, createService, commandArgs, scopedArgs };
