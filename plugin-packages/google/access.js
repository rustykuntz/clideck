const fs = require('node:fs');
const { join } = require('node:path');
const { randomUUID } = require('node:crypto');

const validId = id => typeof id === 'string' && id.length > 0 && id.length <= 200 && !id.includes('\0');
const keys = (value, allowed) => value && typeof value === 'object' && !Array.isArray(value)
  && Object.keys(value).every(key => allowed.includes(key));

function normalizePolicy(value) {
  if (!keys(value, ['mode', 'projects']) || !['all', 'selected'].includes(value.mode)
    || !Array.isArray(value.projects) || value.projects.length > 200) throw Error('Choose All projects or Selected projects.');
  if (value.mode === 'all') return { mode: 'all', projects: [] };
  const seen = new Set();
  const projects = value.projects.map(row => {
    if (!keys(row, ['projectId', 'agents', 'sessionIds']) || !(row.projectId === null || validId(row.projectId))
      || !['all', 'selected'].includes(row.agents) || !Array.isArray(row.sessionIds) || row.sessionIds.length > 1000
      || row.sessionIds.some(id => !validId(id)) || new Set(row.sessionIds).size !== row.sessionIds.length
      || seen.has(row.projectId)) throw Error('Each project needs one valid choice of all agents or selected agents.');
    seen.add(row.projectId);
    return { projectId: row.projectId, agents: row.agents, sessionIds: row.agents === 'all' ? [] : [...row.sessionIds] };
  });
  const result = { mode: 'selected', projects };
  if (Buffer.byteLength(JSON.stringify(result)) > 128 * 1024) throw Error('Too many access selections.');
  return result;
}

const accountKey = value => JSON.stringify([value.client || 'default', value.email.toLowerCase()]);
function identity(value) {
  if (typeof value.email !== 'string' || value.email.length > 254 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value.email)
    || value.email.startsWith('-') || typeof value.client !== 'string' || !/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}$/.test(value.client)
    || value.client.toLowerCase() === 'all') throw Error('Choose a valid Google account and connection.');
  return { email: value.email.toLowerCase(), client: value.client.toLowerCase() };
}
function normalize(value) {
  if (value?.version !== 2) return normalizePolicy(value);
  if (!keys(value, ['version', 'accounts', 'defaults']) || !Array.isArray(value.accounts) || value.accounts.length > 200
    || !Array.isArray(value.defaults) || value.defaults.length > 200) throw Error('Choose account access and project defaults.');
  const seen = new Set();
  const accounts = value.accounts.map(row => {
    if (!keys(row, ['email', 'client', 'mode', 'projects'])) throw Error('Invalid account access.');
    const account = identity(row), key = accountKey(account);
    if (seen.has(key)) throw Error('Choose access once for each Google account.');
    seen.add(key);
    return { ...account, ...normalizePolicy({ mode: row.mode, projects: row.projects }) };
  });
  const projects = new Set();
  const defaults = value.defaults.map(row => {
    if (!keys(row, ['projectId', 'email', 'client']) || !(row.projectId === null || validId(row.projectId)) || projects.has(row.projectId)) throw Error('Choose one default account per project.');
    projects.add(row.projectId);
    const account = identity(row), rule = accounts.find(item => accountKey(item) === accountKey(account));
    if (!rule || !(rule.mode === 'all' || rule.projects.some(item => item.projectId === row.projectId && (item.agents === 'all' || item.sessionIds.length)))) throw Error('The default account must be allowed in its project.');
    return { projectId: row.projectId, ...account };
  });
  const result = { version: 2, accounts, defaults };
  if (Buffer.byteLength(JSON.stringify(result)) > 128 * 1024) throw Error('Too many access selections.');
  return result;
}
const permits = (policy, session, projects) => policy.mode === 'all' || policy.projects.some(row => row.projectId === (session.projectId || null)
  && (row.projectId === null || projects.some(project => project.id === row.projectId))
  && (row.agents === 'all' || row.sessionIds.includes(session.sessionId)));

class Access {
  constructor(api) {
    this.api = api; this.path = join(api.dataDir, 'access.json'); this.error = '';
    this.value = { mode: 'all', projects: [] };
    try {
      if (fs.statSync(this.path).size > 128 * 1024) throw Error('too large');
      this.value = normalize(JSON.parse(fs.readFileSync(this.path, 'utf8')));
    } catch (error) {
      if (error.code !== 'ENOENT') {
        this.value = { version: 2, accounts: [], defaults: [] };
        this.error = 'Cannot read Google Workspace access settings. Agent commands are blocked; choose access and Save in the plugin to repair them.';
      }
    }
  }
  async snapshot() {
    const [projects, sessions] = await Promise.all([this.api.getProjects(), this.api.getSessions()]);
    const groups = [...projects.map(project => ({ id: project.id, name: project.name || project.id })), { id: null, name: 'No project' }];
    return { access: structuredClone(this.value), accessError: this.error,
      accessOptions: groups.map(project => ({ ...project, sessions: sessions.filter(session => (session.projectId || null) === project.id)
        .map(session => ({ id: session.sessionId, name: session.name || session.sessionId, provider: session.provider, live: session.live === true })) })) };
  }
  async save(value) {
    const next = normalize(value);
    if (this.value.version === 2 && next.version !== 2) throw Error('Refresh Google Workspace before saving account access.');
    const { accessOptions } = await this.snapshot();
    for (const policy of next.version === 2 ? next.accounts : [next]) {
      for (const row of policy.projects) {
        const project = accessOptions.find(project => project.id === row.projectId);
        if (!project) throw Error('A selected project no longer exists. Refresh and choose again.');
        if (row.sessionIds.some(id => !project.sessions.some(session => session.id === id))) {
          throw Error('A selected agent no longer belongs to that project. Refresh and choose again.');
        }
      }
    }
    if (next.defaults?.some(row => !accessOptions.some(project => project.id === row.projectId))) throw Error('A default project no longer exists.');
    this.write(next);
  }
  write(next) {
    const temporary = `${this.path}.${randomUUID()}.tmp`;
    try {
      const fd = fs.openSync(temporary, 'wx', 0o600);
      try { fs.writeFileSync(fd, JSON.stringify(next) + '\n'); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
      fs.renameSync(temporary, this.path);
    } catch {
      try { fs.unlinkSync(temporary); } catch {}
      throw Error('Cannot save Google Workspace access settings. Previous access is unchanged; check CliDeck storage.');
    }
    this.value = next; this.error = '';
  }
  migrate(accounts) {
    if (this.error || this.value.version === 2) return;
    this.write(normalize({ version: 2, accounts: accounts.map(account => ({ ...identity(account), ...this.value })), defaults: [] }));
  }
  async grantSession(sessionId, projectId, account, expectedPolicy) {
    const [session, projects] = await Promise.all([this.api.getSession(sessionId), this.api.getProjects()]);
    if (!session || (session.projectId || null) !== projectId || projectId !== null && !projects.some(row => row.id === projectId)) {
      throw Error('The requesting agent moved or is no longer available. Request the connection again.');
    }
    if (this.error || this.value.version !== 2 || this.value !== expectedPolicy) throw Error('Agent access changed during sign-in. Review access in Google Workspace.');
    const next = structuredClone(this.value), key = accountKey(account);
    let rule = next.accounts.find(row => accountKey(row) === key);
    if (!rule) { rule = { ...identity(account), mode: 'selected', projects: [] }; next.accounts.push(rule); }
    if (rule.mode !== 'all') {
      let project = rule.projects.find(row => row.projectId === projectId);
      if (!project) { project = { projectId, agents: 'selected', sessionIds: [] }; rule.projects.push(project); }
      if (project.agents !== 'all' && !project.sessionIds.includes(sessionId)) project.sessionIds.push(sessionId);
    }
    this.write(normalize(next));
  }
  async allowed(sessionId) {
    if (this.error) throw Error(this.error);
    const [session, projects] = await Promise.all([this.api.getSession(sessionId), this.api.getProjects()]);
    if (!session) throw Error('The calling session is no longer available.');
    if (this.error) throw Error(this.error);
    if (this.value.version !== 2) {
      if (permits(this.value, session, projects)) return { session, accounts: null };
    } else {
      const accounts = this.value.accounts.filter(row => permits(row, session, projects));
      if (accounts.length) return { session, accounts };
    }
    throw Error('Google Workspace is not enabled for this agent in this project. For user-requested onboarding, use google/setup connect-request with email, services and readonly on stdin; otherwise ask the user to allow an account in Google Workspace → Agent access.');
  }
  async assert(sessionId) { return (await this.allowed(sessionId)).session; }
  async resolve(sessionId, requested = {}) {
    const { session, accounts } = await this.allowed(sessionId);
    if (!accounts) throw Error('Open Google Workspace → Configure to migrate account access.');
    let choices = accounts.filter(row => (!requested.email || row.email === requested.email.toLowerCase()) && (!requested.client || row.client === requested.client.toLowerCase()));
    if (!choices.length) throw Error('This Google account is not allowed for this agent in this project.');
    if (choices.length > 1 && !requested.email) {
      const preferred = this.value.defaults.find(row => row.projectId === (session.projectId || null));
      if (preferred) choices = choices.filter(row => accountKey(row) === accountKey(preferred));
    }
    if (choices.length !== 1) throw Error('Multiple Google accounts are allowed. Choose --account (and --client if needed), or set a project default in Google Workspace.');
    return { email: choices[0].email, client: choices[0].client };
  }
}

module.exports = { Access, normalize, accountKey };
