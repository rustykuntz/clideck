const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const http = require('node:http');
const net = require('node:net');
const { spawn, execFile } = require('node:child_process');
const { promisify } = require('node:util');
const { localEngineUrl } = require('./policy.cjs');

const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
function alive(pid) {
  if (!Number.isInteger(pid) || pid < 1) return false;
  try { process.kill(pid, 0); return true; } catch (error) { return error.code === 'EPERM'; }
}
function readLock(dataDir) {
  try { return JSON.parse(fs.readFileSync(path.join(dataDir, 'server.lock'), 'utf8')); } catch { return null; }
}
async function preferredPort(dataDir, previous) {
  let port = previous?.port;
  if (!port) {
    try { port = JSON.parse(await fsp.readFile(path.join(dataDir, 'desktop-engine.json'), 'utf8')).port; } catch {}
  }
  if (!Number.isInteger(port) || port < 1 || port > 65535) return 0;
  return new Promise(resolve => {
    const server = net.createServer();
    server.once('error', () => resolve(0));
    server.listen(port, '127.0.0.1', () => server.close(() => resolve(port)));
  });
}
function probe(url) {
  return new Promise(resolve => {
    if (!localEngineUrl(url)) return resolve(false);
    const request = http.get(new URL('/api/ui-version', url), { timeout: 1500 }, response => {
      let body = ''; response.setEncoding('utf8');
      response.on('data', chunk => { body += chunk; if (body.length > 16384) response.destroy(); });
      response.on('error', () => resolve(false));
      response.on('end', () => {
        try { const value = JSON.parse(body); resolve(response.statusCode === 200 && typeof value.version === 'string'); }
        catch { resolve(false); }
      });
    });
    request.on('timeout', () => request.destroy()); request.on('error', () => resolve(false));
  });
}

async function loginEnvironment(env = process.env) {
  let result = { ...env };
  if (process.platform !== 'win32') {
    try {
      const { stdout } = await promisify(execFile)(env.SHELL || '/bin/zsh', ['-ilc', '/usr/bin/env -0'], {
        env, encoding: 'utf8', timeout: 5000, maxBuffer: 1024 * 1024,
      });
      for (const item of stdout.split('\0')) {
        const match = /^([A-Za-z_][A-Za-z0-9_]*)=([\s\S]*)$/.exec(item);
        if (match) result[match[1]] = match[2];
      }
    } catch { /* Shell startup must not prevent the app from launching. */ }
  }
  for (const key of ['ELECTRON_RUN_AS_NODE', 'ELECTRON_NO_ASAR', 'CLIDECK_SESSION_ID', 'CLIDECK_NEXT_SESSION_ID',
    'CLIDECK_URL', 'CLIDECK_MONITOR_ID', 'CLIDECK_PORT', 'NODE_CHANNEL_FD', 'NODE_CHANNEL_SERIALIZATION_MODE']) delete result[key];
  return result;
}

// Keep each packaged runtime at an immutable path outside the .app. App replacement
// or window closure must not remove code still used by agents and plugin workers.
async function packagedRuntime(resources, profile) {
  const source = path.join(resources, 'runtime');
  const manifest = JSON.parse(await fsp.readFile(path.join(source, 'manifest.json'), 'utf8'));
  if (!/^[a-f0-9]{64}$/.test(manifest.id)) throw new Error('Invalid packaged engine manifest.');
  const directory = path.join(profile, 'runtimes', manifest.id);
  if (!fs.existsSync(path.join(directory, '.ready'))) {
    await fsp.mkdir(path.dirname(directory), { recursive: true, mode: 0o700 });
    const temporary = `${directory}.${process.pid}.tmp`;
    await fsp.rm(temporary, { recursive: true, force: true });
    try {
      await fsp.cp(source, temporary, { recursive: true, mode: fs.constants.COPYFILE_FICLONE });
      await fsp.writeFile(path.join(temporary, '.ready'), manifest.id, { mode: 0o600 });
      await fsp.rename(temporary, directory);
    } catch (error) { await fsp.rm(temporary, { recursive: true, force: true }); throw error; }
  }
  return { root: path.join(directory, 'engine'), node: path.join(directory, 'bin', process.platform === 'win32' ? 'node.exe' : 'node') };
}

class Engine {
  constructor({ dataDir, profile, runtime, environment = loginEnvironment, onState = () => {}, timeout = 30000 }) {
    Object.assign(this, { dataDir, profile, runtime, environment, onState, timeout });
    this.state = { state: 'starting', url: '', logPath: path.join(profile, 'logs', 'engine.log') };
    this.pending = null; this.healthPending = false; this.healthFailures = 0;
  }
  publish(value) { this.state = { ...this.state, ...value }; this.onState(this.state); return this.state; }
  start() {
    if (this.pending) return this.pending;
    this.pending = this.connect().catch(error => this.publish({ state: 'error', error: error.message }))
      .finally(() => { this.pending = null; });
    return this.pending;
  }
  async connect() {
    this.publish({ state: this.state.url ? 'reconnecting' : 'starting', error: undefined });
    const existing = readLock(this.dataDir);
    let spawned = null;
    if (!(existing && alive(existing.pid))) {
      const runtime = await this.runtime();
      const env = await this.environment();
      const port = await preferredPort(this.dataDir, existing);
      env.PATH = [path.dirname(runtime.node), env.PATH || ''].join(path.delimiter);
      env.CLIDECK_DESKTOP_ENGINE = '1';
      await fsp.mkdir(path.dirname(this.state.logPath), { recursive: true, mode: 0o700 });
      const output = fs.openSync(this.state.logPath, 'a', 0o600);
      try {
        spawned = spawn(runtime.node, [path.join(runtime.root, 'src', 'server.js'), '--port', String(port),
          '--host', '127.0.0.1', '--data-dir', this.dataDir, '--cwd', os.homedir()], {
          cwd: runtime.root, env, detached: true, windowsHide: true, stdio: ['ignore', output, output],
        });
        await new Promise((resolve, reject) => { spawned.once('spawn', resolve); spawned.once('error', reject); });
        spawned.unref();
      } finally { fs.closeSync(output); }
    }
    const deadline = Date.now() + this.timeout;
    do {
      const lock = readLock(this.dataDir);
      if (lock && alive(lock.pid) && localEngineUrl(lock.url) && await probe(lock.url)) {
        const saved = path.join(this.dataDir, 'desktop-engine.json');
        await fsp.writeFile(saved + `.${process.pid}.tmp`, JSON.stringify({ port: Number(new URL(lock.url).port) }), { mode: 0o600 });
        await fsp.rename(saved + `.${process.pid}.tmp`, saved);
        return this.publish({ state: 'ready', url: lock.url, pid: lock.pid, reused: !spawned || lock.pid !== spawned.pid, error: undefined });
      }
      if (spawned && !alive(spawned.pid)) throw new Error('The engine could not start. Open its log for details.');
      await delay(150);
    } while (Date.now() < deadline);
    throw new Error(existing && alive(existing.pid)
      ? 'An engine is already running but is not responding. It was left running to protect your sessions.'
      : 'The engine is taking longer than expected. Check its log, then retry.');
  }
  async check() {
    if (this.pending || this.healthPending || !this.state.url) return;
    this.healthPending = true;
    try {
      const lock = readLock(this.dataDir);
      if (lock && alive(lock.pid) && localEngineUrl(lock.url) && await probe(lock.url)) {
        this.healthFailures = 0;
        if (this.state.state !== 'ready' || lock.url !== this.state.url) this.publish({ state: 'ready', url: lock.url, pid: lock.pid, error: undefined });
      } else {
        this.healthFailures++;
        const stopped = !lock || !alive(lock.pid);
        const state = stopped || this.healthFailures >= 3 ? 'error' : 'reconnecting';
        if (this.state.state !== state) this.publish({ state, error: stopped
          ? 'The engine has stopped. Start it again to access your saved sessions.'
          : 'The engine is not responding. Your sessions were left running; check its log before retrying.' });
      }
    } finally { this.healthPending = false; }
  }
}
module.exports = { Engine, probe, alive, readLock, loginEnvironment, packagedRuntime, preferredPort };
