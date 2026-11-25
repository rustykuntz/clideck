// Real-Chrome gate for the v2 plugin UI: Settings management, install/trust flow, failure state,
// Worker-isolated client actions, selection context, sandboxed viewer/workspace, themes and narrow layout.
const { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync } = require('node:fs');
const { spawn } = require('node:child_process');
const { tmpdir } = require('node:os');
const { join } = require('node:path');
const { HeadlessServer } = require('../../src/server');
const WebSocket = require('../../node_modules/ws');

const CHROME = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
let failures = 0;
function check(name, pass, detail = '') {
  console.log(`${pass ? 'PASS' : 'FAIL'} ${name}${detail ? ` [${detail}]` : ''}`);
  if (!pass) failures++;
}
function plugin(root, manifest, files = {}) {
  const dir = join(root, manifest.id); mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'clideck-plugin.json'), JSON.stringify(manifest, null, 2));
  for (const [name, body] of Object.entries(files)) {
    const path = join(dir, name); mkdirSync(join(path, '..'), { recursive: true }); writeFileSync(path, body);
  }
  return dir;
}
async function waitFor(fn, timeout = 8000) {
  const start = Date.now();
  while (Date.now() - start < timeout) { const value = await fn(); if (value) return value; await sleep(80); }
  return null;
}

(async () => {
  const dataDir = mkdtempSync(join(tmpdir(), 'clideck-plugin-ui-data-'));
  const projectDir = mkdtempSync(join(tmpdir(), 'clideck-plugin-ui-project-'));
  const bundledDir = mkdtempSync(join(tmpdir(), 'clideck-plugin-ui-bundled-'));
  const sourceRoot = mkdtempSync(join(tmpdir(), 'clideck-plugin-ui-source-'));
  const sourceDir = plugin(sourceRoot, {
    id: 'installed-lab', name: 'Installed Lab', version: '1.0.0', apiVersion: 1,
    description: 'Installed through the Settings trust flow.', commands: [], settings: [],
  });
  plugin(bundledDir, {
    id: 'ui-lab', name: 'UI Laboratory', version: '2.4.1', apiVersion: 1,
    description: 'Selection tools, a viewer and a workspace.', icon: '◈', commands: [
      { name: 'inspect', description: 'Inspect selected text.', usage: 'ui-lab/inspect <text>' },
    ], settings: [
      { key: 'accent', label: 'Accent', type: 'select', default: 'violet', options: [{ value: 'violet', label: 'Violet' }, { value: 'cyan', label: 'Cyan' }] },
      { key: 'note', label: 'Workspace note', type: 'text', default: 'Ready' },
      { key: 'token', label: 'Private token', type: 'secret', default: '' },
    ], viewers: [{ id: 'preview', mime: 'text/html' }],
  }, {
    'server.js': `
      exports.activate = (api) => {
        const command = api.registerCommand('inspect', ({ args }) => args.join(' '));
        const message = api.onClientMessage('show-preview', (data) => api.showContent(data.sessionId, {
          kind:'ui-lab/preview', mime:'text/html', name:'Plugin preview', data:'<!doctype html><h1>Backend plugin preview</h1>'
        }));
        return () => { command(); message(); };
      };
    `,
    'client.js': `
      globalThis.__CLIDECK_PLUGIN_REALM__ = typeof document;
      export async function activate(api) {
        const cleanups = [];
        const initial = api.getSettings();
        cleanups.push(api.registerAction({ id:'open-studio', label:'Open Plugin Studio · ' + initial.values.note, placements:['terminal.header'], run:() => api.openWorkspace('studio') }));
        cleanups.push(api.registerAction({ id:'inspect-selection', label:'Inspect selected text', placements:['terminal.context','viewer.context'], when:(c) => !!c?.selection?.text?.trim(), run:(c) => api.openWorkspace('studio', { title:'Selected: ' + c.selection.text.trim() }) }));
        cleanups.push(api.registerAction({ id:'slow-check', label:'Never visible', placements:['terminal.context'], when:() => new Promise(()=>{}), run:()=>{} }));
        cleanups.push(api.registerAction({ id:'no-viewer', label:'Never visible', placements:['viewer.context'], when:()=>false, run:()=>{} }));
        cleanups.push(api.registerViewer({ id:'preview', kind:'ui-lab/preview', title:'Lab Preview', src:'/plugins/ui-lab/public/viewer.html' }));
        cleanups.push(api.registerWorkspace({ id:'studio', title:'Plugin Studio', src:'/plugins/ui-lab/public/workspace.html' }));
        cleanups.push(api.onSettingsChange((next) => api.toast('success', { id:'client-setting', title:'Client settings', body:'Client setting: ' + next.values.note })));
        return () => cleanups.forEach((off) => off?.());
      }
    `,
    'public/viewer.html': '<!doctype html><meta charset="utf-8"><title>Lab Preview</title><h1>Plugin preview</h1>',
    'public/workspace.html': '<!doctype html><meta charset="utf-8"><title>Plugin Studio</title><main><h1>Plugin Studio</h1><p>Opaque-origin workspace.</p></main>',
  });
  plugin(bundledDir, {
    id: 'broken-lab', name: 'Broken Laboratory', version: '1.0.0', apiVersion: 1,
    description: 'A deliberate failure-state fixture.', commands: [], settings: [],
  }, { 'server.js': 'exports.activate = () => { throw new Error("Deliberate startup failure"); };' });
  writeFileSync(join(dataDir, 'config.json'), JSON.stringify({ defaultCwd: sourceDir }));

  const server = new HeadlessServer({ port: 0, dataDir, bundledPluginsDir: bundledDir });
  const address = await server.listen(); const base = `http://127.0.0.1:${address.port}`;
  const control = new WebSocket(`ws://127.0.0.1:${address.port}`); const events = [];
  control.on('message', (raw) => { try { events.push(JSON.parse(raw)); } catch {} });
  await new Promise((resolve, reject) => { control.once('open', resolve); control.once('error', reject); });
  control.send(JSON.stringify({ type: 'session.create', provider: 'shell', name: 'plugin-gate', cwd: projectDir }));
  const created = await waitFor(() => events.find((event) => event.type === 'session.created' && event.name === 'plugin-gate'));
  if (!created) throw new Error('The probe session did not start.');
  control.send(JSON.stringify({ type: 'plugin.settings.update', pluginId: 'ui-lab', settings: { token: 'private' }, requestId: 'seed-secret' }));
  const seeded = await waitFor(() => events.find((event) => event.type === 'plugin.result' && event.requestId === 'seed-secret'));
  if (!seeded?.success) throw new Error('Could not seed the masked-secret gate.');

  const profile = mkdtempSync(join(tmpdir(), 'clideck-plugin-ui-chrome-'));
  const chrome = spawn(CHROME, ['--headless=new', '--disable-gpu', '--remote-debugging-port=0', `--user-data-dir=${profile}`, '--no-first-run', 'about:blank'], { stdio: 'ignore' });
  let cdp = null;
  try {
    const portFile = join(profile, 'DevToolsActivePort');
    await waitFor(() => existsSync(portFile));
    const debugPort = readFileSync(portFile, 'utf8').split('\n')[0].trim();
    const target = await (await fetch(`http://127.0.0.1:${debugPort}/json/new?about:blank`, { method: 'PUT' })).json();
    cdp = new WebSocket(target.webSocketDebuggerUrl, { maxPayload: 32 * 1024 * 1024 });
    await new Promise((resolve, reject) => { cdp.once('open', resolve); cdp.once('error', reject); });
    let seq = 0; const pending = new Map();
    cdp.on('message', (raw) => { const message = JSON.parse(raw); const done = pending.get(message.id); if (done) { pending.delete(message.id); done(message); } else if (message.method === 'Runtime.exceptionThrown') console.error('BROWSER', message.params?.exceptionDetails?.exception?.description || message.params?.exceptionDetails?.text); });
    const command = (method, params = {}) => new Promise((resolve) => { const id = ++seq; pending.set(id, resolve); cdp.send(JSON.stringify({ id, method, params })); });
    const js = async (expression) => (await command('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true })).result?.result?.value;
    const shot = async (name) => { const result = await command('Page.captureScreenshot', { format: 'png' }); const path = join(tmpdir(), name); writeFileSync(path, Buffer.from(result.result.data, 'base64')); console.log(`SHOT ${path}`); };
    await command('Runtime.enable');
    await command('Emulation.setDeviceMetricsOverride', { width: 1440, height: 900, deviceScaleFactor: 1, mobile: false });
    await command('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-color-scheme', value: 'dark' }] });
    await command('Page.navigate', { url: base }); await sleep(3500);

    const ready = await waitFor(() => js(`document.querySelectorAll('.row').length && !document.getElementById('plugin-actions').hidden`));
    if (!ready) console.error('PLUGIN DIAG', await js(`(async()=>{const {store}=await import('/js/store.js');const host=await import('/js/ui/plugin-host.js');return {plugins:store.plugins,error:host.pluginClientError('ui-lab'),runtimes:host.__runtimeCountForTest()}})()`));
    check('sandboxed client registers a host header action', !!ready);
    check('plugin module never executes in the main CliDeck window', await js(`typeof window.__CLIDECK_PLUGIN_REALM__ === 'undefined'`) === true);

    await js(`document.getElementById('settings-btn').click()`); await sleep(250);
    await js(`[...document.querySelectorAll('.set-cat')].find((el) => el.textContent === 'Plugins').click()`); await sleep(350);
    const inventory = await js(`({ names:[...document.querySelectorAll('.plg-name')].map((el)=>el.textContent), failed:!!document.querySelector('.plg-row.failed'), version:[...document.querySelectorAll('.plg-version')].some((el)=>el.textContent==='v2.4.1') })`);
    check('Settings inventory shows identity, version and failure state', inventory?.names.includes('UI Laboratory') && inventory?.names.includes('Broken Laboratory') && inventory.failed && inventory.version, JSON.stringify(inventory));
    const search = await js(`(async()=>{ const input=document.querySelector('.plg-search input'), same=input; input.focus(); for(const ch of 'ui laboratory'){ input.value+=ch; input.dispatchEvent(new Event('input',{bubbles:true})); await new Promise((resolve)=>setTimeout(resolve,0)); } const visible=[...document.querySelectorAll('.plg-row')].filter((row)=>!row.hidden).map((row)=>row.querySelector('.plg-name')?.textContent); const result={same:document.querySelector('.plg-search input')===same,focused:document.activeElement===same,value:same.value,visible}; same.value=''; same.dispatchEvent(new Event('input',{bubbles:true})); return result; })()`);
    check('full-query search preserves the real input node and focus', search?.same && search.focused && search.value === 'ui laboratory' && search.visible.length === 1 && search.visible[0] === 'UI Laboratory', JSON.stringify(search));
    await shot('clideck-plugin-settings-dark.png');

    // Trust acknowledgement -> folder picker at config.defaultCwd -> install by copying the selected folder.
    await js(`[...document.querySelectorAll('button')].find((el)=>el.textContent.includes('Add from folder')).click()`); await sleep(120);
    check('install flow explains the local-code trust boundary', await js(`!!document.querySelector('.plg-trust')`) === true);
    await js(`[...document.querySelectorAll('button')].find((el)=>el.textContent.includes('Choose plugin folder')).click()`);
    const pickerReady = await waitFor(() => js(`document.querySelector('.fp-select') && !document.querySelector('.fp-select').disabled`));
    check('install uses the existing folder picker', !!pickerReady);
    await js(`document.querySelector('.fp-select').click()`); await sleep(800);
    check('Settings install adds the selected plugin', await js(`document.querySelector('.plg-detail-name')?.textContent === 'Installed Lab' || [...document.querySelectorAll('.plg-name')].some((el)=>el.textContent==='Installed Lab')`) === true);

    // Detail settings stay host-owned; the client sees only masked snapshots through its narrow API.
    await js(`document.querySelector('.plg-back')?.click()`); await sleep(120);
    await js(`[...document.querySelectorAll('.plg-row-main')].find((el)=>el.textContent.includes('UI Laboratory')).click()`); await sleep(150);
    const usage = await js(`document.querySelector('.plg-command code')?.textContent`);
    check('command help preserves manifest usage and arguments', usage === 'clideck ui-lab/inspect <text>', usage || 'missing');
    const secret = await js(`({value:document.querySelector('#plugin-setting-ui-lab-token')?.value,placeholder:document.querySelector('#plugin-setting-ui-lab-token')?.placeholder,clear:document.querySelector('.plg-clear')?.textContent})`);
    check('configured secrets are masked and explicitly clearable', secret?.value === '' && /Saved/.test(secret.placeholder || '') && secret.clear === 'Clear saved secret', JSON.stringify(secret));
    await js(`document.querySelector('.plg-clear').click()`);
    const cleared = await waitFor(() => {
      const snapshots = events.filter((event) => event.type === 'plugins');
      return snapshots.at(-1)?.plugins?.find((entry) => entry.id === 'ui-lab')?.configured?.token === false;
    });
    check('clear removes the saved secret rather than writing a placeholder', !!cleared);
    await js(`(()=>{const input=document.querySelector('#plugin-setting-ui-lab-note');input.value='Updated by client';input.dispatchEvent(new Event('input',{bubbles:true}));})()`);
    const settingToast = await waitFor(() => js(`[...document.querySelectorAll('.toast')].some((el)=>el.textContent.includes('Client setting: Updated by client'))`));
    check('client-only onSettingsChange receives live non-secret settings', !!settingToast);
    await js(`document.querySelector('.set-x').click()`); await sleep(250);
    await js(`document.getElementById('plugin-actions').click()`); await sleep(180);
    check('client-only getSettings is available during activation', await js(`[...document.querySelectorAll('.menu-item')].some((el)=>el.textContent.includes('Open Plugin Studio · Ready'))`) === true);
    await js(`document.getElementById('plugin-actions').click()`); await sleep(100);

    // Select exact xterm text; only then may the context action appear. Its callback opens a workspace named
    // with the selected text, proving the immutable host context reached the Worker callback byte-for-byte.
    const contextStarted = Date.now();
    await js(`(async()=>{ const {__termForTest}=await import('/js/ui/terminal.js'); const t=__termForTest(); await new Promise((resolve)=>t.write('\\r\\nalpha plugin selection',resolve)); const y=t.buffer.active.baseY+t.buffer.active.cursorY; t.select(0,y,5); document.getElementById('term').dispatchEvent(new MouseEvent('contextmenu',{bubbles:true,clientX:300,clientY:300})); })()`);
    const selectionAction = await waitFor(() => js(`[...document.querySelectorAll('.menu-item')].some((el)=>el.textContent.includes('Inspect selected text'))`));
    check('terminal selection exposes the contextual plugin action', !!selectionAction);
    check('a stalled plugin predicate cannot stall the terminal menu', Date.now() - contextStarted < 450, `${Date.now() - contextStarted}ms`);
    await js(`[...document.querySelectorAll('.menu-item')].find((el)=>el.textContent.includes('Inspect selected text')).click()`); await sleep(450);
    const workspace = await js(`({ tabs:[...document.querySelectorAll('.cd-tab-name')].map((el)=>el.textContent), src:document.querySelector('iframe.plugin-workspace')?.getAttribute('src'), sandbox:document.querySelector('iframe.plugin-workspace')?.getAttribute('sandbox') })`);
    check('selection context opens a host-owned workspace tab', workspace?.tabs?.some((text)=>text === 'Selected: alpha') && /workspace\.html/.test(workspace.src || ''), JSON.stringify(workspace));
    check('workspace is script-capable but opaque-origin sandboxed', workspace?.sandbox === 'allow-scripts allow-forms allow-downloads');
    const workspaceLife = await js(`(async()=>{ const frame=document.querySelector('iframe.plugin-workspace'); const tab=(name)=>[...document.querySelectorAll('.cd-tab')].find((el)=>el.textContent.includes(name)); tab('Terminal').click(); const hidden=frame.hidden&&frame.isConnected; tab('Selected: alpha').click(); const same=document.querySelector('iframe.plugin-workspace')===frame&&!frame.hidden; window.dispatchEvent(new MessageEvent('message',{source:frame.contentWindow,data:{type:'clideck.toast',kind:'success',title:'Bridge',body:'bridge survived'}})); await new Promise((resolve)=>setTimeout(resolve,80)); return {hidden,same,toast:[...document.querySelectorAll('.toast')].some((el)=>el.textContent.includes('bridge survived'))}; })()`);
    check('tab switching retains the exact iframe and message bridge', workspaceLife?.hidden && workspaceLife.same && workspaceLife.toast, JSON.stringify(workspaceLife));

    // Publish through the real backend api.showContent path; the engine persists it and the browser consumes
    // the resulting content.show through the same durable dock seam as core documents.
    control.send(JSON.stringify({ type: 'plugin.message', pluginId: 'ui-lab', event: 'show-preview', data: { sessionId: created.sessionId } }));
    const shown = await waitFor(() => events.find((event) => event.type === 'content.show' && event.kind === 'ui-lab/preview'));
    await sleep(450);
    const viewer = await js(`({ tab:[...document.querySelectorAll('.cd-tab-name')].some((el)=>el.textContent==='Plugin preview'), src:document.querySelector('iframe.plugin-viewer')?.getAttribute('src'), sandbox:document.querySelector('iframe.plugin-viewer')?.getAttribute('sandbox') })`);
    check('plugin viewer uses the existing tab registry', viewer?.tab && /viewer\.html/.test(viewer.src || ''), JSON.stringify(viewer));
    check('viewer is opaque-origin sandboxed', viewer?.sandbox === 'allow-scripts allow-forms allow-downloads');
    const served = shown && await fetch(base + shown.url).then((response) => response.text());
    check('backend showContent publishes and serves the durable payload', !!shown && /Backend plugin preview/.test(served || ''));
    const viewerLife = await js(`(async()=>{ const frame=document.querySelector('iframe.plugin-viewer'); const tab=(name)=>[...document.querySelectorAll('.cd-tab')].find((el)=>el.textContent.includes(name)); tab('Terminal').click(); const hidden=frame.hidden&&frame.isConnected; tab('Plugin preview').click(); const same=document.querySelector('iframe.plugin-viewer')===frame&&!frame.hidden; frame.dispatchEvent(new PointerEvent('pointerup',{bubbles:true})); await new Promise((resolve)=>setTimeout(resolve,180)); const event=new MouseEvent('contextmenu',{bubbles:true,cancelable:true,clientX:420,clientY:360}); const native=frame.dispatchEvent(event)&&!event.defaultPrevented; return {hidden,same,native,menu:!!document.querySelector('.menu-pop')}; })()`);
    check('viewer switching retains its context and no-match preserves the native menu', viewerLife?.hidden && viewerLife.same && viewerLife.native && !viewerLife.menu, JSON.stringify(viewerLife));

    // Disable removes ephemeral workspaces but not engine-owned content; re-enable rebuilds its viewer.
    await js(`document.getElementById('settings-btn').click(); [...document.querySelectorAll('.set-cat')].find((el)=>el.textContent==='Plugins').click(); [...document.querySelectorAll('.plg-row-main')].find((el)=>el.textContent.includes('UI Laboratory')).click()`); await sleep(250);
    await js(`document.querySelector('.set-section .set-switch').click()`); await sleep(700);
    const disabled = await js(`({actionHidden:document.getElementById('plugin-actions').hidden,tabs:[...document.querySelectorAll('.cd-tab-name')].map((el)=>el.textContent),unavailable:!!document.querySelector('.cd-error')})`);
    check('disable closes workspaces but preserves durable viewer content', disabled?.actionHidden && !disabled.tabs.includes('Selected: alpha') && disabled.tabs.includes('Plugin preview') && disabled.unavailable, JSON.stringify(disabled));
    await js(`document.querySelector('.set-section .set-switch').click()`); await sleep(850);
    const enabled = await js(`({action:!document.getElementById('plugin-actions').hidden,tab:[...document.querySelectorAll('.cd-tab-name')].some((el)=>el.textContent==='Plugin preview'),viewer:!!document.querySelector('iframe.plugin-viewer')})`);
    check('re-enable restores contributions and rebuilds the persisted viewer', enabled?.action && enabled.tab && enabled.viewer, JSON.stringify(enabled));

    await command('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-color-scheme', value: 'light' }] }); await sleep(350);
    await js(`(()=>{if(!document.querySelector('.set-modal'))document.getElementById('settings-btn').click();[...document.querySelectorAll('.set-cat')].find((el)=>el.textContent==='Plugins')?.click()})()`); await sleep(350);
    check('plugin settings honor light mode', await js(`document.documentElement.dataset.theme`) === 'light');
    await shot('clideck-plugin-settings-light.png');

    await command('Emulation.setDeviceMetricsOverride', { width: 430, height: 780, deviceScaleFactor: 1, mobile: false }); await sleep(300);
    const narrow = await js(`(()=>{const m=document.querySelector('.set-modal');return {width:m.getBoundingClientRect().width,viewport:innerWidth,overflow:m.scrollWidth > m.clientWidth,nav:document.querySelector('.set-nav').getBoundingClientRect().height}})()`);
    check('narrow Settings becomes a full-width, non-overflowing surface', narrow && narrow.width <= narrow.viewport && !narrow.overflow, JSON.stringify(narrow));
    await shot('clideck-plugin-settings-narrow.png');
  } finally {
    try { cdp?.close(); } catch {} try { chrome.kill(); } catch {}
  }
  control.send(JSON.stringify({ type: 'session.close', sessionId: created.sessionId }));
  control.close(); await server.close();
  console.log(failures ? `${failures} FAILURES` : 'ALL PASS'); process.exit(failures ? 1 : 0);
})().catch((error) => { console.error(error.stack || error); process.exit(2); });
