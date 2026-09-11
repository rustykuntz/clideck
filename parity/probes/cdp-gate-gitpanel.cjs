// Real-Chrome gate for the Git Changes workspace panel.
//
// A real git repo in a temp folder, a real session in it, the real header action, the real plugin worker and
// the real sandboxed workspace page. Nothing is stubbed: if the manifest, the worker, the postMessage bridge
// or the page's own rendering is broken, this fails.
//
// ⚠️ THE PAGE RUNS IN AN OPAQUE ORIGIN (`sandbox="allow-scripts …"`, no allow-same-origin), so its DOM is NOT
// reachable from the top frame. Every check below talks to it through CDP's frame tree — `Runtime.evaluate`
// against the FRAME's own execution context — which is the only way to see inside it.
const { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync } = require('node:fs');
const { spawn, execFileSync } = require('node:child_process');
const { tmpdir } = require('node:os');
const { join } = require('node:path');
const { HeadlessServer } = require('../../src/server');
const WebSocket = require('../../node_modules/ws');

const CHROME = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const OUT = process.env.GATE_OUT || tmpdir();
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const REFRESH_PAUSE_MS = 7000;      // comfortably longer than the page's 3s poll, so "it stopped" means it stopped
let failures = 0;
function check(name, pass, detail = '') {
  console.log(`${pass ? 'PASS' : 'FAIL'} ${name}${detail ? ` [${detail}]` : ''}`);
  if (!pass) failures++;
}
async function waitFor(fn, timeout = 15000) {
  const start = Date.now();
  while (Date.now() - start < timeout) { const v = await fn(); if (v) return v; await sleep(120); }
  return null;
}
const git = (cwd, ...args) => execFileSync('git', args, { cwd, stdio: 'pipe', env: { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_SYSTEM: '/dev/null' } });

(async () => {
  // A repo with one commit, then a modification, a deletion and an untracked file — so the panel has an
  // add row, a del row and an untracked file to report, not just "no changes".
  const repo = join(mkdtempSync(join(tmpdir(), 'clideck-gitpanel-')), 'acme-checkout');
  mkdirSync(repo, { recursive: true });
  git(repo, 'init', '-q', '-b', 'main');
  git(repo, 'config', 'user.email', 'gate@example.invalid');
  git(repo, 'config', 'user.name', 'Gate');
  writeFileSync(join(repo, 'totals.ts'), 'export const rate = 0.15;\nexport const rounding = "before-tax";\nexport const currency = "usd";\n');
  writeFileSync(join(repo, 'notes.md'), '# notes\n');
  git(repo, 'add', '.');
  git(repo, 'commit', '-q', '-m', 'first');
  writeFileSync(join(repo, 'totals.ts'), 'export const rate = 0.15;\nexport const rounding = "after-tax";\nexport const currency = "usd";\nexport const precision = 2;\n');
  writeFileSync(join(repo, 'scratch.txt'), 'untracked work in progress\n');

  const dataDir = mkdtempSync(join(tmpdir(), 'clideck-gitpanel-data-'));
  // ⚠️ `completed` alone is not enough — the release TIPS still fire and sit over the capture. Seed both.
  writeFileSync(join(dataDir, 'config.json'), JSON.stringify({
    onboarding: { completed: true, seenTips: ['about-me', 'guided-tour'] }, defaultCwd: repo,
  }, null, 2));
  const server = new HeadlessServer({ port: 0, dataDir });
  const addr = await server.listen();
  const ctl = new WebSocket(`ws://127.0.0.1:${addr.port}`);
  const events = [];
  ctl.on('message', (raw) => { try { events.push(JSON.parse(raw)); } catch {} });
  await new Promise((res, rej) => { ctl.once('open', res); ctl.once('error', rej); });
  ctl.send(JSON.stringify({ type: 'session.create', provider: 'shell', name: 'builder', cwd: repo }));
  const made = await waitFor(() => events.find((e) => e.type === 'session.created' && e.name === 'builder'));

  const profile = mkdtempSync(join(tmpdir(), 'clideck-gitpanel-chrome-'));
  const chrome = spawn(CHROME, ['--headless=new', '--disable-gpu', '--remote-debugging-port=0', `--user-data-dir=${profile}`, '--no-first-run', 'about:blank'], { stdio: 'ignore' });
  let cdp = null;
  try {
    if (!made) throw new Error('the session did not start');
    const pf = join(profile, 'DevToolsActivePort');
    await waitFor(() => existsSync(pf));
    const port = readFileSync(pf, 'utf8').split('\n')[0].trim();
    const target = await (await fetch(`http://127.0.0.1:${port}/json/new?about:blank`, { method: 'PUT' })).json();
    cdp = new WebSocket(target.webSocketDebuggerUrl, { maxPayload: 64 * 1024 * 1024 });
    await new Promise((res, rej) => { cdp.once('open', res); cdp.once('error', rej); });
    let seq = 0; const pend = new Map(); const attached = [];
    cdp.on('message', (raw) => {
      const m = JSON.parse(raw);
      if (m.method === 'Target.attachedToTarget') attached.push(m.params);
      const d = pend.get(m.id); if (d) { pend.delete(m.id); d(m); }
    });
    const cmd = (method, params = {}, sessionId) => new Promise((res) => {
      const id = ++seq; pend.set(id, res);
      cdp.send(JSON.stringify(sessionId ? { id, method, params, sessionId } : { id, method, params }));
    });
    const js = async (e) => (await cmd('Runtime.evaluate', { expression: e, returnByValue: true, awaitPromise: true })).result?.result?.value;
    const shot = async (name) => { const r = await cmd('Page.captureScreenshot', { format: 'png' }); writeFileSync(join(OUT, name), Buffer.from(r.result.data, 'base64')); console.log(`SHOT ${join(OUT, name)}`); };
    const theme = (v) => cmd('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-color-scheme', value: v }] });
    await cmd('Runtime.enable');
    await cmd('Page.enable');
    await cmd('Target.setAutoAttach', { autoAttach: true, waitForDebuggerOnStart: false, flatten: true });
    await cmd('Emulation.setDeviceMetricsOverride', { width: 1440, height: 900, deviceScaleFactor: 1, mobile: false });
    await theme('dark');
    await cmd('Page.navigate', { url: `http://127.0.0.1:${addr.port}` });
    await sleep(5000);

    check('the plugin loaded — a failed one has no actions to offer',
      (await js(`(async () => { const { store } = await import('/js/store.js'); const p = store.plugins.find((x) => x.id === 'git-diff'); return p && p.status; })()`)) === 'ready');

    // The header action, reached the way a user reaches it.
    const opened = await js(`(async () => {
      const btn = document.getElementById('plugin-actions');
      if (!btn || btn.hidden) return 'no plugin actions button';
      btn.click();
      await new Promise((r) => setTimeout(r, 400));
      const item = [...document.querySelectorAll('.menu-item, .menu button, [role="menuitem"]')].find((n) => /git changes/i.test(n.textContent || ''));
      if (!item) return 'no Git changes item';
      item.click();
      return 'clicked';
    })()`);
    check('the terminal header offers Git changes, and it opens', opened === 'clicked', String(opened));
    await sleep(2500);

    const tab = await js(`(() => ({ tabs: [...document.querySelectorAll('#pane-tabs .cd-tab')].map((t) => t.textContent.trim()),
      frame: !!document.querySelector('iframe.plugin-workspace') }))()`);
    check('it opens as a workspace TAB beside the terminal, not over it',
      tab.frame && tab.tabs.some((t) => /git changes/i.test(t)), JSON.stringify(tab));

    // ⚠️ The page is a separate, opaque-origin execution context. Find its frame and evaluate THERE.
    // ⚠️ A SANDBOXED FRAME IS AN OUT-OF-PROCESS FRAME. Its opaque origin gets site-isolated into its own
    // renderer, so it is NOT in `Page.getFrameTree` and no isolated world can be created for it from here —
    // the first two attempts at this gate both failed that way. It has to be attached to as its own TARGET,
    // and every evaluate against it carries that session id.
    // ⚠️ AN IFRAME TARGET ATTACHES BEFORE IT HAS A URL. `targetInfo.url` is an empty string at attach time, so
    // matching on the URL found nothing even though the target was right there in the list. Match on the TYPE,
    // then ask each candidate where it actually is — the page answers for itself.
    const panelSession = await waitFor(async () => {
      for (const a of attached) {
        if (!a.targetInfo || a.targetInfo.type !== 'iframe') continue;
        const where = await cmd('Runtime.evaluate', { expression: 'location.pathname', returnByValue: true }, a.sessionId);
        if (/git-diff\/public\/index\.html/.test(where.result?.result?.value || '')) return a.sessionId;
      }
      return null;
    }, 12000);
    if (!panelSession) throw new Error('never attached to the workspace frame target');
    const inPage = async (expression) => (await cmd('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true }, panelSession)).result?.result?.value;

    const ready = await waitFor(async () => (await inPage(`!!document.querySelector('.diff-row')`)) === true, 12000);
    check('the panel asked the backend and drew a real diff', ready === true);

    const body = await inPage(`(() => ({
      adds: document.querySelectorAll('.diff-row.add').length,
      dels: document.querySelectorAll('.diff-row.del').length,
      warnings: [...document.querySelectorAll('.note.warn li')].map((n) => n.textContent),
      where: document.getElementById('where').textContent,
      copy: { hidden: document.getElementById('copy').hidden, label: document.getElementById('copy').textContent },
      scope: [...document.querySelectorAll('#scope button')].map((b) => b.textContent + (b.classList.contains('on') ? '*' : '')),
      theme: document.documentElement.getAttribute('data-theme'),
    }))()`);
    check('the changed line shows as an add and a del', body.adds >= 1 && body.dels >= 1, JSON.stringify({ adds: body.adds, dels: body.dels }));
    check('it names the repo and branch it is reading', /acme-checkout/.test(body.where) && /main/.test(body.where), body.where);
    check('the untracked file is in the diff, not silently dropped',
      (await inPage(`/scratch\\.txt/.test(document.body.textContent)`)) === true);
    check('the scope toggle starts on Uncommitted', body.scope[0].endsWith('*'), JSON.stringify(body.scope));
    check('Copy is offered and says what it will actually give you', body.copy.hidden === false && /^Copy (patch|preview)$/.test(body.copy.label), JSON.stringify(body.copy));
    check('the page took the host theme rather than guessing one', body.theme === 'dark', String(body.theme));
    await shot('gitpanel-dark.png');

    // Theme follows the host live, through clideck.theme.
    await theme('light'); await sleep(900);
    check('…and follows the host when the theme changes under it',
      (await inPage(`document.documentElement.getAttribute('data-theme')`)) === 'light');
    await shot('gitpanel-light.png');
    await theme('dark'); await sleep(600);

    // Polling must stop behind a hidden tab, and catch up on the way back.
    // ⚠️ POLLING MUST NOT REPAINT AN UNCHANGED ANSWER. Marking a row and checking the SAME element is still
    // there after two full poll cycles is the only way to prove the DOM was left alone — a user reading a diff
    // cannot hold a selection across a replaceChildren.
    await inPage(`(() => { const row = document.querySelector('.diff-row'); if (row) row.dataset.gateMark = 'kept'; return !!row; })()`);
    const marked = await inPage(`!!document.querySelector('.diff-row[data-gate-mark="kept"]')`);
    check('the gate can mark a row to watch it', marked === true);
    await sleep(REFRESH_PAUSE_MS);
    check('two poll cycles later the diff has NOT been repainted under the reader',
      (await inPage(`!!document.querySelector('.diff-row[data-gate-mark="kept"]')`)) === true);

    const asked = () => inPage(`Number(document.documentElement.dataset.asked || 0)`);
    const seenVisible = () => inPage(`document.documentElement.dataset.visible`);
    check('while it is on screen the page knows it', (await seenVisible()) === 'yes');
    const busy = await asked();
    await js(`(() => { const t = [...document.querySelectorAll('#pane-tabs .cd-tab')].find((x) => /terminal/i.test(x.textContent)); if (t) t.click(); })()`);
    await sleep(1000);
    check('switching away tells the page it is hidden', (await seenVisible()) === 'no');
    const atHide = await asked();
    await sleep(REFRESH_PAUSE_MS);
    check('…and it stops asking — no polling behind a tab nobody is looking at',
      (await asked()) === atHide, JSON.stringify({ busy, atHide, now: await asked() }));
    await js(`(() => { const t = [...document.querySelectorAll('#pane-tabs .cd-tab')].find((x) => /git changes/i.test(x.textContent)); if (t) t.click(); })()`);
    await sleep(1200);
    check('…and coming back asks once immediately, so what is shown is not stale',
      (await seenVisible()) === 'yes' && (await asked()) > atHide, JSON.stringify({ atHide, now: await asked() }));

    console.log(`\n${failures === 0 ? 'all checks passed' : failures + ' FAILED'}`);
  } catch (error) {
    console.log('THREW', error && error.stack || error);
    failures++;
  } finally {
    try { if (cdp) cdp.close(); } catch {}
    try { ctl.close(); } catch {}
    try { chrome.kill(); } catch {}
    try { await server.close(); } catch {}
  }
  process.exit(failures ? 1 : 0);
})();
