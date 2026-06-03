---
phase: 9-terminal-display-sizing
plan: fontsize
wave: 1
depends_on: []
files_modified:
  - config.js
  - public/index.html
  - public/js/settings.js
  - public/js/terminals.js
  - public/js/app.js
  - public/tailwind.css
  - tests/font-size-clamp.test.js
  - tests/config-defaults.test.js
  - package.json
autonomous: true
covers_acceptance_criteria: [1, 2, 3, 4, 11, 12]
honors_decisions: [D-01, D-02, D-03, D-04, D-05, D-11]
must_haves:
  truths:
    - "A stepper in Settings → Appearance changes the terminal font size and every open terminal redraws at the new size within one frame"
    - "Pressing Ctrl/Cmd + = with a terminal focused increases font size by 1; Ctrl/Cmd + - decreases; Ctrl/Cmd + 0 resets to 13 — and the browser does NOT zoom"
    - "Pressing Ctrl/Cmd + = with focus inside an <input>, <textarea>, contenteditable, or with no terminal focused, lets the browser zoom normally"
    - "The chosen size survives a full browser reload (persisted in config.json via {type:'config.update'})"
    - "After a size change, each terminal's PTY receives a fresh {type:'resize', id, cols, rows} so cols/rows match the new font metrics (no clipped output)"
    - "Sizes outside 8..32 are clamped at both ends; non-integers are floored to ints"
    - "All existing Vitest suites stay green; Playwright smoke + paste E2E stay green"
  artifacts:
    - path: "config.js"
      provides: "terminalFontSize default in DEFAULTS"
      contains: "terminalFontSize"
    - path: "public/index.html"
      provides: "Stepper UI in #settings-appearance"
      contains: 'id="cfg-terminal-font-size"'
    - path: "public/js/terminals.js"
      provides: "applyFontSize() iterator + Terminal ctor reads state.cfg.terminalFontSize"
      contains: "applyFontSize"
    - path: "public/js/settings.js"
      provides: "Stepper render/extract/listener wiring; state.cfg.terminalFontSize round-trip"
      contains: "cfg-terminal-font-size"
    - path: "public/js/app.js"
      provides: "Keydown handler for Ctrl/Cmd +/-/0 with browser-zoom guard"
      contains: "terminalFontSize"
    - path: "tests/font-size-clamp.test.js"
      provides: "Vitest pin on clamp helper (8..32, integer)"
      contains: "clampFontSize"
  key_links:
    - from: "Stepper +/- buttons + keyboard shortcuts"
      to: "applyFontSize() in terminals.js"
      via: "direct function call + saveConfig() → {type:'config.update'} round-trip"
      pattern: "applyFontSize\\("
    - from: "config message arrival in app.js"
      to: "state.cfg.terminalFontSize"
      via: "case 'config' assigns msg.config → state.cfg"
      pattern: "state\\.cfg = msg\\.config"
    - from: "Terminal constructor in addTerminal()"
      to: "state.cfg.terminalFontSize"
      via: "new Terminal({ fontSize: state.cfg.terminalFontSize ?? 13, ... })"
      pattern: "fontSize: state\\.cfg\\.terminalFontSize"
---

## Goal

Ship the **terminal font-size control** workstream from SPEC.md (AC 1–4, plus the cross-cutting AC 11–12). When this plan is executed, Lance has a `−  [13px]  +  Reset` stepper in **Settings → Appearance** AND `Ctrl/Cmd + =/-/0` shortcuts that work when a terminal is focused but do **not** hijack browser zoom anywhere else. Changes apply live to every open terminal (xterm v6 live `options.fontSize` set, then `fit.fit()`, then `{type:'resize'}` to the PTY per D-03). Persistence is via `config.json` per D-05 — no localStorage paint-hint needed (D-06: terminals mount *after* the config broadcast arrives, so there's no flash).

The font-size lives in `state.cfg.terminalFontSize` (number, default 13, range 8..32, step 1) — the SPEC and CONTEXT both lock this. The big named risk is the **browser-zoom collision** on `Ctrl/Cmd + =/-/0` (D-04): the keydown handler MUST `preventDefault()` only when an actual terminal is focused, and MUST NOT capture the keys when an `<input>`, `<textarea>`, `[contenteditable="true"]`, or Settings overlay has focus. Verification includes a manual UAT step that explicitly proves browser-zoom still works in the Settings overlay.

## Tasks

<task type="tdd">
  <name>Task 1 (RED→GREEN→REFACTOR): Pin the clamp helper</name>
  <files>public/js/terminals.js, tests/font-size-clamp.test.js</files>
  <read_first>
    .planning/2026-05-27-terminal-display-sizing/SPEC.md (AC 1 + scope "Range 8–32px, step 1px, default 13px"),
    .planning/2026-05-27-terminal-display-sizing/CONTEXT.md (D-02),
    tests/paste-blobs.test.js (style template for a pure-function vitest spec — `// @vitest-environment node` header + named-import + describe/it/expect),
    public/js/terminals.js lines 450-545 (existing pure-helper pattern — `scrollbarWidth`, `estimateSize` are good neighbours)
  </read_first>
  <action>
    Add a pure exported helper `clampFontSize(n)` to public/js/terminals.js (place near the existing `estimateSize` export around line 468 — same "module-level pure helper" tier). It MUST: floor non-integer numeric inputs; clamp the integer to [8, 32]; return the default 13 for any non-finite / non-numeric / null / undefined input. Use ids/names exactly: function name `clampFontSize`, constants `FONT_SIZE_MIN = 8`, `FONT_SIZE_MAX = 32`, `FONT_SIZE_DEFAULT = 13`, all exported. RED first: create tests/font-size-clamp.test.js with the cases listed under acceptance — run `npx vitest run tests/font-size-clamp.test.js`, confirm fail. GREEN: implement minimum to pass. REFACTOR only if duplication appears in subsequent tasks. Header the test file `// @vitest-environment node` because it's pure logic — no DOM.
  </action>
  <acceptance_criteria>
    - tests/font-size-clamp.test.js asserts: `clampFontSize(13) === 13`, `clampFontSize(7) === 8`, `clampFontSize(33) === 32`, `clampFontSize(8) === 8`, `clampFontSize(32) === 32`, `clampFontSize(13.7) === 13`, `clampFontSize('14') === 14`, `clampFontSize(null) === 13`, `clampFontSize(undefined) === 13`, `clampFontSize(NaN) === 13`, `clampFontSize(-5) === 8`
    - `npx vitest run tests/font-size-clamp.test.js` exits 0
    - `grep -n "export function clampFontSize" public/js/terminals.js` finds exactly one match
    - `grep -n "FONT_SIZE_MIN\|FONT_SIZE_MAX\|FONT_SIZE_DEFAULT" public/js/terminals.js` shows all three constants exported
  </acceptance_criteria>
</task>

<task type="tdd">
  <name>Task 2 (RED→GREEN→REFACTOR): config.js DEFAULTS has terminalFontSize</name>
  <files>config.js, tests/config-defaults.test.js</files>
  <read_first>
    config.js (DEFAULTS block lines 75-93 — note: no `confirmClose: false` style pattern, just the literal keys),
    .planning/2026-05-27-terminal-display-sizing/CONTEXT.md (D-05 — "Add terminalFontSize (number, default 13)"),
    tests/paste-blobs.test.js (vitest-environment node header style)
  </read_first>
  <action>
    Add `terminalFontSize: 13` to the DEFAULTS object in config.js (place it in the appearance cluster next to `defaultTheme: 'catppuccin-mocha'`). Do not touch `migrate()` for this field — DEFAULTS spread on load (line 201) auto-backfills missing keys. RED: create tests/config-defaults.test.js with `// @vitest-environment node`, `const { load } = require('../config.js')` after `process.env.CLIDECK_DATA_DIR = mkdtempSync(...)` (mirror tests/session-reorder.test.js beforeEach/afterEach pattern). Assert `load().terminalFontSize === 13` AND `load().sidebarWidth === 354` (the sidebar plan adds this field; both DEFAULTS share this test). Run vitest, confirm fail on missing terminalFontSize. GREEN: add the key. The sidebarWidth assertion will still fail until the sidebar plan lands — leave it commented with a `// TODO PLAN-sidebar` marker so the sidebar plan un-comments it.
  </action>
  <acceptance_criteria>
    - `grep -n "terminalFontSize: 13" config.js` finds exactly one match in the DEFAULTS block (between lines 75-93)
    - `npx vitest run tests/config-defaults.test.js` exits 0
    - The test uses an isolated CLIDECK_DATA_DIR (mkdtempSync) and cleans up in afterEach
    - The sidebarWidth assertion is present but commented `// TODO PLAN-sidebar: un-comment when sidebar plan lands`
  </acceptance_criteria>
</task>

<task type="execute">
  <name>Task 3: Terminal ctor reads cfg.terminalFontSize + applyFontSize iterator</name>
  <files>public/js/terminals.js</files>
  <read_first>
    public/js/terminals.js lines 495-550 (the `new Terminal({ fontSize: 13, ... })` literal at line 538 is what we replace),
    public/js/terminals.js lines 700-750 (state.terms.set at line 746 — confirms entry shape `{ term, fit, el, ... }`),
    public/js/terminals.js lines 705-712 (doFit pattern — copy the `fit.fit() + send({type:'resize'})` pairing exactly),
    .planning/2026-05-27-terminal-display-sizing/CONTEXT.md (D-03 — "iterate state.terms, set entry.term.options.fontSize, call entry.fit.fit(), send resize per terminal")
  </read_first>
  <action>
    Two surgical edits to public/js/terminals.js:
    (1) At the `new Terminal({ ... })` literal currently around line 538, replace the hardcoded `fontSize: 13,` line with `fontSize: clampFontSize(state.cfg?.terminalFontSize),` — the `?.` on `state.cfg` guards the cold-start path where cfg might not have arrived yet, and `clampFontSize(undefined)` returns 13 by Task 1.
    (2) Export a new function `applyFontSize(px)` (place right after `estimateSize` around line 493). It MUST: call `const size = clampFontSize(px)`; iterate `state.terms.values()`; for each entry call `entry.term.options.fontSize = size`, then `entry.fit.fit()`, then `send({ type: 'resize', id: entry.id ?? <find-id-from-Map-key>, cols: entry.term.cols, rows: entry.term.rows })`. Note: the Map key IS the id — the iterator pattern is `for (const [id, entry] of state.terms) { ... }` to pick up the id. Reuse the proposeDimensions-no-change guard from doFit (line 707-708) to avoid spurious resize sends when fontSize change doesn't shift cols/rows. Do not touch `removeTerminal` or any other code path.
  </action>
  <acceptance_criteria>
    - `grep -n "fontSize: 13" public/js/terminals.js` returns 0 (the hardcoded literal is gone — comments excluded with `grep -v '^//'`)
    - `grep -n "fontSize: clampFontSize" public/js/terminals.js` finds exactly one match in the Terminal constructor
    - `grep -n "export function applyFontSize" public/js/terminals.js` finds exactly one match
    - `applyFontSize` body matches the pattern: contains `for (const [`, `state.terms`, `entry.term.options.fontSize`, `entry.fit.fit()`, `send({ type: 'resize'`
    - Manual smoke: boot a throwaway clideck on :4099, open a terminal, run in DevTools `window.__terminals?.applyFontSize ? 'ok' : 'expose-required'` — if `applyFontSize` isn't on `window`, do NOT add it (this is an internal API consumed by settings.js + app.js via the module import); the DevTools probe is just for the planner-supplied manual-UAT verification, executor should test via the Settings stepper instead
  </acceptance_criteria>
</task>

<task type="execute">
  <name>Task 4: Stepper UI in #settings-appearance + settings.js wiring</name>
  <files>public/index.html, public/js/settings.js</files>
  <read_first>
    public/index.html lines 356-368 (the existing #settings-appearance block — copy the `mb-5` + `block text-xs text-slate-400 mb-1.5` label pattern),
    public/index.html lines 274-280 (cfg-default-path input style template),
    public/js/settings.js lines 578-606 (saveConfig() — note line 587 sends `{type:'config.update', config: state.cfg}`; line 591-592 wires `change`/`input` listeners),
    public/js/terminals.js (the new `applyFontSize` export from Task 3),
    .planning/2026-05-27-terminal-display-sizing/CONTEXT.md (D-01 stepper format "− [13px] + Reset"; D-11 "in the existing Appearance tab next to theme")
  </read_first>
  <action>
    (1) Markup in #settings-appearance (insert as a new `<div class="mb-5">` block AFTER the theme picker block, before the closing `</div>` of the panel — i.e. between line 367 and 368). Structure:
      - `<label>` with text "Terminal font size"
      - A horizontal row containing: button `id="cfg-font-size-dec"` text `−`; readonly text input or span `id="cfg-font-size-display"` with `data-value="13"`; button `id="cfg-font-size-inc"` text `+`; spacer; button `id="cfg-font-size-reset"` text `Reset`
      - Match the existing slate-800 / slate-600 button styling already used by `#btn-browse-path` (line 279) so it blends in
    (2) In settings.js, add three responsibilities:
      - In `renderSettings()` (find the function — it's near where `cfg-default-theme` is set), set `document.getElementById('cfg-font-size-display').textContent = (state.cfg.terminalFontSize ?? 13) + 'px'` AND `data-value` to the number
      - Wire `+` to call `setFontSize((state.cfg.terminalFontSize ?? 13) + 1)`, `−` to `-1`, `Reset` to `setFontSize(13)`
      - Define `setFontSize(px)` in settings.js: import `clampFontSize, applyFontSize, FONT_SIZE_DEFAULT` from `./terminals.js`; clamp; set `state.cfg.terminalFontSize = clamped`; update the display element; call `applyFontSize(clamped)`; call `saveConfig()` (which already sends `{type:'config.update'}`). Disable the `−`/`+` buttons (set `disabled=true`) when at min/max so the user gets feedback.
    (3) Run `npm run build:css` afterwards if any Tailwind class used in the new markup isn't already in the JIT cache — likely a no-op since we're reusing existing classes, but run it to be safe. Commit the regenerated `public/tailwind.css` if it changed.
  </action>
  <acceptance_criteria>
    - `grep -n 'id="cfg-font-size-display"' public/index.html` finds exactly one match inside #settings-appearance (verify by reading 10 lines of context above the match — should be inside the `<div id="settings-appearance">` panel, not elsewhere)
    - `grep -n 'id="cfg-font-size-inc"\|id="cfg-font-size-dec"\|id="cfg-font-size-reset"' public/index.html` finds three matches
    - `grep -n "function setFontSize\|setFontSize(" public/js/settings.js` finds the definition and at least 3 call sites
    - `grep -n "import.*applyFontSize" public/js/settings.js` shows the named import from `./terminals.js`
    - Manual UAT (throwaway :4099): open the app, click the Settings gear, click Appearance, see the stepper rendered with "13px"; click `+` ten times; observe the size readout become 23px AND every open terminal grow ten 1px increments; reload the browser; observe the stepper still shows 23px and terminals are still at 23px font; click `Reset`; observe both go back to 13px
  </acceptance_criteria>
</task>

<task type="execute">
  <name>Task 5: Keydown handler for Ctrl/Cmd +/-/0 with browser-zoom guard</name>
  <files>public/js/app.js</files>
  <read_first>
    .planning/2026-05-27-terminal-display-sizing/CONTEXT.md (D-04 — the named-risk decision; verbatim: "preventDefault() only when a terminal is focused (and not when an input/contenteditable/search box is focused)"),
    .planning/2026-05-27-terminal-display-sizing/SPEC.md (AC 4),
    public/js/app.js lines 1-15 (existing import block — add `applyFontSize, clampFontSize, FONT_SIZE_DEFAULT` to the existing `from './terminals.js'` import on line 3),
    public/js/app.js (search for existing `addEventListener('keydown'` — the executor should attach the new listener at the same lifecycle moment; near nav.js wiring or right after `state.ws.onmessage` is fine — module top-level, document-level capture phase=false (bubble))
  </read_first>
  <action>
    Add a single document-level keydown listener in app.js. Logic (in order):
    1. Only proceed if `(e.ctrlKey || e.metaKey)` AND key is `'='`, `'+'`, `'-'`, or `'0'`. (Note: `=` is the unshifted key for `+` on most layouts; check `e.key === '='` OR `e.key === '+'` for the "increase" case; `-` for decrease; `'0'` for reset.) Ignore if any *other* modifier (Alt, Shift on a non-`+` key) is held.
    2. Compute `isTerminalFocused`: TRUE iff `document.activeElement.closest('.term-wrap.active')` is non-null AND no settings overlay panel is active (check `document.getElementById('settings-overlay').classList.contains('hidden')` === true, i.e. settings is closed). Also FALSE if `document.activeElement` matches `input, textarea, [contenteditable="true"], select`.
    3. If `!isTerminalFocused` → return WITHOUT preventDefault — let browser zoom proceed normally. This is the load-bearing browser-zoom-guard from D-04.
    4. If isTerminalFocused → `e.preventDefault()` then dispatch: `=`/`+` → `applyFontSize((state.cfg.terminalFontSize ?? 13) + 1)` and update `state.cfg.terminalFontSize` + `send({type:'config.update', config: state.cfg})`; `-` → -1; `'0'` → `applyFontSize(FONT_SIZE_DEFAULT)` and reset `state.cfg.terminalFontSize = 13` + send config.update.
    5. After dispatch, if Settings is open also call `renderSettings()` so the stepper readout stays in sync. (Cheap; renderSettings is idempotent.)
    Do NOT factor this into a separate module — it's ~30 lines and lives alongside the other top-level handlers in app.js. Do NOT add `applyFontSize` to the existing import line BEFORE Task 3 lands — this task depends on Task 3.
  </action>
  <acceptance_criteria>
    - `grep -n "addEventListener('keydown'" public/js/app.js` shows the new listener (count may be > 1 if other handlers already exist; the new one specifically contains the string `terminalFontSize`)
    - `grep -n "terminalFontSize" public/js/app.js` finds at least three references (one increase, one decrease, one reset) in the keydown handler
    - The handler short-circuits BEFORE preventDefault when `closest('.term-wrap.active')` is null OR when `activeElement` matches input/textarea/contenteditable — verify by reading the function and checking the order: focus check happens first, preventDefault second
    - Manual UAT (throwaway :4099):
       (a) Open a terminal, click into it so it has focus, press Ctrl+= — font size grows by 1, browser does NOT zoom (page chrome remains identical, `window.devicePixelRatio` and `document.documentElement.clientWidth` unchanged).
       (b) Press Ctrl+- — font shrinks by 1, no browser zoom.
       (c) Press Ctrl+0 — font snaps to 13px, no browser zoom.
       (d) Open Settings (gear icon), click into the "Default working directory" text input, press Ctrl+= — browser zooms in normally (this is the D-04 guard working). Press Ctrl+0 to restore browser zoom.
       (e) With no terminal focused (e.g. focus the sidebar search input), press Ctrl+= — browser zooms in normally.
       (f) Holding Alt+Ctrl+= does nothing (other modifiers ignored).
  </acceptance_criteria>
</task>

<task type="execute">
  <name>Task 6: Version bump + manual UAT pass + commit</name>
  <files>package.json</files>
  <read_first>
    ~/.claude/CLAUDE.md §3 (commit but do NOT push; GitHub remote),
    ~/.claude/CLAUDE.md memory file note "Bump version on every code change" (the version surfaces in the connection lozenge),
    package.json line 3 (read CURRENT version live — never hardcode; bump patch by 1)
  </read_first>
  <action>
    Read line 3 of `package.json` to get the current patch version (will be `1.31.10` or higher if other work landed). Bump patch by 1 (e.g. `1.31.10` → `1.31.11`). Run the full automated verification: `npx vitest run` (must be all-green, including the two new test files) and `npx playwright test` (must be all-green — smoke + paste + interactions). If anything fails, fix forward; do not commit until both suites are green. Run `npm run build:css` once at the end and commit `public/tailwind.css` if it changed. Stage and commit with a verbose message in Lance's personal-project style describing what the font-size workstream does, the D-04 browser-zoom guard rationale, the live-apply pattern from D-03, and the test coverage added. DO NOT `git push` (~/.claude/CLAUDE.md §3: GitHub remote = commit only).
  </action>
  <acceptance_criteria>
    - `grep -n '"version"' package.json | head -1` shows the bumped version (current + 1 patch)
    - `npx vitest run` exits 0 with all suites passing including `tests/font-size-clamp.test.js` and `tests/config-defaults.test.js`
    - `npx playwright test` exits 0 (smoke + paste + interactions suites all green)
    - `git log -1 --format='%s'` shows a descriptive commit subject mentioning font-size or the phase name
    - `git status` after commit shows clean working tree
    - No `git push` was executed (confirm via `git log origin/main..HEAD --oneline` shows the new commit ahead of origin)
    - Manual UAT verification: boot `CLIDECK_PORT=4099 CLIDECK_DATA_DIR=<fresh-tmp> npm start`, open http://localhost:4099, observe the connection lozenge reflects the bumped version, open two terminals, run the full UAT cases from Task 4 and Task 5 acceptance — every case must pass. Then `taskkill /F /IM node.exe /FI "WINDOWTITLE eq clideck*"` or close the spawned node, and remove the throwaway data dir.
  </acceptance_criteria>
</task>

## Verification

### Automated
- `npx vitest run` — all 88 existing tests stay green + 2 new files pass (`font-size-clamp.test.js`, `config-defaults.test.js`); covers AC 11.
- `npx playwright test` — all e2e suites stay green; covers AC 12.

### Manual UAT (throwaway :4099 — see CLAUDE.md memory `feedback_verify-clideck-ui-altport-playwright.md`)
Boot:
```
$tmp = New-Item -ItemType Directory -Path "$env:TEMP\clideck-uat-$([guid]::NewGuid().ToString('N').Substring(0,8))"
$env:CLIDECK_PORT = "4099"; $env:CLIDECK_DATA_DIR = $tmp.FullName
npm start
```
Then open http://localhost:4099 in a separate browser window (so your dev instance on :4000 isn't disturbed). Verify, in order:

1. **AC 1 (Settings control changes size live):** Open two terminals. Settings → Appearance — see "Terminal font size" stepper at 13px. Click `+` five times. Both terminals grow visibly within ~one frame each click. Display reads `18px`.
2. **AC 2 (Persists across reload):** Hard-reload the page (Ctrl+Shift+R). Terminals reappear at 18px font; stepper shows 18px. Re-open Settings to confirm the readout.
3. **AC 3 (PTY reflows):** With the size at 18px, in any terminal run `tput cols` (or `echo $COLUMNS` if shell). The reported cols matches the xterm visual width — no overflow, no clipped right edge.
4. **AC 4 — happy path (shortcuts work in terminal):** Click into a terminal. Press Ctrl+=. Font grows. Ctrl+-. Shrinks. Ctrl+0. Snaps to 13px. Browser chrome unaffected; `window.devicePixelRatio` and zoom indicator unchanged.
5. **AC 4 — guard path (shortcuts DON'T hijack zoom elsewhere):** Open Settings → General. Focus the "Default working directory" input. Press Ctrl+=. The browser zooms in (the page itself enlarges, including chrome scroll). Press Ctrl+0 to restore. Now click the sidebar search box. Ctrl+=. Browser zooms in (this is correct — terminal isn't focused). Restore with Ctrl+0.
6. **AC 4 — guard path (Reset button):** With stepper at non-13, click Reset. Goes to 13px. Persists across reload.

Tear down:
```
taskkill /F /IM node.exe   # the throwaway clideck only
Remove-Item -Recurse -Force $tmp.FullName
```

## Risks

- **R1 (D-04, named risk in CONTEXT.md): Ctrl/Cmd +/-/0 hijacks browser zoom in non-terminal contexts.** Mitigation: focus check FIRST, preventDefault SECOND (Task 5). The keydown handler explicitly skips when activeElement is an input/textarea/contenteditable OR when no `.term-wrap.active` ancestor is found. Manual UAT step 5 is the load-bearing verification — if browser zoom is broken in Settings, the guard is wrong and the plan fails its acceptance criteria.
- **R2 — User has another OS keybinding on Ctrl+=/-/0 (e.g. tmux pass-through, IME, OS-level zoom).** Out of plan scope; clideck-level handler does the right thing and OS-level handlers are outside our control. If Lance reports a collision with his own keymap during UAT, surface it as a follow-up todo, don't extend the handler.
- **R3 — Tailwind JIT misses a class from the new stepper markup.** Mitigation: Task 4 runs `npm run build:css` and commits the regenerated `public/tailwind.css`. Reuse existing classes wherever possible (slate-800, slate-600, px-3, py-2, rounded-md — all already in the cache from `#btn-browse-path`).
- **No threat model:** This phase has no auth, no PII, no network surface, no third-party packages — security_enforcement is moot. Noted per orchestrator guidance.

## Output

Commit (no push). Phase 9 is half-done after this plan; sidebar plan (PLAN-sidebar.md) is independent and can run in the same wave.
