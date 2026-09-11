const { realpath } = require('fs/promises');
const {
  makeGit, resolveRepo, resolveBase, listWorktrees, probeFilterDrivers, diffPatch, listUntracked,
} = require('./git');
const { collectUntracked } = require('./untracked');

const MAX_PATCH_BYTES = 256 * 1024;
const MAX_LINE_CHARS = 8000;
const MAX_CHANGED_LINES = 10000;

function boundedPatch(patch) {
  let bytes = 0;
  let changed = 0;
  const warnings = [];
  const parts = [];
  // Omit whole files, so the UI never mistakes a truncated patch for a full one.
  for (const file of patch.split(/(?=^diff --git )/m)) {
    if (!file) continue;
    const name = file.slice(0, file.indexOf('\n')).slice(0, 160);
    const size = Buffer.byteLength(file);
    const lines = file.split('\n');
    const changes = lines.filter((line) => /^[+-]/.test(line) && !/^(---|\+\+\+)/.test(line)).length;
    if (bytes + size > MAX_PATCH_BYTES || changed + changes > MAX_CHANGED_LINES || lines.some((line) => line.length > MAX_LINE_CHARS)) {
      if (warnings.length < 20) warnings.push(`Not displayed: ${name} (too large).`);
      continue;
    }
    parts.push(file); bytes += size; changed += changes;
  }
  return { patch: parts.join(''), warnings };
}

async function buildDiff(session, request, settings = {}) {
  const baseGit = makeGit();
  const homeRepo = await resolveRepo(baseGit, session.cwd);
  if (!homeRepo.ok) return { ...homeRepo, error: homeRepo.message };
  const worktrees = (await listWorktrees(baseGit, homeRepo.repoRoot)).slice(0, 100);
  let folder = homeRepo.repoRoot;
  if (request.folder) {
    const selected = await realpath(request.folder);
    const known = await Promise.all(worktrees.map(async (tree) => {
      try { return await realpath(tree.path); } catch { return ''; }
    }));
    if (selected !== await realpath(homeRepo.repoRoot) && !known.includes(selected)) {
      throw new Error('Choose a worktree from this repository.');
    }
    folder = selected;
  }
  const drivers = await probeFilterDrivers(folder);
  if (!drivers.ok || drivers.rejected.length) throw new Error('Cannot safely read this repository’s Git settings.');
  const git = makeGit(drivers.usable);
  const repo = await resolveRepo(git, folder);
  if (!repo.ok) return { ...repo, error: repo.message };
  const scope = request.scope === 'base' ? 'base' : 'uncommitted';
  const base = await resolveBase(git, repo.repoRoot, scope, String(settings['base-branch'] || '').trim());
  const tracked = await diffPatch(git, repo.repoRoot, base.base, 3);
  if (!tracked.ok) throw new Error(tracked.timedOut ? 'Git took too long. Try refreshing.' : 'The diff could not be read or is too large to display.');
  const untracked = await collectUntracked(repo.repoRoot, await listUntracked(git, repo.repoRoot));
  const result = boundedPatch(tracked.stdout + untracked.patch);
  if (untracked.oversized.size) result.warnings.push(`${untracked.oversized.size} large untracked files are shown without contents.`);
  if (untracked.skipped.size) result.warnings.push(`${untracked.skipped.size} special or unreadable files were skipped.`);
  if (untracked.truncated) result.warnings.push(`${untracked.truncated.files} untracked files were left out of this preview.`);
  if (base.badSetting) result.warnings.push('The configured base branch is invalid; using the default.');
  const response = {
    ok: true, ...result, repoRoot: repo.repoRoot, branch: repo.branch,
    scope, baseLabel: base.baseLabel, baseFallback: !!base.baseFallback, worktrees,
  };
  // The worker message limit includes JSON escaping, not just raw patch bytes.
  if (Buffer.byteLength(JSON.stringify(response)) > 900 * 1024) {
    response.patch = ''; response.warnings.push('This diff is too large to display.');
  }
  return response;
}

function createService(api) {
  const pending = new Map();
  return async (request = {}) => {
    if (!request || typeof request !== 'object' || typeof request.sessionId !== 'string') throw new Error('Choose a session first.');
    if (request.folder !== undefined && (typeof request.folder !== 'string' || request.folder.length > 4096 || request.folder.includes('\0'))) throw new Error('Invalid worktree.');
    if (request.scope !== undefined && !['base', 'uncommitted'].includes(request.scope)) throw new Error('Invalid diff scope.');
    const session = await api.getSession(request.sessionId);
    if (!session?.cwd) throw new Error('This session is no longer available.');
    const settings = api.getSettings();
    const key = JSON.stringify([request.sessionId, session.cwd, request.folder || '', request.scope || 'uncommitted', settings['base-branch'] || '']);
    if (pending.has(key)) return pending.get(key);
    if (pending.size >= 4) throw new Error('Git is busy. Try refreshing in a moment.');
    const task = buildDiff(session, request, settings).finally(() => pending.delete(key));
    pending.set(key, task);
    return task;
  };
}

function activate(api) {
  const read = createService(api);
  api.onClientMessage('diff-request', async (request, context) => {
    try { context.reply('diff-result', { ...await read(request), requestId: request?.requestId }); }
    catch (error) { context.reply('diff-result', { ok: false, error: error.message, requestId: request?.requestId }); }
  });
}

module.exports = { activate, buildDiff, boundedPatch, createService };
