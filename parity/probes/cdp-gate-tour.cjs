// Real-Chrome gate for the guided tour, the feature tips, and the About me pane.
//
// The rules live in test-ui/tour-it.mjs and test-ui/about-me-it.mjs. This gate asks the four questions no DOM
// test can answer:
//   • Does the spotlight land on the control the copy is talking about — in PIXELS, not in intent?
//   • Do the real controls still work underneath it? A walkthrough that blocks what it points at is a poster.
//   • Does it MOVE — the highlight, the card, and the copy — and does it stop moving under reduced motion?
//   • Does a genuine first install behave differently from a returning one, end to end through the engine?
//
// ⚠️ Its dataDir is a NON-EXISTENT child directory, so the engine seeds a real first install. Nothing here
// touches Or's server or profile: own port, own Chrome, own temp profile.
const { mkdtempSync, readFileSync, writeFileSync, existsSync } = require('node:fs');
const { spawn } = require('node:child_process');
const { tmpdir } = require('node:os');
const { join } = require('node:path');
const { HeadlessServer } = require('../../src/server');
const WebSocket = require('../../node_modules/ws');

const CHROME = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const OUT = process.env.GATE_OUT || tmpdir();
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let failures = 0;
function check(name, pass, detail = '') {
  console.log(`${pass ? 'PASS' : 'FAIL'} ${name}${detail ? ` [${detail}]` : ''}`);
  if (!pass) failures++;
}
// What the engine would hand a client that connected right now — i.e. what it actually persisted, read back
// over a socket it has never seen before rather than out of an echo this probe was already holding.
async function reread(port) {
  const socket = new WebSocket(`ws://127.0.0.1:${port}`);
  const frames = [];
  socket.on('message', (raw) => { try { frames.push(JSON.parse(raw)); } catch {} });
  await new Promise((resolve, reject) => { socket.once('open', resolve); socket.once('error', reject); });
  socket.send(JSON.stringify({ type: 'config.get' }));
  const frame = await waitFor(() => frames.find((f) => f.type === 'config'), 4000);
  socket.close();
  return frame && frame.config ? (frame.config.onboarding || null) : null;
}

async function waitFor(fn, timeout = 9000) {
  const start = Date.now();
  while (Date.now() - start < timeout) { const v = await fn(); if (v) return v; await sleep(90); }
  return null;
}

(async () => {
  // A directory that does NOT exist yet: this is what makes it a first install rather than a reset one.
  const parent = mkdtempSync(join(tmpdir(), 'clideck-tour-'));
  const dataDir = join(parent, 'first-install');
  const projectDir = mkdtempSync(join(tmpdir(), 'clideck-tour-project-'));
  const server = new HeadlessServer({ port: 0, dataDir });
  const address = await server.listen();
  const base = `http://127.0.0.1:${address.port}`;

  const control = new WebSocket(`ws://127.0.0.1:${address.port}`);
  const events = [];
  control.on('message', (raw) => { try { events.push(JSON.parse(raw)); } catch {} });
  await new Promise((resolve, reject) => { control.once('open', resolve); control.once('error', reject); });
  // ⚠️ The engine does not volunteer the config: a connecting client ASKS (ws.js requestConfig → config.get).
  // A socket that just listens receives nothing, and "no onboarding key" would be a fact about this probe.
  control.send(JSON.stringify({ type: 'config.get' }));
  const configFrame = await waitFor(() => events.find((e) => e.type === 'config'));
  const seeded = configFrame && configFrame.config && configFrame.config.onboarding;
  check('a first install arrives already seeded with completed:false', !!seeded && seeded.completed === false, JSON.stringify(seeded));

  const profile = mkdtempSync(join(tmpdir(), 'clideck-tour-chrome-'));
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
    cdp.on('message', (raw) => { const m = JSON.parse(raw); const done = pending.get(m.id); if (done) { pending.delete(m.id); done(m); } });
    const command = (method, params = {}) => new Promise((resolve) => { const id = ++seq; pending.set(id, resolve); cdp.send(JSON.stringify({ id, method, params })); });
    const js = async (expression) => (await command('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true })).result?.result?.value;
    const shot = async (name) => { const r = await command('Page.captureScreenshot', { format: 'png' }); const p = join(OUT, name); writeFileSync(p, Buffer.from(r.result.data, 'base64')); console.log(`SHOT ${p}`); };
    await command('Runtime.enable');
    const size = (w, h) => command('Emulation.setDeviceMetricsOverride', { width: w, height: h, deviceScaleFactor: 1, mobile: false });
    const theme = (t) => command('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-color-scheme', value: t }] });
    const checkToken = async label => {
      const look = await js(`(()=>{
        const key=document.querySelector('.tour-body kbd.tour-key');if(!key)return null;
        const style=getComputedStyle(key), rgb=s=>s.match(/[\\d.]+/g).slice(0,3).map(Number);
        const fg=rgb(style.color),bg=rgb(style.backgroundColor);
        const luminance=c=>c.map(v=>{v/=255;return v<=.04045?v/12.92:((v+.055)/1.055)**2.4}).reduce((v,c,i)=>v+c*[.2126,.7152,.0722][i],0);
        const a=luminance(fg),b=luminance(bg);
        return {text:key.textContent,color:style.color,contrast:(Math.max(a,b)+.05)/(Math.min(a,b)+.05),amber:fg[0]>fg[1]&&fg[1]>fg[2]};
      })()`);
      check('@@ is an amber keyboard token with readable contrast ('+label+')', look?.text==='@@'&&look.amber&&look.contrast>=4.5,JSON.stringify(look));
    };
    const load = async () => { await command('Page.navigate', { url: base }); await sleep(2600); };
    const tourState = () => js(`import('/js/ui/tour.js').then(m => m.__tourForTest())`);
    const geom = () => js(`(() => {
      const spot = document.querySelector('.tour-spot'), pop = document.querySelector('.tour-pop');
      if (!spot || !pop) return null;
      const b = (el) => { const r = el.getBoundingClientRect(); return { x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height) }; };
      const cs = getComputedStyle(spot);
      return { spot: b(spot), pop: b(pop), shadow: cs.boxShadow, spotTransition: cs.transitionDuration,
        contentAnim: getComputedStyle(document.querySelector('.tour-content')).animationName,
        sheet: pop.classList.contains('tour-sheet'), eyebrow: document.querySelector('.tour-eyebrow').textContent };
    })()`);

    await size(1440, 900);
    await theme('dark');
    await load();

    // ── a first install runs the tour by itself ─────────────────────────────
    const started = await waitFor(async () => { const s = await tourState(); return s && s.mode === 'tour' ? s : null; }, 6000);
    check('a seeded first install starts the walkthrough on its own', !!started && started.index === 0 && started.total === 7, JSON.stringify(started));

    // ── the spotlight is on the control the copy names ──────────────────────
    const onProj = await js(`(() => {
      const a = document.getElementById('proj-btn').getBoundingClientRect();
      const s = document.querySelector('.tour-spot').getBoundingClientRect();
      return { dx: Math.round(Math.abs((a.x + a.width / 2) - (s.x + s.width / 2))), dy: Math.round(Math.abs((a.y + a.height / 2) - (s.y + s.height / 2))), covers: s.width >= a.width && s.height >= a.height };
    })()`);
    check('stop 1 spotlights the real New project button, concentric and covering it',
      onProj.dx <= 1 && onProj.dy <= 1 && onProj.covers, JSON.stringify(onProj));

    const g1 = await geom();
    check('the page is dimmed by the spotlight itself, not a separate sheet', /100vmax|1[0-9]{3}px/.test(g1.shadow), g1.shadow.slice(0, 90));
    check('the card sits clear of the highlight it explains', g1.pop.y > g1.spot.y + g1.spot.h - 2 || g1.pop.y + g1.pop.h < g1.spot.y + 2, JSON.stringify({ spot: g1.spot, pop: g1.pop }));
    check('the card is fully on screen', g1.pop.x >= 0 && g1.pop.y >= 0 && g1.pop.x + g1.pop.w <= 1440 && g1.pop.y + g1.pop.h <= 900, JSON.stringify(g1.pop));

    // ── the controls underneath still work ──────────────────────────────────
    const hit = await js(`(() => {
      const a = document.getElementById('proj-btn').getBoundingClientRect();
      const el = document.elementFromPoint(a.x + a.width / 2, a.y + a.height / 2);
      const veil = document.querySelector('.tour');
      // The topmost node under a button is its own <svg>, so ask which CONTROL the hit belongs to.
      const owner = el && el.closest ? el.closest('#proj-btn') : null;
      return { id: owner ? owner.id : (el && el.tagName), insideVeil: !!(veil && veil.contains(el)), pe: getComputedStyle(veil).pointerEvents, spotPe: getComputedStyle(document.querySelector('.tour-spot')).pointerEvents };
    })()`);
    check('a click at the spotlit control reaches the CONTROL, not the tour',
      hit.id === 'proj-btn' && !hit.insideVeil && hit.pe === 'none' && hit.spotPe === 'none', JSON.stringify(hit));

    // The screen a first-run user is actually looking at, underneath the card. It has no sessions, so nothing
    // repaints it after connect — which is how it sat reading "Engine offline" over a live engine.
    const emptyPane = await js(`(() => ({ big: document.getElementById('rp-empty-big').textContent, sub: document.getElementById('rp-empty-sub').textContent, live: document.getElementById('conn-text').textContent }))()`);
    check('the empty pane behind the tour reflects the LIVE engine, not the pre-connect paint',
      !/offline/i.test(emptyPane.big) && /No sessions yet/.test(emptyPane.big) && /Press \+ to start one/.test(emptyPane.sub), JSON.stringify(emptyPane));

    await shot('gate-tour-dark-stop1.png');
    check('Projects teaches direct cross-provider tasks and replies', await js(`document.querySelector('.tour-body').textContent==='Agents in a project share a folder and can send each other tasks and replies, even across providers, without you relaying messages.'`));
    for(const [mode,width,height] of [['dark',1440,900],['light',1440,900],['dark',420,780],['light',420,780]]){
      await size(width,height);await theme(mode);await sleep(450);
      check('Projects fits the screen ('+mode+' '+width+')',await js(`(()=>{const r=document.querySelector('.tour-pop').getBoundingClientRect();return r.left>=0&&r.right<=innerWidth&&r.top>=0&&r.bottom<=innerHeight})()`));
      await shot('gate-projects-'+mode+'-'+width+'.png');
    }
    await size(1440,900);await theme('dark');await sleep(450);


    // ── it moves: highlight, card and copy ──────────────────────────────────
    check('the spotlight animates between stops rather than teleporting', parseFloat(g1.spotTransition) > 0.1, g1.spotTransition);
    check('the copy animates in with it', g1.contentAnim === 'tour-in', g1.contentAnim);
    await js(`document.querySelector('.tour-primary').click()`); await sleep(500);
    const g2 = await geom();
    check('advancing moves the highlight to the next control', g2.spot.x !== g1.spot.x || g2.spot.y !== g1.spot.y, JSON.stringify({ a: g1.spot, b: g2.spot }));
    check('the counter follows the stop', /2 of 7/.test(g2.eyebrow), g2.eyebrow);

    // Saved prompts is a real stop, and its spotlit button remains usable.
    await js(`document.querySelector('.tour-primary').click()`); await sleep(550);
    check('stop 3 introduces saved prompts', (await tourState()).id === 'prompts' && (await tourState()).total === 7);
    check('saved prompt spotlight covers the existing button', await js(`(()=>{const a=document.querySelector('#prompts-btn').getBoundingClientRect(),s=document.querySelector('.tour-spot').getBoundingClientRect();return Math.abs(a.x+a.width/2-s.x-s.width/2)<2&&Math.abs(a.y+a.height/2-s.y-s.height/2)<2})()`));
    await shot('gate-tour-dark-prompts.png');
    control.send(JSON.stringify({type:'config.update',config:{prompts:[]}}));
    await waitFor(()=>js(`import('/js/store.js').then(m=>m.store.prompts.length===0)`));
    const promptButton = await js(`(()=>{const r=document.querySelector('#prompts-btn').getBoundingClientRect();return {x:r.x+r.width/2,y:r.y+r.height/2}})()`);
    await command('Input.dispatchMouseEvent', {type:'mousePressed',button:'left',clickCount:1,...promptButton});
    await command('Input.dispatchMouseEvent', {type:'mouseReleased',button:'left',clickCount:1,...promptButton});
    await sleep(400);
    check('library opens unobstructed and takes focus while the tour waits', await js(`!!document.querySelector('.pl-overlay')&&getComputedStyle(document.querySelector('.tour')).opacity==='0'&&document.activeElement===document.querySelector('.pl-filter')`));
    check('empty library explains reuse and names its create action', await js(`document.querySelector('.pl-empty-big').textContent==='Saved prompts'&&/introductions, links and instructions/.test(document.querySelector('.pl-empty-sub').textContent)&&document.querySelector('.pl-newbtn').textContent==='New prompt'`));
    await shot('gate-prompts-empty-dark.png');await theme('light');await sleep(300);await shot('gate-prompts-empty-light.png');
    await size(420,780);await sleep(350);
    check('empty library fits a narrow screen', await js(`(()=>{const m=document.querySelector('.pl-modal'),r=m.getBoundingClientRect();return r.left>=0&&r.right<=innerWidth&&m.scrollWidth<=m.clientWidth})()`));
    await shot('gate-prompts-empty-narrow.png');
    await command('Input.dispatchKeyEvent',{type:'keyDown',key:'Escape',code:'Escape',windowsVirtualKeyCode:27});
    await command('Input.dispatchKeyEvent',{type:'keyUp',key:'Escape',code:'Escape',windowsVirtualKeyCode:27});await sleep(450);
    check('Escape dismisses only the library and returns focus to this tour stop', (await tourState())?.id==='prompts'&&await js(`!document.querySelector('.pl-overlay')&&!document.querySelector('.tour').classList.contains('tour-faded')&&document.activeElement===document.querySelector('.tour-primary')`));
    await size(1440,900);await theme('dark');await sleep(450);

    // ── stops 4 and 5: asking, and where the work shows up ─────────────────
    // ⚠️ Both point at the right pane, which does not exist without a session, so this gate meets exactly what a
    // first-run user meets: the FALLBACK copy, centred, with no ring. It is the longest copy in the tour, which
    // is why it is captured in both themes.
    await js(`document.querySelector('.tour-primary').click()`); await sleep(600);
    const ask = await js(`(() => ({ title: document.querySelector('.tour-title').textContent,
      body: document.querySelector('.tour-body').textContent, eyebrow: document.querySelector('.tour-eyebrow').textContent,
      unanchored: document.querySelector('.tour').classList.contains('tour-unanchored'),
      pop: (({ x, y, width: w, height: h }) => ({ x: Math.round(x), y: Math.round(y), w: Math.round(w), h: Math.round(h) }))(document.querySelector('.tour-pop').getBoundingClientRect()) }))()`);
    check('stop 4 is Ask, after saved prompts', /4 of 7/.test(ask.eyebrow), ask.eyebrow);
    // Claims, not phrasing — Or shortened this stop to 28 words on 09-10 and the wording will move again.
    check('no-session guidance starts two agents and explains choosing the recipient',
      /^Open two agent sessions/.test(ask.body) && /choose the other/.test(ask.body) && !/reviewer/i.test(ask.body), ask.body);
    // ⚠️ "they can also ask YOU a question" is CUT copy (Or, 09-09) — asserted ABSENT so it cannot creep back.
    check('the Ask title is direct and the retired clause stays absent',
      ask.title === 'Ask another agent' && !/question to you/i.test(ask.body), ask.title);
    check('…and how to find who is around', /@@/.test(ask.body), ask.title);
    check('the longest card in the tour still fits on screen', ask.pop.x >= 0 && ask.pop.y >= 0 && ask.pop.x + ask.pop.w <= 1440 && ask.pop.y + ask.pop.h <= 900, JSON.stringify(ask.pop));
    await checkToken('no session dark');
    await shot('gate-tour-dark-ask.png');
    await theme('light'); await sleep(500);
    await checkToken('no session light');
    await shot('gate-tour-light-ask.png');
    await theme('dark'); await sleep(400);

    await js(`document.querySelector('.tour-primary').click()`); await sleep(600);
    const preview = await js(`(() => ({ title: document.querySelector('.tour-title').textContent, body: document.querySelector('.tour-body').textContent,
      eyebrow: document.querySelector('.tour-eyebrow').textContent,
      pop: (({ x, y, width: w, height: h }) => ({ x: Math.round(x), y: Math.round(y), w: Math.round(w), h: Math.round(h) }))(document.querySelector('.tour-pop').getBoundingClientRect()) }))()`);
    check('stop 5 is about seeing the work inside CliDeck', /5 of 7/.test(preview.eyebrow) && /inside CliDeck/i.test(preview.title), preview.title);
    check('…and names the kinds that open in a tab, plus the drop you can do yourself',
      /markdown/i.test(preview.body) && /video/i.test(preview.body) && /PDF/.test(preview.body)
      && /drop/i.test(preview.body) && /tab strip/i.test(preview.body), preview.body);
    check('that card fits on screen too', preview.pop.x >= 0 && preview.pop.y >= 0 && preview.pop.x + preview.pop.w <= 1440 && preview.pop.y + preview.pop.h <= 900, JSON.stringify(preview.pop));
    await shot('gate-tour-dark-preview.png');

    // ── stop 6 opens the real Settings pane and spotlights Notifications ────
    // ⚠️ There is no About me stop any more (Or, 09-09) — the pane says who it is shared with beside its own
    // title. The About me LAYOUT is still gated, further down, on Settings opened the way a user opens it.
    await js(`document.querySelector('.tour-primary').click()`); await sleep(900);
    const notify = await js(`(() => {
      const sec = document.querySelector('[data-sec="delivery"]');
      if (!sec) return null;
      const s = document.querySelector('.tour-spot').getBoundingClientRect(), a = sec.getBoundingClientRect();
      return { open: !!document.querySelector('.set-overlay'), dy: Math.round(Math.abs((a.y + a.height / 2) - (s.y + s.height / 2))),
        body: document.querySelector('.tour-body').textContent, eyebrow: document.querySelector('.tour-eyebrow').textContent };
    })()`);
    check('stop 6 opened the real Settings surface at Notifications', !!notify && notify.open, JSON.stringify(notify && notify.open));
    check('…and the highlight is on the Delivery section itself', notify && notify.dy <= 2, notify && String(notify.dy));
    // The copy Or asked for: short, and about the two things that actually make a sound.
    check('the notification stop names both cues and stays one sentence',
      /goes idle/i.test(notify.body) && /another agent/i.test(notify.body) && notify.body.split('.').filter((p) => p.trim()).length === 1,
      notify.body);
    await shot('gate-tour-dark-notify.png');

    await theme('light'); await sleep(500);
    await shot('gate-tour-light-notify.png');
    const lightInk = await js(`(() => {
      const sec = document.querySelector('[data-sec="delivery"]');
      return { sub: getComputedStyle(sec.querySelector('.set-row-s')).color, body: getComputedStyle(document.querySelector('.tour-body')).color,
        card: getComputedStyle(document.querySelector('.tour-pop')).backgroundColor, eyebrow: getComputedStyle(document.querySelector('.tour-eyebrow')).color };
    })()`);
    check('light mode repaints the card and its copy from the tokens, not from dark literals',
      lightInk.card !== 'rgb(33, 34, 41)' && lightInk.body !== 'rgb(161, 164, 173)', JSON.stringify(lightInk));

    // ── narrow ──────────────────────────────────────────────────────────────
    await size(600, 820); await sleep(600);
    const narrow = await geom();
    check('a narrow viewport docks the card to the bottom instead of chasing a 28px anchor', narrow.sheet === true);
    check('…and it stays fully on screen there', narrow.pop.x >= 0 && narrow.pop.x + narrow.pop.w <= 600 && narrow.pop.y + narrow.pop.h <= 820, JSON.stringify(narrow.pop));
    await shot('gate-tour-light-narrow.png');
    await theme('dark'); await sleep(400);
    await shot('gate-tour-dark-narrow.png');
    await size(1440, 900); await sleep(500);

    // ── reduced motion ──────────────────────────────────────────────────────
    await command('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-color-scheme', value: 'dark' }, { name: 'prefers-reduced-motion', value: 'reduce' }] });
    await sleep(400);
    const calm = await js(`(() => {
      const spot = getComputedStyle(document.querySelector('.tour-spot')), pop = getComputedStyle(document.querySelector('.tour-pop'));
      return { spot: spot.transitionDuration, pop: pop.transitionDuration, anim: getComputedStyle(document.querySelector('.tour-content')).animationName,
        transform: pop.transform, scroll: window.__tourReduced };
    })()`);
    check('reduced motion stops the highlight sliding', parseFloat(calm.spot) <= 0.01, calm.spot);
    check('reduced motion stops the card sliding and the copy animating', parseFloat(calm.pop) <= 0.01 && calm.anim === 'none', JSON.stringify(calm));
    const jsScroll = await js(`import('/js/ui/tour.js').then(m => m.reducedMotion())`);
    check('…and the JS smooth-scroll answers the same preference', jsScroll === true, String(jsScroll));
    await command('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-color-scheme', value: 'dark' }] });
    await sleep(300);

    // ── finishing persists, and a reload does not start over ────────────────
    await js(`(async () => { const m = await import('/js/ui/tour.js'); m.startTour({ from: 6 }); })()`); await sleep(500);
    const last = await js(`(() => ({ primary: document.querySelector('.tour-primary').textContent, eyebrow: document.querySelector('.tour-eyebrow').textContent }))()`);
    check('the walkthrough ends on the launch-options stop, with Done rather than Next', last.primary === 'Done' && /7 of 7/.test(last.eyebrow), JSON.stringify(last));
    await js(`document.querySelector('.tour-primary').click()`); await sleep(700);
    const savedConfig = await reread(address.port);
    check('Done is persisted by the engine as completed:true', !!savedConfig && savedConfig.completed === true, JSON.stringify(savedConfig));
    check('…together with the tip ids the tour just covered', !!savedConfig && (savedConfig.seenTips || []).includes('about-me') && (savedConfig.seenTips || []).includes('guided-tour'), JSON.stringify(savedConfig && savedConfig.seenTips));

    // ── the About me pane itself, opened the way a user opens it ────────────
    // No tour on screen: this is the pane Or actually looks at. The tour used to carry these checks because a
    // stop parked in front of it; dropping that stop must not drop the layout gate with it.
    // ⚠️ The tour now ENDS on a settings stop, so Settings is already open at CLI Agents when Done is pressed.
    // Close it first, then take the user's own path in: the gear, then General.
    await js(`(() => { const x = document.querySelector('.set-x'); if (x) x.click(); })()`); await sleep(400);
    await js(`document.getElementById('settings-btn').click()`); await sleep(600);
    await js(`(() => { const cat = [...document.querySelectorAll('.set-cat')].find((c) => c.textContent === 'General'); if (cat) cat.click(); })()`); await sleep(500);
    const about = await js(`(() => {
      const sec = document.querySelector('[data-sec="about"]');
      if (!sec) return null;
      const style = (sel, prop) => { const el = sec.querySelector(sel); return el ? getComputedStyle(el)[prop] : null; };
      return { open: !!document.querySelector('.set-overlay'),
        inputH: Math.round(sec.querySelector('input.set-input').getBoundingClientRect().height),
        selectH: Math.round(sec.querySelector('select.set-select').getBoundingClientRect().height),
        selectW: Math.round(sec.querySelector('select.set-select').getBoundingClientRect().width),
        inputW: Math.round(sec.querySelector('input.set-input').getBoundingClientRect().width),
        resize: style('textarea', 'resize'), zone: sec.querySelector('select').value,
        note: (sec.querySelector('.set-sec-note') || {}).textContent || '',
        noteInHead: !!sec.querySelector('.set-sec-h .set-sec-note'),
        noteCase: style('.set-sec-note', 'textTransform'),
        firstOption: sec.querySelector('select option').textContent, options: sec.querySelectorAll('select option').length };
    })()`);
    check('Settings opens at General with About me on it', !!about && about.open, JSON.stringify(about && about.open));
    check('the three fields share one column — name, zone and notes line up', about.inputW === about.selectW, JSON.stringify({ input: about.inputW, select: about.selectW }));
    check('the zone select matches the text input box height', Math.abs(about.inputH - about.selectH) <= 1, JSON.stringify({ input: about.inputH, select: about.selectH }));
    check('blank is the SELECTED zone, and it is a real "Not shared" option', about.zone === '' && about.firstOption === 'Not shared' && about.options > 100, JSON.stringify({ zone: about.zone, options: about.options }));
    // What the retired tour stop used to say, now four words beside the title — and NOT shouted in caps with
    // the heading it rides on.
    check('the heading itself says who the profile is shared with',
      about.noteInHead && about.note === 'shared with supported agents' && about.noteCase === 'none', JSON.stringify({ note: about.note, head: about.noteInHead, case: about.noteCase }));

    // ── the notes box rests at one line and grows with what is typed ────────
    // ⚠️ Growth is LAYOUT. A headless DOM has none, so about-me-it.mjs can only assert rows=1 — the height
    // itself has to be measured here, in a browser that has actually laid the box out.
    const grow = await js(`(() => {
      const ta = document.querySelector('[data-sec="about"] textarea');
      const h = () => Math.round(ta.getBoundingClientRect().height);
      const type = (v) => { ta.value = v; ta.dispatchEvent(new Event('input', { bubbles: true })); };
      const empty = h();
      type('one line of it');
      const one = h();
      type('a\\nb\\nc\\nd');
      const four = h();
      type('x\\n'.repeat(40));
      const many = h(), scrolls = ta.scrollHeight > ta.clientHeight + 1;
      type('');
      return { empty, one, four, many, scrolls, back: h() };
    })()`);
    check('an empty notes box is ONE line, the same box as the name input above it',
      Math.abs(grow.empty - about.inputH) <= 4, JSON.stringify({ notes: grow.empty, input: about.inputH }));
    check('…and one line of text does not make it taller', grow.one === grow.empty, JSON.stringify({ empty: grow.empty, one: grow.one }));
    check('it grows as the note grows', grow.four > grow.one + 20, JSON.stringify({ one: grow.one, four: grow.four }));
    check('…and stops growing rather than pushing the pane around — it scrolls instead',
      grow.many <= 178 && grow.scrolls, JSON.stringify({ many: grow.many, scrolls: grow.scrolls }));
    check('deleting the note returns it to one line', grow.back === grow.empty, JSON.stringify({ back: grow.back, empty: grow.empty }));
    check('the box still cannot be dragged out of shape', about.resize === 'none', about.resize);

    // ── the zone list is searchable by city, which is what people type ──────
    const zones = await js(`(() => {
      const opts = [...document.querySelectorAll('[data-sec="about"] select.set-select option')].slice(1);
      const city = (z) => z.split('/').pop().replace(/_/g, ' ');
      return { total: opts.length,
        cityFirst: opts.every((o) => o.textContent.startsWith(city(o.value))),
        sorted: opts.every((o, i) => i === 0 || city(opts[i - 1].value).localeCompare(city(o.value)) <= 0),
        firstB: (opts.find((o) => /^[Bb]/.test(o.textContent)) || {}).textContent || '' };
    })()`);
    check('every zone option leads with its city, not its continent', zones.cityFirst && zones.total > 100, JSON.stringify({ total: zones.total, cityFirst: zones.cityFirst }));
    check('…and they are ordered by city, so type-ahead lands in one run', zones.sorted, String(zones.sorted));
    check('pressing "b" reaches a B city rather than America/Bahia', /^B/.test(zones.firstB), zones.firstB);
    await shot('gate-tour-dark-about.png');
    await theme('light'); await sleep(500);
    await shot('gate-tour-light-about.png');
    await theme('dark'); await sleep(400);
    await js(`document.querySelector('.set-x').click()`); await sleep(400);

    await load();
    await sleep(2600);
    const afterReload = await tourState();
    check('a reload of a completed install shows nothing at all — no tour, no tip', afterReload === null, JSON.stringify(afterReload));

    // User-requested Ask help: no new tour, tip, or persisted onboarding mutation.
    const beforeHelp = await reread(address.port);
    for (const [mode,width,height] of [['dark',1440,900],['light',1440,900],['dark',420,780],['light',420,780]]) {
      await size(width,height);await theme(mode);await sleep(300);
      const link = await js(`(()=>{const r=document.querySelector('#team-help-btn').getBoundingClientRect();return {x:r.x+r.width/2,y:r.y+r.height/2}})()`);
      await command('Input.dispatchMouseEvent',{type:'mousePressed',button:'left',clickCount:1,...link});
      await command('Input.dispatchMouseEvent',{type:'mouseReleased',button:'left',clickCount:1,...link});await sleep(500);
      const help = await tourState();
      check('project link opens only Ask help ('+mode+' '+width+')', help?.mode==='help'&&help.id==='ask'&&help.total===1&&await js(`document.querySelector('.tour-eyebrow').textContent==='CliDeck Ask'&&document.activeElement===document.querySelector('.tour-quiet')`));
      check('Ask help fits the screen ('+mode+' '+width+')', await js(`(()=>{const r=document.querySelector('.tour-pop').getBoundingClientRect();return r.left>=0&&r.right<=innerWidth&&r.top>=0&&r.bottom<=innerHeight})()`));
      await checkToken('no session help '+mode+' '+width);
      await shot('gate-ask-help-'+mode+'-'+width+'.png');
      if(mode==='dark') await js(`document.querySelector('.tour-quiet').click()`);
      else {await command('Input.dispatchKeyEvent',{type:'keyDown',key:'Escape',code:'Escape',windowsVirtualKeyCode:27});await command('Input.dispatchKeyEvent',{type:'keyUp',key:'Escape',code:'Escape',windowsVirtualKeyCode:27});}
      await sleep(300);
      check('help dismissal restores focus to the link', (await tourState())===null&&await js(`document.activeElement===document.querySelector('#team-help-btn')`));
    }
    check('opening and dismissing help never writes tour completion or seen tips', JSON.stringify(await reread(address.port))===JSON.stringify(beforeHelp));
    await size(1440,900);await theme('dark');

    // Only isolated shell fixtures: show the active-session wording without launching any AI provider.
    for(const name of ['First agent','Second agent']) {
      control.send(JSON.stringify({type:'session.create',provider:'shell',name,cwd:projectDir}));
      await waitFor(()=>events.find(e=>e.type==='session.created'&&e.name===name));
    }
    await waitFor(()=>js(`document.querySelector('#th-name').getBoundingClientRect().width>0`));
    for(const [mode,width,height] of [['dark',1440,900],['light',1440,900],['dark',420,780],['light',420,780]]) {
      await size(width,height);await theme(mode);await sleep(300);
      await js(`import('/js/ui/tour.js').then(m=>m.startTour({from:3}))`);await sleep(500);
      check('active-session Ask keeps the exact role-free guidance ('+mode+' '+width+')', await js(`document.querySelector('.tour-body').textContent==='Type @@ to choose another agent, then tell your agent what to ask it; the agents handle the request and reply.'`));
      await checkToken('active session '+mode+' '+width);
      check('active-session Ask fits the screen ('+mode+' '+width+')',await js(`(()=>{const r=document.querySelector('.tour-pop').getBoundingClientRect();return r.left>=0&&r.right<=innerWidth&&r.top>=0&&r.bottom<=innerHeight})()`));
      await shot('gate-ask-active-'+mode+'-'+width+'.png');
      await js(`import('/js/ui/tour.js').then(m=>m.closeTour())`);await sleep(250);
    }
    await size(1440,900);await theme('dark');

    // ── the update path: an unseen tip, and only that one ───────────────────
    // A second install that is already "completed" with no tips seen is exactly a user upgrading into this
    // release. It must get ONE quiet card, not a tour.
    const upgradeDir = join(mkdtempSync(join(tmpdir(), 'clideck-tour-up-')), 'engine');
    const upgrade = new HeadlessServer({ port: 0, dataDir: upgradeDir });
    const upAddress = await upgrade.listen();
    const upBase = `http://127.0.0.1:${upAddress.port}`;
    const upControl = new WebSocket(`ws://127.0.0.1:${upAddress.port}`);
    await new Promise((resolve, reject) => { upControl.once('open', resolve); upControl.once('error', reject); });
    upControl.send(JSON.stringify({ type: 'config.update', config: { onboarding: { completed: true } } }));
    await sleep(400);
    await command('Page.navigate', { url: upBase }); await sleep(2600);
    const tip = await waitFor(async () => { const s = await tourState(); return s && s.mode === 'tip' ? s : null; }, 6000);
    check('an upgrading user gets the tour invitation before profile setup', !!tip && tip.total === 1 && tip.id === 'guided-tour', JSON.stringify(tip));
    const tipLook = await js(`(() => ({ eyebrow: document.querySelector('.tour-eyebrow').textContent, quiet: document.querySelector('.tour-quiet').textContent,
      cta: document.querySelector('.tour-primary').textContent, anchored: !!document.querySelector('.tour-spot').getBoundingClientRect().width }))()`);
    check('the tip reads as a tip, not as step 1 of something', tipLook.eyebrow === 'New' && tipLook.quiet === 'Got it', JSON.stringify(tipLook));
    await shot('gate-tour-dark-tip.png');
    await js(`document.querySelector('.tour-quiet').click()`); await sleep(700);
    await command('Page.navigate', { url: upBase }); await sleep(2600);
    const secondTip = await waitFor(async () => { const s = await tourState(); return s && s.mode === 'tip' ? s : null; }, 6000);
    check('the next load brings About me, never the acknowledged tour invitation', !!secondTip && secondTip.id === 'about-me', JSON.stringify(secondTip));
    await js(`document.querySelector('.tour-quiet').click()`); await sleep(700);
    await command('Page.navigate', { url: upBase }); await sleep(3000);
    check('once both are acknowledged the app is quiet again', (await tourState()) === null);

    // Replay must not un-see them.
    await js(`import('/js/ui/tour.js').then(m => m.startTour({ replay: true }))`); await sleep(400);
    await js(`(async () => { for (let i = 0; i < 7; i++) { document.querySelector('.tour-primary').click(); await new Promise(r => setTimeout(r, 220)); } })()`);
    await sleep(1200);
    const afterReplay = await reread(upAddress.port);
    check('a replay leaves the seen list intact', !!afterReplay && (afterReplay.seenTips || []).length === 2 && afterReplay.completed === true, JSON.stringify(afterReplay));
    await command('Page.navigate', { url: upBase }); await sleep(3000);
    check('…and still nothing pops up afterwards', (await tourState()) === null);
    await upgrade.close?.();
  } finally {
    if (cdp) cdp.close();
    chrome.kill();
    control.close();
    await server.close?.();
  }
  console.log(failures ? `\n${failures} FAILED` : '\nall checks passed');
  process.exit(failures ? 1 : 0);
})().catch((error) => { console.error(error); process.exit(1); });
