const test = require('node:test');
const assert = require('node:assert/strict');
const { mkdtempSync, writeFileSync, readFileSync, existsSync, rmSync } = require('node:fs');
const { execFileSync } = require('node:child_process');
const { join } = require('node:path');
const { tmpdir } = require('node:os');
const { PluginManager } = require('../src/plugin-manager');
const { ConfigStore } = require('../src/config-store');
const { buildDiff, boundedPatch, createService, activate } = require('../plugins/git-diff/server');

function fixture(t, commit = true) {
  const root = mkdtempSync(join(tmpdir(), 'clideck-git-panel-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const git = (...args) => execFileSync('git', ['-c', 'core.hooksPath=/dev/null', ...args], {
    cwd: root, encoding: 'utf8', env: { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  git('init', '-b', 'main');
  git('config', 'user.name', 'Test'); git('config', 'user.email', 'test@example.invalid');
  if (commit) {
    writeFileSync(join(root, 'a.txt'), 'original\n');
    git('add', '.'); git('commit', '-m', 'initial');
  }
  return { root, git };
}

test('Git panel includes staged, unstaged and untracked changes without touching the index', async (t) => {
  const { root, git } = fixture(t);
  writeFileSync(join(root, 'staged.txt'), 'staged content\n'); git('add', 'staged.txt');
  writeFileSync(join(root, 'a.txt'), 'unstaged content\n');
  writeFileSync(join(root, 'new.txt'), 'untracked content\n');
  const before = readFileSync(join(root, '.git/index'));
  const result = await buildDiff({ cwd: root }, {});
  assert.equal(result.ok, true);
  for (const content of ['staged content', 'unstaged content', 'untracked content']) assert.ok(result.patch.includes(`+${content}`));
  assert.deepEqual(readFileSync(join(root, '.git/index')), before);
  assert.deepEqual(result.warnings, []);
});

test('Git panel handles a repository before its first commit', async (t) => {
  const { root, git } = fixture(t, false);
  writeFileSync(join(root, 'first.txt'), 'first\n'); git('add', '.');
  writeFileSync(join(root, 'second.txt'), 'second\n');
  const result = await buildDiff({ cwd: root }, { scope: 'base' });
  assert.equal(result.ok, true);
  assert.match(result.patch, /\+first/); assert.match(result.patch, /\+second/);
  assert.equal(result.baseFallback, true);
});

test('base comparison includes branch commits and worktrees stay separate between clients', async (t) => {
  const { root, git } = fixture(t);
  const worktree = `${root}-worktree`;
  t.after(() => rmSync(worktree, { recursive: true, force: true }));
  git('worktree', 'add', '-b', 'feature', worktree);
  writeFileSync(join(worktree, 'a.txt'), 'branch change\n');
  git('-C', worktree, 'commit', '-am', 'feature');
  const service = createService({ getSession: async () => ({ cwd: root }), getSettings: () => ({}) });
  const [main, branch, duplicate] = await Promise.all([
    service({ sessionId: 'same', scope: 'base' }),
    service({ sessionId: 'same', folder: worktree, scope: 'base' }),
    service({ sessionId: 'same', folder: worktree, scope: 'base' }),
  ]);
  assert.equal(main.patch, '');
  assert.match(branch.patch, /\+branch change/);
  assert.deepEqual(branch, duplicate);
  assert.equal(branch.baseLabel, 'main');
  assert.equal(branch.worktrees.length, 2);
  await assert.rejects(service({ sessionId: 'same', folder: tmpdir() }), /Choose a worktree/);
  await assert.rejects(service({ sessionId: 'same', scope: '--unsafe' }), /Invalid diff scope/);
});

test('Git panel disables filters from included configuration files', async (t) => {
  const { root, git } = fixture(t);
  const marker = join(root, 'filter-ran');
  const config = join(root, '.git', 'included-config');
  writeFileSync(config, `[filter "included"]\n clean = touch '${marker}'\n required = true\n`);
  git('config', 'include.path', config);
  writeFileSync(join(root, '.gitattributes'), 'a.txt filter=included\n');
  writeFileSync(join(root, 'a.txt'), 'new content\n');
  const result = await buildDiff({ cwd: root }, {});
  assert.equal(result.ok, true);
  assert.match(result.patch, /\+new content/);
  assert.equal(existsSync(marker), false);
});

test('oversized diff files are omitted whole with an explanation', () => {
  const header = 'diff --git a/a b/a\n--- a/a\n+++ b/a\n@@ -1 +1 @@\n';
  const normal = header + '-old\n+new\n';
  const giant = header + '+' + 'x'.repeat(9000) + '\n';
  const result = boundedPatch(giant + normal);
  assert.equal(result.patch, normal);
  assert.equal(result.warnings.length, 1);
  const total = boundedPatch(normal.repeat(9000));
  assert.ok(Buffer.byteLength(total.patch) <= 256 * 1024);
  assert.match(total.warnings[0], /too large/);
});

test('Git plugin replies only through the requesting client context and preserves request IDs', async (t) => {
  const { root } = fixture(t);
  let handler;
  activate({ getSession: async () => ({ cwd: root }), getSettings: () => ({}),
    onClientMessage: (type, callback) => { assert.equal(type, 'diff-request'); handler = callback; },
  });
  const replies = [[], []];
  await Promise.all(replies.map((list, i) => handler({ requestId: `tab-${i}`, sessionId: 'session' }, {
    reply: (type, data) => list.push({ type, data }),
  })));
  for (let i = 0; i < replies.length; i++) {
    assert.equal(replies[i].length, 1);
    assert.equal(replies[i][0].type, 'diff-result');
    assert.equal(replies[i][0].data.requestId, `tab-${i}`);
    assert.equal(replies[i][0].data.ok, true);
  }
});

test('bundled Git plugin loads and returns a real diff through its worker', { timeout: 10000 }, async (t) => {
  const { root } = fixture(t);
  const dataDir = mkdtempSync(join(tmpdir(), 'clideck-git-worker-'));
  writeFileSync(join(root, 'a.txt'), 'worker change\n');
  const manager = new PluginManager({
    dataDir, configStore: new ConfigStore({ dataDir }), log: () => {},
    onCoreCall: async (_pluginId, method) => {
      assert.equal(method, 'getSession');
      return { id: 'session', cwd: root };
    },
  });
  t.after(async () => { await manager.close(); rmSync(dataDir, { recursive: true, force: true }); });
  await manager.start();
  const plugin = manager.snapshot().find((entry) => entry.id === 'git-diff');
  assert.equal(plugin.status, 'ready', plugin.error);
  const reply = await new Promise((resolveReply) => {
    assert.equal(manager.clientMessage('git-diff', 'diff-request', {
      sessionId: 'session', requestId: 'worker-request',
    }, { requestId: 'wire-request', reply: resolveReply }), true);
  });
  assert.equal(reply.event, 'diff-result');
  assert.equal(reply.data.ok, true, reply.data.error);
  assert.equal(reply.data.requestId, 'worker-request');
  assert.match(reply.data.patch, /\+worker change/);
});
