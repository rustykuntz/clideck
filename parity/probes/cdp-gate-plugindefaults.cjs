// Real-Chrome gate for the RELEASE plugin defaults, verified from the Settings surface a user actually sees.
//
// Two questions, and they are different questions:
//   A. A FRESH install — which plugins exist, which are on, and what their settings say before anyone touches
//      anything. This is the state every new user meets, so it is read from the UI, not from the manifests.
//   B. An install that has ALREADY been configured — a stored choice must survive, because a default that
//      overwrites a user's decision on the next launch is worse than a wrong default.
//
// ⚠️ NO `bundledPluginsDir` IS PASSED, deliberately. The manager falls back to the repo's own `plugins/`
// (plugin-manager.js:102), so discovery here is the REAL discovery — which is the only way "OmniVoice is gone"
// means anything. A fixture directory that never contained it would prove nothing.
//
// ⚠️ Onboarding is dismissed in the fixture config. A fresh dataDir makes the engine seed `completed:false`,
// and the auto-tour would sit over every capture.
//
// Own Chrome + temp profile + ephemeral engines on their own ports. Never :9222, never 4100, never
// ~/.clideck-next — nothing here can see Or's config or his live sessions.
const { mkdtempSync, writeFileSync, readFileSync, existsSync } = require('node:fs');
const { spawn } = require('node:child_process');
const { tmpdir } = require('node:os');
const { join } = require('node:path');
const { HeadlessServer } = require('../../src/server');

const CHROME = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const OUT = process.env.GATE_OUT || tmpdir();
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
let failures = 0;
function check(name, pass, detail = '') {
  console.log(`${pass ? 'PASS' : 'FAIL'} ${name}${detail ? ` [${detail}]` : ''}`);
  if (!pass) failures++;
}
async function waitFor(fn, timeout = 9000) {
  const start = Date.now();
  while (Date.now() - start < timeout) { const value = await fn(); if (value) return value; await sleep(90); }
  return null;
}
// A dataDir whose config.json is exactly what this phase wants to start from.
function seeded(prefix, config) {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  writeFileSync(join(dir, 'config.json'), JSON.stringify({
    onboarding: { completed: true, seenTips: ['about-me', 'guided-tour'] }, ...config,
  }, null, 2));
  return dir;
}

// Sorted, because the check compares a sorted id list. Git Changes joined the release set on 09-11.
const RELEASE = ['emoji', 'git-diff', 'smart-dictation', 'supertonic'];
// What Or asked for, written out here rather than read from the manifests: a gate that derives its
// expectations from the thing under test cannot fail.
const DEFAULT_ENABLED = { emoji: true, supertonic: true, 'git-diff': true, 'smart-dictation': false };
const SUPERTONIC_DEFAULTS = { voice: 'female-2', shortcut: 'F5', language: 'en', quality: 12, normalization: 'english', 'auto-read': false };

(async () => {
  const freshDir = seeded('clideck-plugdef-fresh-', {});
  // An install someone has already made decisions in: both booleans flipped away from their defaults, and two
  // Supertonic settings moved off theirs.
  const customDir = seeded('clideck-plugdef-custom-', {
    plugins: {
      // ⚠️ `yara` is a REAL option in the Supertonic manifest. An out-of-range value is not a weaker version
      // of this test — `validateSettingValue` correctly drops it back to the default, so a made-up voice
      // proves nothing about whether a genuine choice survives. (Learned the hard way: `male-1` is not a
      // voice, the check failed, and it looked like a backend bug for a minute.) The bogus case is asserted
      // separately below, on a setting nobody would miss.
      supertonic: { enabled: false, settings: { voice: 'yara', quality: 8, language: 'kl' } },
      'smart-dictation': { enabled: true },
    },
  });
  const fresh = new HeadlessServer({ port: 0, dataDir: freshDir });
  const custom = new HeadlessServer({ port: 0, dataDir: customDir });
  const freshAddr = await fresh.listen();
  const customAddr = await custom.listen();

  const profile = mkdtempSync(join(tmpdir(), 'clideck-plugdef-chrome-'));
  const chrome = spawn(CHROME, ['--headless=new', '--disable-gpu', '--remote-debugging-port=0', `--user-data-dir=${profile}`, '--no-first-run', 'about:blank'], { stdio: 'ignore' });
  let cdp = null;
  // ⚠️ TEARDOWN GOES IN `finally`. A gate that throws mid-run used to leave Chrome and an engine alive for
  // days (cdp-gate-readalong, 09-05→09-08). Cleanup after the checks is cleanup that does not always run.
  try {
    const portFile = join(profile, 'DevToolsActivePort');
    await waitFor(() => existsSync(portFile));
    const debugPort = readFileSync(portFile, 'utf8').split('\n')[0].trim();
    const target = await (await fetch(`http://127.0.0.1:${debugPort}/json/new?about:blank`, { method: 'PUT' })).json();
    const WebSocket = require('../../node_modules/ws');
    cdp = new WebSocket(target.webSocketDebuggerUrl, { maxPayload: 32 * 1024 * 1024 });
    await new Promise((resolve, reject) => { cdp.once('open', resolve); cdp.once('error', reject); });
    let seq = 0; const pending = new Map();
    cdp.on('message', (raw) => {
      const message = JSON.parse(raw); const done = pending.get(message.id);
      if (done) { pending.delete(message.id); done(message); }
      else if (message.method === 'Runtime.exceptionThrown') console.error('BROWSER', message.params?.exceptionDetails?.exception?.description || message.params?.exceptionDetails?.text);
    });
    const command = (method, params = {}) => new Promise((resolve) => { const id = ++seq; pending.set(id, resolve); cdp.send(JSON.stringify({ id, method, params })); });
    const js = async (expression) => (await command('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true })).result?.result?.value;
    const shot = async (name) => { const result = await command('Page.captureScreenshot', { format: 'png' }); const path = join(OUT, name); writeFileSync(path, Buffer.from(result.result.data, 'base64')); console.log(`SHOT ${path}`); };
    const theme = (value) => command('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-color-scheme', value }] });
    await command('Runtime.enable');
    await command('Emulation.setDeviceMetricsOverride', { width: 1440, height: 900, deviceScaleFactor: 1, mobile: false });
    await theme('dark');

    // Settings ▸ Plugins, opened the way a user opens it, once the inventory has actually arrived.
    const openPlugins = async (port) => {
      await command('Page.navigate', { url: `http://127.0.0.1:${port}` });
      await sleep(3200);
      await waitFor(() => js(`import('/js/store.js').then((m) => m.store.pluginsLoaded === true)`));
      await js(`document.getElementById('settings-btn').click()`); await sleep(400);
      await js(`(() => { const cat = [...document.querySelectorAll('.set-cat')].find((c) => c.textContent === 'Plugins'); if (cat) cat.click(); })()`);
      await sleep(600);
    };
    // The rows as rendered, plus the inventory Settings renders them FROM.
    const readPane = () => js(`(async () => {
      const { store } = await import('/js/store.js');
      const rows = [...document.querySelectorAll('.plg-row')].map((row) => ({
        name: row.querySelector('.plg-name').textContent,
        status: row.querySelector('.plg-status span:not(.plg-spinner)').textContent,
        on: row.querySelector('.set-switch').getAttribute('aria-checked') === 'true',
      }));
      const state = {};
      for (const p of store.plugins) state[p.id] = { enabled: p.enabled, values: p.values || {}, name: p.name, status: p.status, error: p.error || '' };
      return { rows, state, ids: store.plugins.map((p) => p.id).sort(), tourOpen: !!document.querySelector('.tour') };
    })()`);
    // ⚠️ OPEN BY ID, AND NEVER SILENTLY. Matching on the display name looked right and did nothing: the row
    // reads "Supertonic Voice", not "Supertonic", so this no-opped and two captures named -supertonic were
    // pictures of the LIST. `dataset.search` is `name\0id\0description`, lowercased — field 1 is the id.
    const openDetail = (id) => js(`(() => {
      const row = [...document.querySelectorAll('.plg-row')].find((r) => String(r.dataset.search || '').split('\\0')[1] === ${JSON.stringify(id)});
      if (!row) return 'no row for ' + ${JSON.stringify(id)};
      row.querySelector('.plg-row-main').click();
      return true;
    })()`);
    // What the DETAIL pane actually shows — the controls, not the record behind them.
    const readDetail = (id) => js(`(() => {
      const name = document.querySelector('.plg-detail-name');
      if (!name) return null;
      const val = (key) => { const el = document.getElementById('plugin-setting-' + ${JSON.stringify(id)} + '-' + key); return el ? el.value : null; };
      const toggle = (label) => { const sw = [...document.querySelectorAll('.plg-setting .set-switch')].find((s) => s.getAttribute('aria-label') === label); return sw ? sw.getAttribute('aria-checked') : null; };
      const keys = document.querySelector('.plg-shortcut-keys');
      return { name: name.textContent, rows: document.querySelectorAll('.plg-setting').length,
        voice: val('voice'), language: val('language'), quality: val('quality'), normalization: val('normalization'),
        shortcut: keys ? keys.textContent : null, autoRead: toggle('Read completed replies automatically'),
        enabledSwitch: (document.querySelector('.set-row .set-switch') || {}).getAttribute ? document.querySelector('.set-row .set-switch').getAttribute('aria-checked') : null };
    })()`);

    // ── A. a fresh install ──────────────────────────────────────────────────
    await openPlugins(freshAddr.port);
    const a = await readPane();
    check('the fixture dismissed onboarding, so this is the pane and not the tour over it', a.tourOpen === false);
    check('exactly the release plugins are discovered, and nothing else', a.ids.join(',') === RELEASE.join(','), a.ids.join(','));
    check('OmniVoice is NOT among them — moved to experimental/, out of discovery and out of the package',
      !a.ids.some((id) => /omnivoice/i.test(id)) && !a.rows.some((row) => /omnivoice/i.test(row.name)),
      a.rows.map((r) => r.name).join(','));
    check('every discovered plugin has a row on screen', a.rows.length === RELEASE.length, String(a.rows.length));
    for (const id of RELEASE) {
      check(`${id} defaults to ${DEFAULT_ENABLED[id] ? 'ENABLED' : 'DISABLED'}`,
        a.state[id] && a.state[id].enabled === DEFAULT_ENABLED[id], JSON.stringify(a.state[id] && a.state[id].enabled));
    }
    // ⚠️ The switch is the promise, not the record behind it. A row whose engine state and switch disagree is
    // the failure a user would actually report.
    check('…and every row SHOWS the state the engine holds',
      a.rows.every((row) => { const entry = Object.values(a.state).find((s) => s.name === row.name); return entry && entry.enabled === row.on; }),
      JSON.stringify(a.rows));
    check('the disabled one says so in its status chip rather than looking merely idle',
      (a.rows.find((row) => /dictation/i.test(row.name)) || {}).status === 'disabled',
      JSON.stringify(a.rows.map((r) => `${r.name}:${r.status}`)));
    // ⚠️ Derived from DEFAULT_ENABLED, never from a count in the sentence — this check said "the two enabled
    // ones" and went stale the moment a fourth plugin shipped.
    check('…and every enabled plugin reports itself ready, not failed or stuck loading',
      RELEASE.filter((id) => DEFAULT_ENABLED[id]).every((id) => a.state[id] && a.state[id].status === 'ready'),
      JSON.stringify(a.rows.map((r) => `${r.name}:${r.status}`)));
    const supertonic = a.state.supertonic ? a.state.supertonic.values : {};
    for (const [key, want] of Object.entries(SUPERTONIC_DEFAULTS)) {
      check(`Supertonic ${key} defaults to ${JSON.stringify(want)}`, supertonic[key] === want, JSON.stringify(supertonic[key]));
    }
    // ⚠️ The empty-state card is created hidden and revealed by the filter. `.plg-state`'s own `display:flex`
    // used to beat the UA `[hidden]` rule, so "No matching plugins" sat under three healthy rows on every
    // Plugins pane — in a release capture. `hidden` is not a claim a fake DOM can check; only this can.
    const emptyState = () => js(`(() => {
      const card = document.querySelector('.plg-state.empty');
      if (!card) return { present: false };
      const box = card.getBoundingClientRect();
      return { present: true, hiddenAttr: card.hasAttribute('hidden'), display: getComputedStyle(card).display,
        visible: box.width > 0 && box.height > 0, rows: [...document.querySelectorAll('.plg-row')].filter((r) => !r.hidden).length };
    })()`);
    const populated = await emptyState();
    check('a populated list shows NO empty-state card — hidden means invisible, not merely marked',
      populated.present && populated.hiddenAttr === true && populated.display === 'none' && populated.visible === false && populated.rows === RELEASE.length,
      JSON.stringify(populated));
    await shot('plugindefaults-dark-fresh.png');
    await theme('light'); await sleep(400);
    await shot('plugindefaults-light-fresh.png');

    // …and it still appears when it is the only thing left to say.
    await js(`(() => { const input = document.querySelector('.plg-search input'); input.value = 'zzz-no-such-plugin'; input.dispatchEvent(new Event('input', { bubbles: true })); })()`);
    await sleep(300);
    const filteredOut = await emptyState();
    check('…and a search that matches nothing DOES show it, with every row gone',
      filteredOut.present && filteredOut.hiddenAttr === false && filteredOut.display !== 'none' && filteredOut.visible === true && filteredOut.rows === 0,
      JSON.stringify(filteredOut));
    await shot('plugindefaults-light-nomatches.png');
    await js(`(() => { const input = document.querySelector('.plg-search input'); input.value = ''; input.dispatchEvent(new Event('input', { bubbles: true })); })()`);
    await sleep(300);

    // ── the Supertonic detail pane, which is where a user reads these defaults ──
    const opened = await openDetail('supertonic');
    check('the Supertonic row opens its detail pane', opened === true, String(opened));
    await sleep(600);
    const detail = await readDetail('supertonic');
    check('…and the detail pane is actually on screen, not a click that went nowhere',
      !!detail && detail.name === 'Supertonic Voice' && detail.rows === 6, JSON.stringify(detail && { name: detail.name, rows: detail.rows }));
    // ⚠️ Everything above reads store.plugins. These read the CONTROLS — the only thing the user can see.
    check('the Voice select SHOWS Female 2', detail && detail.voice === 'female-2', detail && detail.voice);
    check('the Language select SHOWS en', detail && detail.language === 'en', detail && detail.language);
    check('the Quality steps number SHOWS 12', detail && detail.quality === '12', detail && detail.quality);
    check('the Text normalization select SHOWS english', detail && detail.normalization === 'english', detail && detail.normalization);
    check('the Read selection shortcut SHOWS F5', detail && /F5/.test(detail.shortcut || ''), detail && detail.shortcut);
    check('the auto-read toggle is OFF', detail && detail.autoRead === 'false', detail && detail.autoRead);
    check('…and the plugin itself reads enabled in its own pane', detail && detail.enabledSwitch === 'true', detail && detail.enabledSwitch);
    await shot('plugindefaults-light-supertonic.png');
    // The auto-read toggle is the last row and sits below the fold. Asserted above either way, but a default
    // Or cannot SEE in a capture is a default he has to take my word for.
    await js(`(() => { const body = document.querySelector('.set-body'); body.scrollTop = body.scrollHeight; })()`);
    await sleep(400);
    await shot('plugindefaults-light-supertonic-autoread.png');
    await theme('dark'); await sleep(400);
    await shot('plugindefaults-dark-supertonic.png');

    // ── B. an install that has already been configured ──────────────────────
    // The whole point of a default is that it applies ONCE. A stored boolean or value that a release default
    // silently reverts is a user's decision being taken away on upgrade.
    await openPlugins(customAddr.port);
    const b = await readPane();
    check('a stored enabled:false is honoured — the default does not switch Supertonic back on',
      b.state.supertonic && b.state.supertonic.enabled === false, JSON.stringify(b.state.supertonic && b.state.supertonic.enabled));
    check('a stored enabled:true is honoured — smart dictation stays on despite defaulting off',
      b.state['smart-dictation'] && b.state['smart-dictation'].enabled === true, JSON.stringify(b.state['smart-dictation'] && b.state['smart-dictation'].enabled));
    check('a stored setting is kept, not reset to the release default',
      b.state.supertonic && b.state.supertonic.values.voice === 'yara' && b.state.supertonic.values.quality === 8,
      JSON.stringify(b.state.supertonic && b.state.supertonic.values));
    check('…while the settings that were never touched still take their defaults',
      b.state.supertonic && b.state.supertonic.values.normalization === 'english' && b.state.supertonic.values.shortcut === 'F5',
      JSON.stringify(b.state.supertonic && b.state.supertonic.values));
    // Honouring what is stored must not mean trusting it. A value outside the manifest's options would render
    // a select with nothing selected, or ship a language the engine cannot speak.
    check('a stored value the manifest does not allow falls back to the default rather than through',
      b.state.supertonic && b.state.supertonic.values.language === 'en', JSON.stringify(b.state.supertonic && b.state.supertonic.values.language));
    check('the switches on screen follow the stored state, not the manifest',
      b.rows.every((row) => { const entry = Object.values(b.state).find((s) => s.name === row.name); return entry && entry.enabled === row.on; }),
      JSON.stringify(b.rows.map((r) => `${r.name}:${r.on}`)));
    check('an untouched plugin is unaffected by another plugin having been configured',
      b.state.emoji && b.state.emoji.enabled === true, JSON.stringify(b.state.emoji && b.state.emoji.enabled));
    await shot('plugindefaults-dark-configured.png');

    console.log(`\n${failures === 0 ? 'all checks passed' : failures + ' FAILED'}`);
  } catch (error) {
    console.log('THREW', error && error.stack || error);
    failures++;
  } finally {
    try { if (cdp) cdp.close(); } catch {}
    try { chrome.kill(); } catch {}
    try { await fresh.close(); } catch {}
    try { await custom.close(); } catch {}
  }
  process.exit(failures ? 1 : 0);
})();
