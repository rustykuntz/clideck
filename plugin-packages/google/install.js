const { createHash, randomUUID } = require('node:crypto');
const { createWriteStream } = require('node:fs');
const { mkdir, lstat, access, chmod, rename, rm } = require('node:fs/promises');
const { constants } = require('node:fs');
const { join } = require('node:path');
const { release, homedir } = require('node:os');
const { Transform } = require('node:stream');
const { pipeline } = require('node:stream/promises');
const { execFile } = require('node:child_process');
const { promisify } = require('node:util');
const { findGog } = require('./runner');

// Official v0.48.0 checksums.txt, verified against the GitHub release asset digests.
// Pin releases: a normal plugin start must never silently upgrade a working gog.
const VERSION = '0.48.0';
const BUILDS = {
  darwin_x64: [15425889, '423d8ac93530e13cd7cb599de2655db3262ddc763181996771d74188ffcefc5a'],
  darwin_arm64: [13677152, 'a8c6142fcb9f41f0eff02ffef78298cbe4981061f149c2b3a42d5a13bad931bd'],
  linux_x64: [15018627, '8809d2f4fe95a0299b1a2a5c6bc912c4aba4b90a7b5e2c1f5cf11b9945a50004'],
  linux_arm64: [13522612, 'fc40524368d2cb6213bdfe0b736b5884e1b55c6368706d7a285542cb7e559b68'],
};
function selectBuild(platform = process.platform, arch = process.arch, osRelease = release()) {
  const key = `${platform}_${arch}`, entry = BUILDS[key];
  if (!entry) throw Error('Automatic gog installation supports macOS and Ubuntu on Intel/AMD x64 or ARM64. Set an existing gog path on other systems.');
  if (platform === 'darwin' && Number(osRelease.split('.')[0]) < 24) throw Error('The official gog download requires macOS 15 or newer. Set an existing compatible gog path on older Macs.');
  return { key, version: VERSION, bytes: entry[0], sha256: entry[1], file: `gogcli_${VERSION}_${platform}_${arch === 'x64' ? 'amd64' : arch}.tar.gz` };
}

async function download(build, path, { signal, fetchImpl = fetch, onProgress = () => {} }) {
  const response = await fetchImpl(`https://github.com/openclaw/gogcli/releases/download/v${build.version}/${build.file}`, { signal });
  if (!response.ok || !response.body) throw Error(`gog download failed (HTTP ${response.status}). Refresh to retry.`);
  const hash = createHash('sha256'); let bytes = 0, last = -5;
  await pipeline(response.body, new Transform({ transform(chunk, encoding, done) {
    bytes += chunk.length;
    if (bytes > build.bytes) return done(Error('gog download exceeded its expected size. Nothing was installed.'));
    hash.update(chunk); const percent = Math.floor(bytes * 100 / build.bytes);
    if (percent >= last + 5) { last = percent; onProgress(percent); }
    done(null, chunk);
  } }), createWriteStream(path, { flags: 'wx', mode: 0o600 }), { signal });
  if (bytes !== build.bytes || hash.digest('hex') !== build.sha256) throw Error('gog download failed checksum verification. Nothing was installed; refresh to retry.');
}

function createInstaller({ dataDir, locate = findGog, fetchImpl = fetch, build: suppliedBuild, platform = process.platform,
  arch = process.arch, osRelease = release(), env = process.env, home = homedir(), onProgress = () => {}, timeoutMs = 150_000 } = {}) {
  const controller = new AbortController(), runFile = promisify(execFile);
  let pending = null, state = { state: 'checking', source: null, message: 'Preparing your Google connection…' };
  const update = value => { state = value; try { onProgress({ ...state }); } catch {} };
  const ready = (path, source) => {
    update({ state: 'ready', source, message: 'Google Workspace is ready.' }); return path;
  };
  async function install() {
    const build = suppliedBuild || selectBuild(platform, arch, osRelease);
    const root = join(dataDir, 'runtime'), destination = join(root, `gog-${build.version}-${build.key}`), binary = join(destination, 'gog');
    try {
      const item = await lstat(binary);
      if (!item.isFile() || !item.size) throw Error('The CliDeck gog installation is damaged. Remove its runtime folder and refresh to repair it.');
      await access(binary, constants.X_OK); controller.signal.throwIfAborted(); return ready(binary, 'managed');
    } catch (error) { if (error.code !== 'ENOENT') throw error; }
    const staging = join(root, `.gog-${randomUUID()}`), signal = AbortSignal.any([controller.signal, AbortSignal.timeout(timeoutMs)]);
    await mkdir(staging, { recursive: true, mode: 0o700 });
    try {
      const archive = join(staging, 'gog.tar.gz');
      update({ state: 'downloading', source: 'managed', percent: 0, message: 'Preparing your Google connection…' });
      await download(build, archive, { signal, fetchImpl,
        onProgress: percent => update({ state: 'downloading', source: 'managed', percent, message: 'Preparing your Google connection…' }) });
      update({ state: 'verifying', source: 'managed', message: 'Finishing setup…' });
      // Extract only the named executable from the verified archive, not its other members.
      // GNU tar distinguishes ./gog from gog; BSD tar accepts either spelling.
      const listing = await runFile('tar', ['-tzf', archive], { signal, timeout: 20_000, maxBuffer: 64 * 1024 });
      const member = listing.stdout.split('\n').find(name => name === 'gog' || name === './gog');
      if (!member) throw Error('The gog archive did not contain a root gog executable.');
      await runFile('tar', ['-xzf', archive, '-C', staging, '--', member], { signal, timeout: 20_000, maxBuffer: 64 * 1024 });
      const stagedBinary = join(staging, 'gog'), item = await lstat(stagedBinary);
      if (!item.isFile() || !item.size || item.size > 128 * 1024 * 1024) throw Error('The gog archive did not contain a valid executable.');
      await chmod(stagedBinary, 0o700);
      const probe = await runFile(stagedBinary, ['--version'], { signal, env, timeout: 10_000, maxBuffer: 64 * 1024 });
      if (probe.stdout.trim().split(/\s/)[0] !== `v${build.version}`) throw Error('The installed gog version did not match the verified release.');
      await rm(archive); signal.throwIfAborted(); await rename(staging, destination);
      return ready(binary, 'managed');
    } finally { await rm(staging, { recursive: true, force: true }); }
  }
  async function ensure(configured = '') {
    try {
      controller.signal.throwIfAborted();
      try { const path = await locate(configured, env, home); controller.signal.throwIfAborted(); return ready(path, configured ? 'custom' : 'system'); }
      catch (error) { if (configured || error.code !== 'GOG_NOT_FOUND') throw error; }
      controller.signal.throwIfAborted();
      if (!pending) pending = install().finally(() => { pending = null; });
      return await pending;
    } catch (error) {
      const message = controller.signal.aborted ? 'Google Workspace was disabled during gog installation.'
        : error.name === 'TimeoutError' || error.name === 'AbortError' ? 'gog installation took too long. Refresh to retry.' : error.message;
      update({ state: 'error', source: state.source, message }); throw Error(message);
    }
  }
  async function close() { controller.abort(); await pending?.catch(() => {}); }
  return { ensure, snapshot: () => ({ ...state }), close };
}

module.exports = { createInstaller, selectBuild, download, VERSION, BUILDS };
