// Install only into the verified npm global installation running this engine.
const { spawn, execFile } = require('child_process');
const fs = require('fs');
const { dirname, join } = require('path');

const REGISTRY = 'https://registry.npmjs.org';
const PACKAGE_ROOT = join(__dirname, '..');

function runNpm(node, cli, args, timeout = 10_000) {
  return new Promise((resolve, reject) => {
    const child = spawn(node, [cli, ...args], {
      cwd: dirname(cli), detached: process.platform !== 'win32',
      stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true,
    });
    let output = '', bytes = 0, error = null, closed = false, killing = false;
    const finish = () => {
      if (!closed || killing) return;
      clearTimeout(timer);
      if (error) reject(error);
      else resolve(output.trim());
    };
    child.stdout.on('data', chunk => {
      bytes += chunk.length;
      if (bytes <= 1024 * 1024) output += chunk.toString();
      else error ||= new Error('npm output exceeded the limit');
    });
    child.stderr.on('data', () => {}); // Drain without retaining credentials or unbounded output.
    child.on('error', cause => { error = cause; });
    child.on('close', code => {
      closed = true;
      if (code !== 0) error ||= new Error('npm failed');
      finish();
    });
    const timer = setTimeout(() => {
      error = new Error('npm timed out');
      if (process.platform === 'win32') {
        killing = true;
        execFile(join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'taskkill.exe'),
          ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true }, () => {
            killing = false;
            finish();
          });
      } else {
        // npm lifecycle scripts share this isolated group; never kill by a process name.
        try { process.kill(-child.pid, 'SIGKILL'); } catch (cause) {
          if (cause.code !== 'ESRCH') error = cause;
        }
      }
    }, timeout);
    timer.unref?.();
  });
}

function npmCli(node) {
  try { node = fs.realpathSync(node); } catch { return ''; }
  const candidates = [
    join(dirname(node), 'node_modules/npm/bin/npm-cli.js'),
    join(dirname(node), '../lib/node_modules/npm/bin/npm-cli.js'),
    // Debian/Ubuntu distribute npm here beside /usr/bin/node.
    join(dirname(node), '../share/nodejs/npm/bin/npm-cli.js'),
  ];
  // Homebrew may keep Node in its Cellar while npm is linked at the stable prefix.
  const brew = node.match(/^(.*)\/Cellar\/node(?:@\d+)?\/[^/]+\/bin\/node$/);
  if (brew) candidates.push(join(brew[1], 'lib/node_modules/npm/bin/npm-cli.js'));
  for (const path of candidates) {
    try {
      const resolved = fs.realpathSync(path);
      if (resolved.replace(/\\/g, '/').endsWith('/npm/bin/npm-cli.js')) return resolved;
    } catch {}
  }
  return '';
}

function createUpdateInstaller({ root = PACKAGE_ROOT, node = process.execPath, run = runNpm,
  findNpm = npmCli, distribution = process.env.CLIDECK_DESKTOP_ENGINE === '1' ? 'desktop' : 'npm' } = {}) {
  const source = fs.existsSync(join(root, '.git'));
  async function target() {
    if (source) throw new Error('source');
    if (JSON.parse(fs.readFileSync(join(root, 'package.json'), 'utf8')).name !== 'clideck') throw new Error('package');
    const cli = findNpm(node);
    if (!cli) throw new Error('npm');
    const globalRoot = await run(node, cli, ['root', '--global']);
    if (fs.realpathSync(join(globalRoot, 'clideck')) !== fs.realpathSync(root)) throw new Error('different installation');
    const prefix = await run(node, cli, ['prefix', '--global']);
    // Verify the explicit destination too: npm configuration can override defaults.
    const explicitRoot = await run(node, cli, ['root', '--global', '--prefix', prefix]);
    if (fs.realpathSync(join(explicitRoot, 'clideck')) !== fs.realpathSync(root)) throw new Error('different prefix');
    return { cli, prefix };
  }
  return {
    async capability() {
      if (distribution === 'desktop') return { canInstall: false,
        instruction: 'Update the CliDeck desktop app. Restart the engine when your running sessions are finished.' };
      if (source) return { canInstall: false, instruction: 'Update your source checkout, then restart CliDeck.' };
      try { await target(); return { canInstall: true }; }
      catch { return { canInstall: false, instruction: 'Run npm install -g clideck@latest, then restart CliDeck.' }; }
    },
    async install(version) {
      if (distribution === 'desktop') throw new Error('Bundled engines are updated with the CliDeck desktop app.');
      if (!/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.test(version)) throw new Error('Invalid update version.');
      try {
        const { cli, prefix } = await target();
        await run(node, cli, ['install', '--global', '--prefix', prefix,
          'clideck@' + version, '--registry', REGISTRY, '--no-audit', '--no-fund'], 300_000);
        const installed = JSON.parse(fs.readFileSync(join(root, 'package.json'), 'utf8'));
        if (installed.name !== 'clideck' || installed.version !== version) throw new Error('version mismatch');
      } catch {
        throw new Error('The update could not be completed. Run npm install -g clideck@' + version + ' in your terminal, then restart CliDeck.');
      }
    },
  };
}

module.exports = { createUpdateInstaller, runNpm, npmCli };
