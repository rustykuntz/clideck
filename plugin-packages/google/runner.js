const { spawn } = require('node:child_process');
const { access, stat } = require('node:fs/promises');
const { constants } = require('node:fs');
const { homedir } = require('node:os');
const { delimiter, isAbsolute, join } = require('node:path');

const MAX_OUTPUT = 256 * 1024;

async function findGog(configured = '', env = process.env, home = homedir()) {
  const path = String(configured).trim();
  if (path && (!isAbsolute(path) || path.includes('\0'))) throw Error('Enter the full path to the gog executable in plugin settings.');
  const name = process.platform === 'win32' ? 'gog.exe' : 'gog';
  const candidates = path ? [path] : [...new Set([
    ...(env.PATH || '').split(delimiter).filter(isAbsolute).map(dir => join(dir, name)),
    join(home, '.local', 'bin', name), '/opt/homebrew/bin/gog', '/usr/local/bin/gog',
  ])];
  for (const candidate of candidates) {
    try { await access(candidate, constants.X_OK); if ((await stat(candidate)).isFile()) return candidate; } catch {}
  }
  throw Object.assign(Error(path ? `Cannot run gog at ${path}. Check its location, or clear it to use automatic installation.`
    : 'gog was not found.'), { code: path ? 'GOG_PATH' : 'GOG_NOT_FOUND' });
}

// One child per command, no shell and no retries. A failed write may already have
// reached Google, so interrupted/oversized results must never look successful.
function createRunner({ env = process.env, maxOutput = MAX_OUTPUT, timeoutMs = 120_000 } = {}) {
  const active = new Set();
  let closing = false;
  function run(executable, args, { cwd, stdin = '', timeout = timeoutMs, signal, onStderr } = {}) {
    if (closing) throw Error('Google Workspace is stopping.');
    if (signal?.aborted) return Promise.resolve({ stdout: '', stderr: 'Google sign-in cancelled.\n', exitCode: 130 });
    if (active.size >= 4) throw Error('Google Workspace is busy. Wait for an existing command to finish.');
    if (!Array.isArray(args) || args.length > 512 || args.some(arg => typeof arg !== 'string' || arg.includes('\0'))
      || (typeof stdin !== 'function' && (typeof stdin !== 'string' || Buffer.byteLength(stdin) > 1024 * 1024))) throw Error('Invalid gog arguments or stdin.');
    const child = spawn(executable, args, { cwd, env, shell: false, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
    const job = { child, stop: null, done: null };
    active.add(job);
    job.done = new Promise(resolve => {
      const out = [], err = [];
      let bytes = 0, failure = null, killTimer;
      const stop = (message, exitCode = 1) => {
        if (failure) return;
        failure = { message, exitCode };
        child.kill('SIGTERM');
        killTimer = setTimeout(() => { if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL'); }, 250);
        killTimer.unref();
      };
      job.stop = stop;
      const abort = () => stop('Google sign-in cancelled.', 130);
      signal?.addEventListener('abort', abort, { once: true });
      const timer = setTimeout(() => stop('gog took too long. Check whether the operation completed before retrying.', 124), timeout);
      timer.unref();
      const collect = (target, observe) => chunk => {
        if (failure) return;
        bytes += chunk.length;
        if (bytes > maxOutput) stop('gog output exceeded 256 KB. Use a smaller --max, narrower query or --fields. Check whether any write completed before retrying.');
        else {
          target.push(chunk);
          try { observe?.(chunk.toString('utf8')); }
          catch { stop('Could not read the Google sign-in response.'); }
        }
      };
      child.stdout.on('data', collect(out)); child.stderr.on('data', collect(err, onStderr));
      child.on('error', error => { failure ||= { message: `Could not start gog: ${error.message}`, exitCode: 1 }; });
      child.stdin.on('error', error => { if (error.code !== 'EPIPE') stop(`Could not send stdin to gog: ${error.message}`); });
      child.on('close', (code, exitSignal) => {
        clearTimeout(timer); clearTimeout(killTimer); active.delete(job);
        signal?.removeEventListener('abort', abort);
        if (failure) return resolve({ stdout: '', stderr: `Google Workspace: ${failure.message}\n`, exitCode: failure.exitCode });
        const result = { stdout: Buffer.concat(out).toString('utf8'), stderr: Buffer.concat(err).toString('utf8'), exitCode: code ?? 130 };
        if (exitSignal) result.stderr += `\ngog stopped (${exitSignal}). Check whether the operation completed before retrying.\n`;
        if (Buffer.byteLength(JSON.stringify(result)) > 900 * 1024) {
          return resolve({ stdout: '', stderr: 'Google Workspace: output is too large to return. Narrow the query; check any write before retrying.\n', exitCode: 1 });
        }
        resolve(result);
      });
      // Setup can wait for the browser callback while gog prints its sign-in URL.
      // The response still travels through stdin, never through process arguments.
      if (typeof stdin === 'function') {
        Promise.resolve().then(stdin).then(value => {
          if (failure || child.exitCode !== null || child.signalCode !== null) return;
          if (typeof value !== 'string' || Buffer.byteLength(value) > 1024 * 1024) return stop('Invalid gog stdin.');
          child.stdin.end(value);
        }, () => { if (child.exitCode === null && child.signalCode === null) stop('Could not provide Google sign-in response.'); });
      } else child.stdin.end(stdin);
    });
    return job.done;
  }
  async function close() {
    closing = true;
    const jobs = [...active];
    for (const job of jobs) job.stop('Plugin disabled while gog was running. Check whether the operation completed before retrying.', 130);
    await Promise.all(jobs.map(job => job.done));
  }
  return { run, close };
}

module.exports = { findGog, createRunner };
