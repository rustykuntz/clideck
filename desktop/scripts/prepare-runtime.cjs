// Run on the target OS/architecture with a supported Node LTS installation.
// Package only npm's allowlisted engine files; never copy the repository wholesale.
const fs = require('node:fs/promises');
const sync = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { createHash } = require('node:crypto');

async function main() {
  if (Number(process.versions.node.split('.')[0]) < 22) throw new Error('Build with Node 22.12+ (Node 24 LTS recommended).');
  const root = path.resolve(__dirname, '../..');
  const output = path.join(root, 'desktop', '.staging', 'runtime');
  const engine = path.join(output, 'engine');
  const npm = process.env.npm_execpath || [
    path.join(path.dirname(process.execPath), '../lib/node_modules/npm/bin/npm-cli.js'),
    path.join(path.dirname(process.execPath), 'node_modules/npm/bin/npm-cli.js'),
  ].find(value => sync.existsSync(value));
  if (!npm) throw new Error('npm is required to prepare the bundled engine.');
  const env = { ...process.env, PATH: [path.dirname(process.execPath), process.env.PATH || ''].join(path.delimiter) };
  const runNpm = (args, cwd, json = false) => execFileSync(process.execPath, [npm, ...args], {
    cwd, env, encoding: 'utf8', maxBuffer: 16 * 1024 * 1024, stdio: json ? ['ignore', 'pipe', 'inherit'] : 'inherit',
  });
  const [packed] = JSON.parse(runNpm(['pack', '--dry-run', '--json', '--ignore-scripts'], root, true));
  await fs.rm(output, { recursive: true, force: true });
  await fs.mkdir(engine, { recursive: true });
  for (const file of packed.files) {
    const source = path.resolve(root, file.path);
    if (!source.startsWith(root + path.sep)) throw new Error('Invalid package path.');
    const target = path.join(engine, file.path);
    await fs.mkdir(path.dirname(target), { recursive: true });
    await fs.copyFile(source, target); await fs.chmod(target, file.mode);
  }
  await fs.copyFile(path.join(root, 'package-lock.json'), path.join(engine, 'package-lock.json'));
  runNpm(['ci', '--omit=dev', '--no-audit', '--no-fund'], engine);
  const bin = path.join(output, 'bin'); await fs.mkdir(bin);
  await fs.copyFile(process.execPath, path.join(bin, process.platform === 'win32' ? 'node.exe' : 'node'));
  await fs.chmod(path.join(bin, process.platform === 'win32' ? 'node.exe' : 'node'), 0o755);
  const nodeLicense = [
    path.join(path.dirname(process.execPath), '../LICENSE'),
    path.join(path.dirname(process.execPath), '../share/doc/node/LICENSE'),
    path.join(path.dirname(process.execPath), '../share/doc/nodejs/copyright'),
  ].find(value => sync.existsSync(value));
  if (!nodeLicense) throw new Error('Build from a complete Node distribution so its license notices can be bundled.');
  await fs.copyFile(nodeLicense, path.join(output, 'NODE-LICENSE'));
  const hash = createHash('sha256');
  async function hashTree(directory) {
    for (const entry of (await fs.readdir(directory, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name))) {
      const name = path.join(directory, entry.name); hash.update(path.relative(output, name));
      if (entry.isDirectory()) await hashTree(name);
      else if (entry.isSymbolicLink()) hash.update(await fs.readlink(name));
      else hash.update(await fs.readFile(name));
    }
  }
  await hashTree(output);
  const manifest = { id: hash.digest('hex'), version: packed.version, node: process.versions.node, platform: process.platform, arch: process.arch };
  await fs.writeFile(path.join(output, 'manifest.json'), JSON.stringify(manifest, null, 2));
  console.log(`Prepared CliDeck ${manifest.version}, Node ${manifest.node}, ${manifest.platform}/${manifest.arch}.`);
}
main().catch(error => { console.error(error.message); process.exitCode = 1; });
