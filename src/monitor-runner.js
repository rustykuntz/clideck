const { spawn } = require('node:child_process');

const MAX_OUTPUT = 64 * 1024;
// Monitors are short checks, not background job launchers. Each check gets its
// own process group so timeout, pause and shutdown affect only its children.
function runMonitorCommand({ command, cwd, env, signal, timeoutMs = 30_000 }) {
  if (!['darwin', 'linux'].includes(process.platform)) return Promise.reject(new Error('Monitors currently support macOS and Linux.'));
  if (signal?.aborted) return Promise.reject(new Error('Check cancelled.'));
  return new Promise((resolve, reject) => {
    const child = spawn('/bin/sh', ['-c', command], {
      cwd, env, detached: true, stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = [], stderr = [], bytes = 0, failure = null;
    const kill = () => {
      if (!child.pid) return;
      try { process.kill(-child.pid, 'SIGKILL'); }
      catch (error) { if (error.code !== 'ESRCH') failure ||= error; }
    };
    const cancel = () => { failure ||= new Error('Check cancelled.'); kill(); };
    signal?.addEventListener('abort', cancel, { once: true });
    const timer = setTimeout(() => { failure ||= new Error('Check exceeded its 30 second time limit.'); kill(); }, timeoutMs);
    timer.unref?.();
    const collect = target => chunk => {
      bytes += chunk.length;
      if (bytes <= MAX_OUTPUT) target.push(chunk);
      else { failure ||= new Error('Check output exceeded 64 KiB; narrow the command output.'); kill(); }
    };
    child.stdout.on('data', collect(stdout));
    child.stderr.on('data', collect(stderr));
    child.on('error', error => { failure ||= error; });
    child.on('close', code => {
      clearTimeout(timer);
      signal?.removeEventListener('abort', cancel);
      kill(); // Also clean up a command that backgrounded a child with closed pipes.
      if (failure) reject(failure);
      else resolve({ code, stdout: Buffer.concat(stdout).toString('utf8'), stderr: Buffer.concat(stderr).toString('utf8') });
    });
  });
}

module.exports = { runMonitorCommand, MAX_OUTPUT };
