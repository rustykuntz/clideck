---
phase: 9-terminal-display-sizing
plan: sidebar
wave: 2
depends_on: [fontsize]
files_modified:
  - config.js
  - public/index.html
  - src/input.css
  - public/tailwind.css
  - public/js/sidebar-resize.js
  - public/js/app.js
  - public/js/settings.js
  - public/js/terminals.js
  - tests/sidebar-width-clamp.test.js
  - tests/config-defaults.test.js
  - package.json
autonomous: true
covers_acceptance_criteria: [5, 6, 7, 8, 9, 10, 11, 12]
honors_decisions: [D-05, D-06, D-07, D-08, D-09, D-10]
must_haves:
  truths:
    - "Dragging the gutter between sidebar and main narrows or widens the sidebar; the terminal pane reflows live (one re-fit per requestAnimationFrame, no PTY messages during drag)"
    - "On pointerup, each open terminal's PTY receives a fresh {type:'resize', id, cols, rows}"
    - "Width is clamped to [280, min(640, 50vw)] during drag — you cannot drag below 280 or above the cap, no matter how fast you fling the pointer"
    - "Double-clicking the gutter resets the sidebar to the default 354 px"
    - "Chosen width persists across reloads via config.json (source of truth, D-05) and applies BEFORE first paint via a localStorage paint-hint (D-06) — no visible 354→user-width jump on reload"
    - "Below 960 px viewport, the gutter is inert (pointer-events:none) and the existing body.mobile-nav-open overlay flow is untouched"
    - "All existing Vitest suites stay green; Playwright smoke + paste E2E stay green"
  artifacts:
    - path: "config.js"
      provides: "sidebarWidth default in DEFAULTS"
      contains: "sidebarWidth"
    - path: "public/index.html"
      provides: "Gutter element between #sidebar and #main"
      contains: 'id="sidebar-resize-gutter"'
    - path: "src/input.css"
      provides: "Gutter styles + mobile-breakpoint inert rule"
      contains: ".sidebar-resize-gutter"
    - path: "public/js/sidebar-resize.js"
      provides: "Pointer drag handlers, clampWidth, dblclick reset, paint-hint sync, applyWidth iterator"
      contains: "clampSidebarWidth"
    - path: "public/tailwind.css"
      provides: "Built CSS including the new gutter rules"
      contains: ".sidebar-resize-gutter"
  key_links:
    - from: "DOMContentLoaded paint-hint"
      to: "#sidebar inline style width"
      via: "localStorage.getItem('clideck.sidebarWidth') applied before first paint"
      pattern: "localStorage\\.getItem\\('clideck\\.sidebarWidth'\\)"
    - from: "case 'config' in app.js"
      to: "applySidebarWidth(state.cfg.sidebarWidth)"
      via: "config arrival overrides paint-hint and re-syncs localStorage"
      pattern: "applySidebarWidth"
    - from: "pointerup at end of drag"
      to: "iterate state.terms → fit.fit() + send({type:'resize'})"
      via: "deferred PTY resize per D-07 (no SIGWINCH spam during drag)"
      pattern: "send.*type: 'resize'"
---

## Goal

Ship the **resizable left sidebar** workstream from SPEC.md (AC 5–10, plus the cross-cutting AC 11–12). When this plan is executed, Lance can drag the right edge of the sidebar to any width in [280, min(640, 50vw)] and the terminal pane reflows live in real time. On release, every open terminal's PTY gets a fresh `{type:'resize'}` message (per D-07: defer PTY resize to drag-end to avoid SIGWINCH spam). Double-click resets to 354 px. Width persists in `config.json` (single source of truth per D-05) with a `localStorage` paint-hint mirror (per D-06) so reloads don't flash from default→user-width. Below the 960 px breakpoint the gutter is fully inert and the existing `body.mobile-nav-open` overlay flow is preserved (D-10).

The plan creates one new front-end module `public/js/sidebar-resize.js` that owns the drag state, the clamp helper (TDD-pinned in Task 1), the paint-hint mirror, and the on-config-update sync. It exports `applySidebarWidth(px)` for app.js to call when a `config` message arrives. The gutter element is a 5px-wide div with a ~12px transparent hit-zone (via padding) — `cursor: col-resize`, subtle highlight on hover/active, lives in `src/input.css` next to the `.drop-overlay` styles per D-09. Built CSS goes through `npm run build:css` and the regenerated `public/tailwind.css` is committed.

This plan is **independent of PLAN-fontsize**. The only shared file is `config.js` (both add a key to DEFAULTS) and `tests/config-defaults.test.js` (PLAN-fontsize creates it with a commented-out sidebarWidth line; this plan un-comments it). Execute order: ideally PLAN-fontsize first so the test file exists, but the two plans can run truly parallel if the executor creates `tests/config-defaults.test.js` here when missing. They share no functional surface.

## Tasks

<task type="tdd">
  <name>Task 1 (RED→GREEN→REFACTOR): Pin the width-clamp helper</name>
  <files>public/js/sidebar-resize.js, tests/sidebar-width-clamp.test.js</files>
  <read_first>
    .planning/2026-05-27-terminal-display-sizing/SPEC.md (AC 6: "min/max bounds"),
    .planning/2026-05-27-terminal-display-sizing/CONTEXT.md (D-08 verbatim: "min 280px, max min(640px, 50vw), default/reset 354px"),
    tests/font-size-clamp.test.js (style template for the unit test — `// @vitest-environment node`, simple pure-function spec; create this from PLAN-fontsize Task 1 first if it doesn't yet exist),
    tests/folder-picker-host-button.test.js (alternate style sample if happy-dom env is preferred — but for pure number-clamp logic, node env is cleaner)
  </read_first>
  <action>
    Create new file `public/js/sidebar-resize.js`. Export constants `SIDEBAR_WIDTH_MIN = 280`, `SIDEBAR_WIDTH_MAX_HARD = 640`, `SIDEBAR_WIDTH_DEFAULT = 354`. Export a pure helper `clampSidebarWidth(px, viewportWidth)` that: floors the requested `px` to int; computes `effectiveMax = Math.min(SIDEBAR_WIDTH_MAX_HARD, Math.floor(viewportWidth * 0.5))`; clamps to `[SIDEBAR_WIDTH_MIN, effectiveMax]`; returns `SIDEBAR_WIDTH_DEFAULT` for any non-finite / non-numeric / null / undefined first arg; falls back to `effectiveMax = SIDEBAR_WIDTH_MAX_HARD` if `viewportWidth` is non-finite (defensive — viewport will always be a number in production but tests pass NaN/undefined). RED: create tests/sidebar-width-clamp.test.js with `// @vitest-environment node`, cover the cases listed under acceptance, run `npx vitest run tests/sidebar-width-clamp.test.js` confirm fail. GREEN: implement clamp. REFACTOR optional.
  </action>
  <acceptance_criteria>
    - tests/sidebar-width-clamp.test.js asserts: `clampSidebarWidth(354, 1920) === 354`; `clampSidebarWidth(100, 1920) === 280` (clamp low); `clampSidebarWidth(9999, 1920) === 640` (clamp to hard cap because 50vw=960 > 640); `clampSidebarWidth(9999, 1000) === 500` (clamp to 50vw because that's lower than 640); `clampSidebarWidth(280, 600) === 300` (50vw=300 is the cap, but also the min is 280; effective cap=300, value 280 stays at 280 — wait, recompute: min=280, cap=300, requested=280 → stays 280. So: `clampSidebarWidth(290, 600) === 290`; `clampSidebarWidth(400, 600) === 300`); `clampSidebarWidth(354.7, 1920) === 354`; `clampSidebarWidth(null, 1920) === 354`; `clampSidebarWidth('500', 1920) === 500`; `clampSidebarWidth(500, NaN) === 500` (defensive fallback caps at 640); `clampSidebarWidth(-50, 1920) === 280`
    - `npx vitest run tests/sidebar-width-clamp.test.js` exits 0
    - `grep -n "export function clampSidebarWidth\|export const SIDEBAR_WIDTH" public/js/sidebar-resize.js` shows the helper and three constants exported
  </acceptance_criteria>
</task>

<task type="tdd">
  <name>Task 2 (RED→GREEN→REFACTOR): config.js DEFAULTS has sidebarWidth</name>
  <files>config.js, tests/config-defaults.test.js</files>
  <read_first>
    config.js DEFAULTS block (lines 75-93),
    .planning/2026-05-27-terminal-display-sizing/CONTEXT.md (D-05 — "sidebarWidth (number px, default 354)"),
    tests/config-defaults.test.js (if it exists from PLAN-fontsize Task 2, un-comment the sidebarWidth line; if missing, create with both font-size and sidebar assertions following the PLAN-fontsize Task 2 pattern using mkdtempSync + CLIDECK_DATA_DIR per tests/session-reorder.test.js)
  </read_first>
  <action>
    Add `sidebarWidth: 354` to the DEFAULTS object in config.js, place adjacent to `terminalFontSize` (or insert alone if PLAN-fontsize hasn't landed yet — both keys land in the same DEFAULTS cluster near `defaultTheme`). Un-comment the `sidebarWidth` assertion in tests/config-defaults.test.js (or add it if the file was created freshly here). Migrations: not needed — the DEFAULTS spread in `load()` line 201 (`{ ...deepCopy(DEFAULTS), ...JSON.parse(...) }`) means existing configs auto-backfill `sidebarWidth: 354` on first read, but any user who has already saved a config in the past won't have the key persisted until they next change a setting; this is acceptable per CONTEXT.md and matches how `notifyMinWork: 0` was added historically.
  </action>
  <acceptance_criteria>
    - `grep -n "sidebarWidth: 354" config.js` finds exactly one match in DEFAULTS (between lines 75-93)
    - `npx vitest run tests/config-defaults.test.js` exits 0 with BOTH the terminalFontSize and sidebarWidth assertions active (no commented-out lines remaining for either)
  </acceptance_criteria>
</task>

<task type="execute">
  <name>Task 3: Gutter element in HTML + CSS in src/input.css + build:css</name>
  <files>public/index.html, src/input.css, public/tailwind.css</files>
  <read_first>
    public/index.html lines 60-127 (the `@media (max-width: 960px)` block — note line 120 `#sidebar { width: auto !important; min-width: 0 !important; flex: 1 1 auto; }`, this is what governs mobile),
    public/index.html line 167 (`<aside id="sidebar" class="w-[354px] min-w-[354px] ...">` — the gutter goes immediately after this element's closing `</aside>` on line 253; it must NOT be inside `#sidebar-shell`, it must be a sibling of `<aside>` so it sits between the sidebar and `<main>`),
    public/index.html line 257 (`<main id="main" class="flex-1 ...">`),
    public/index.html lines 134-254 (the surrounding `#sidebar-shell` wrapper — the gutter is INSIDE `#sidebar-shell` per the existing flex layout, but it's a sibling of `<aside id="sidebar">`. Re-read lines 134-145 carefully to confirm — `#sidebar-shell` contains `<nav id="nav-rail">` and `<aside id="sidebar">`. The gutter must go inside `#sidebar-shell` AFTER `<aside>` so it's positioned at the sidebar's right edge and respects the same `display:flex` flow),
    src/input.css lines 240-256 (the `.term-wrap` block is a good neighbour for the new `.sidebar-resize-gutter` rule),
    .planning/2026-05-27-terminal-display-sizing/CONTEXT.md (D-09 — "~5px-wide drag handle on the sidebar's right edge, cursor: col-resize, transparent by default with a subtle highlight on hover/active and a slightly larger invisible hit zone"; D-10 — "inert below the 960px breakpoint")
  </read_first>
  <action>
    (1) In public/index.html, insert `<div id="sidebar-resize-gutter" class="sidebar-resize-gutter" aria-hidden="true"></div>` between the closing `</aside>` on line 253 and the closing `</div>` of `#sidebar-shell` on line 254. (Read those exact lines first to find the precise insertion point.)
    (2) In src/input.css, append a new rule block after the existing `.term-wrap` styles (around line 256). The rule MUST define:
      - `.sidebar-resize-gutter { width: 5px; flex-shrink: 0; cursor: col-resize; position: relative; background: transparent; transition: background 0.15s ease; }`
      - `.sidebar-resize-gutter::before { content: ''; position: absolute; inset: 0 -4px; }` — invisible 13px-wide hit zone (5px gutter + 4px padding each side) for ergonomic grabbing
      - `.sidebar-resize-gutter:hover { background: color-mix(in srgb, var(--color-border) 50%, transparent); }`
      - `.sidebar-resize-gutter.dragging { background: color-mix(in srgb, var(--color-border) 75%, transparent); }`
      - Inside `@media (max-width: 960px) { ... }` — but this is a raw `<style>` block in index.html, NOT in tailwind.css source. So instead, in src/input.css, add `@media (max-width: 960px) { .sidebar-resize-gutter { display: none; pointer-events: none; } }` to disable the gutter on mobile (D-10 — mobile flow is untouched).
    (3) Important: the `<aside id="sidebar">` element currently has `min-w-[354px]` which would fight a JS-driven width change. Override in src/input.css with `#sidebar { min-width: 0 !important; }` for desktop widths, OR drop the `min-w-[354px]` Tailwind class from the HTML (preferred: drop it from HTML so the cascade is cleaner — the new JS-applied inline `width` on `#sidebar` is the canonical width source). Strip `min-w-[354px]` from line 167; keep `w-[354px]` because that's the cold-start before JS or paint-hint sets an inline width.
    (4) Run `npm run build:css`. Commit the regenerated `public/tailwind.css`.
  </action>
  <acceptance_criteria>
    - `grep -n 'id="sidebar-resize-gutter"' public/index.html` finds exactly one match
    - The gutter element is a child of `#sidebar-shell` and a sibling that comes after `</aside>` — verify by reading 5 lines context around the match
    - `grep -n ".sidebar-resize-gutter" src/input.css` finds at least three rules (base, hover, dragging) plus the mobile @media inert rule
    - `grep -n "min-w-\[354px\]" public/index.html` returns 0 (the Tailwind class was stripped from `<aside id="sidebar">`)
    - `grep -n ".sidebar-resize-gutter" public/tailwind.css` shows the built CSS contains the new selector (post-build:css)
    - Manual smoke: boot :4099, observe a thin transparent vertical strip exists between sidebar and main; hovering it shows the col-resize cursor and a subtle highlight; resize browser to <960px width, gutter visually disappears, sidebar collapses to the existing mobile overlay flow
  </acceptance_criteria>
</task>

<task type="execute">
  <name>Task 4: Pointer drag handlers + applyWidth iterator in sidebar-resize.js</name>
  <files>public/js/sidebar-resize.js</files>
  <read_first>
    public/js/terminals.js lines 700-712 (the doFit pattern — copy the fit.fit() + send({type:'resize'}) pairing),
    public/js/terminals.js line 746 (state.terms.set entry shape `{ term, fit, el, ... }`),
    .planning/2026-05-27-terminal-display-sizing/CONTEXT.md (D-07 verbatim: "Live visual reflow during drag... DEFER the PTY {type:'resize'} message to drag-end (pointerup)"; D-09 gutter affordance; D-10 mobile inert),
    public/js/state.js (to confirm state.terms shape and state.cfg shape — read whatever's there),
    public/js/drag.js (existing pointer-drag module — use its structural patterns: pointerdown captures pointer, pointermove updates state via rAF, pointerup releases capture)
  </read_first>
  <action>
    Extend the public/js/sidebar-resize.js module (already started in Task 1 with the clamp helper and constants). Add:
    (1) `export function applySidebarWidth(px)` — clamps via `clampSidebarWidth(px, window.innerWidth)`, sets `document.getElementById('sidebar').style.width = clamped + 'px'`, mirrors to `localStorage.setItem('clideck.sidebarWidth', String(clamped))`. Does NOT re-fit terminals (separate concern, see (3)).
    (2) Module-level pointer handlers attached on `init()` (export an `init` that app.js calls once after DOMContentLoaded):
      - On `pointerdown` on `#sidebar-resize-gutter`: if `window.innerWidth <= 960` return (mobile inert per D-10); `e.preventDefault()`; capture pointer via `gutter.setPointerCapture(e.pointerId)`; record `dragStartX = e.clientX`, `dragStartWidth = parseInt(getComputedStyle(sidebar).width, 10)`; add class `dragging` to gutter; add class `dragging` to `<body>` so we can globally disable terminal pointer-events during drag (CSS rule: `body.sidebar-resizing #terminals { pointer-events: none; user-select: none; }` — add this to src/input.css in Task 3 or here as a follow-up; if Task 3 already shipped, append to src/input.css now and re-run build:css).
      - On `pointermove`: throttle via `requestAnimationFrame` (one update per frame max, per D-07); compute `next = clampSidebarWidth(dragStartWidth + (e.clientX - dragStartX), window.innerWidth)`; set sidebar inline `width = next + 'px'`; iterate `state.terms.values()` and call `entry.fit.fit()` per entry (visual reflow). DO NOT send `{type:'resize'}` to PTYs here — that's reserved for pointerup.
      - On `pointerup` / `pointercancel`: release pointer capture; remove `dragging` classes; iterate `state.terms.values()` and call `entry.fit.fit()` once more (final fit) THEN `send({ type: 'resize', id, cols: entry.term.cols, rows: entry.term.rows })` per terminal (per D-07: PTY resize on release only); persist via `state.cfg.sidebarWidth = currentWidth; send({type:'config.update', config: state.cfg})`; mirror to localStorage one final time.
    (3) `dblclick` on the gutter → call `applySidebarWidth(SIDEBAR_WIDTH_DEFAULT)` + iterate state.terms → fit + send resize + persist via config.update (this is also a "user committed a new width" event, treat it like a drag-end).
    (4) Module-level `DOMContentLoaded` paint-hint: read `localStorage.getItem('clideck.sidebarWidth')` SYNCHRONOUSLY at module load (before any paint). If present and a finite number in [SIDEBAR_WIDTH_MIN, SIDEBAR_WIDTH_MAX_HARD], set `#sidebar` inline width immediately. This MUST happen before xterm mounts and before the config WS message arrives. (D-06: "applying it synchronously on DOMContentLoaded"; config arrives later and wins.) Note: the paint-hint script must run after the DOM has `#sidebar` available; since this module is imported by app.js which is loaded at the bottom of index.html, DOMContentLoaded is essentially already fired by the time imports resolve — read localStorage and apply directly during module top-level execution. If `#sidebar` isn't in the DOM at module load, wrap in `document.addEventListener('DOMContentLoaded', ...)` for safety.
    (5) Imports: import `state, send` from `./state.js`. Export: `init`, `applySidebarWidth`, `clampSidebarWidth`, `SIDEBAR_WIDTH_MIN`, `SIDEBAR_WIDTH_MAX_HARD`, `SIDEBAR_WIDTH_DEFAULT`.
  </action>
  <acceptance_criteria>
    - `grep -n "export function applySidebarWidth\|export function init" public/js/sidebar-resize.js` finds both
    - `grep -n "setPointerCapture\|releasePointerCapture" public/js/sidebar-resize.js` shows pointer-capture usage
    - `grep -n "requestAnimationFrame" public/js/sidebar-resize.js` shows the rAF throttle in pointermove
    - During pointermove, the only WS message sent is NOT `{type:'resize'}` — verify by reading the pointermove handler and confirming no `send({` call inside its body. PTY resize is exclusively in pointerup/dblclick.
    - `grep -n "localStorage.getItem.*clideck.sidebarWidth\|localStorage.setItem.*clideck.sidebarWidth" public/js/sidebar-resize.js` finds at least one getItem (paint-hint) and at least two setItem calls (apply + drag-end mirror)
    - `grep -n "window.innerWidth <= 960\|window.innerWidth < 960\|innerWidth <= 960" public/js/sidebar-resize.js` shows the mobile early-return guard in pointerdown
    - Manual smoke: boot :4099, drag the gutter — sidebar resizes smoothly; in DevTools Network → WS, observe NO `resize` messages during drag, exactly N `resize` messages on pointerup where N = open terminals
  </acceptance_criteria>
</task>

<task type="execute">
  <name>Task 5: Wire app.js — import init + applySidebarWidth in config handler</name>
  <files>public/js/app.js</files>
  <read_first>
    public/js/app.js lines 1-15 (the imports block — add a new import line `import { init as initSidebarResize, applySidebarWidth } from './sidebar-resize.js';`),
    public/js/app.js lines 119-135 (the `case 'config'` block — this is where applySidebarWidth must be called when config arrives so config wins over the paint-hint),
    public/js/app.js (find the module-bottom area where other inits happen — e.g. drag.js's `initDrag` is imported around line 13; mirror that wiring pattern: call `initSidebarResize()` once at the bottom of app.js or wherever the WS connection is set up),
    .planning/2026-05-27-terminal-display-sizing/CONTEXT.md (D-06 — config arrives async over WS, wins over paint-hint, re-syncs localStorage)
  </read_first>
  <action>
    (1) Add to the existing import block at the top of public/js/app.js: `import { init as initSidebarResize, applySidebarWidth } from './sidebar-resize.js';`. Place adjacent to the existing `import { initDrag, wasDragging } from './drag.js';` on line 13.
    (2) In the `case 'config':` block (lines 125-134 — read first to confirm current state), add a call to `applySidebarWidth(state.cfg.sidebarWidth)` AFTER `state.cfg = msg.config` and AFTER `regroupSessions()` so the sidebar element exists. This is the "config wins; re-sync localStorage" step from D-06. The applySidebarWidth function already mirrors to localStorage on apply, satisfying the re-sync requirement.
    (3) At the same place where `initDrag()` is called (search the file — it's likely near `state.ws.onopen` or at module load), call `initSidebarResize()` once. Position is not critical as long as `#sidebar-resize-gutter` is in the DOM by the time it runs (post-DOMContentLoaded is fine).
  </action>
  <acceptance_criteria>
    - `grep -n "import.*sidebar-resize" public/js/app.js` finds exactly one match in the import block
    - `grep -n "applySidebarWidth\|initSidebarResize" public/js/app.js` finds at least 2 references (one in case 'config', one init call)
    - Reading the `case 'config'` block, `applySidebarWidth(state.cfg.sidebarWidth)` appears AFTER `state.cfg = msg.config`
    - Manual smoke: open :4099 with a custom-width config saved (e.g. set state.cfg.sidebarWidth=500 via the config.json file directly, restart server), observe sidebar opens at 500px not 354px; reload and observe NO flash from 354→500 (paint-hint hits first)
  </acceptance_criteria>
</task>

<task type="execute">
  <name>Task 6: Settings round-trip — preserve sidebarWidth on saveConfig</name>
  <files>public/js/settings.js</files>
  <read_first>
    public/js/settings.js lines 578-588 (the saveConfig() body — note the comment on lines 585-586: "Preserve fields not managed by this form (projects, prompts, etc. live on state.cfg and must not be dropped)" — sidebarWidth must be in this preserved set),
    .planning/2026-05-27-terminal-display-sizing/CONTEXT.md (D-05)
  </read_first>
  <action>
    No code change to settings.js is required IF `saveConfig()` already sends `state.cfg` (full object) rather than reconstructing — re-read lines 578-588 to confirm. Line 587 sends `{type:'config.update', config: state.cfg}` — `state.cfg` is the full object so `state.cfg.sidebarWidth` is automatically preserved through any future `saveConfig()` call from settings.js. No action needed here EXCEPT: extend the comment block on lines 585-586 to mention sidebarWidth and terminalFontSize for future maintainers' clarity: `// (projects, prompts, sidebarWidth, terminalFontSize, etc. live on state.cfg and must not be dropped)`. This is a no-op functionally but documents the contract.
  </action>
  <acceptance_criteria>
    - `grep -n "sidebarWidth" public/js/settings.js` finds at least one match — the comment update
    - `npx vitest run` still exits 0 (no regression in any existing settings-touching test)
    - Manual smoke: change a setting in Settings → General (e.g. toggle confirmClose), drag the sidebar to 500px (separate concerns), toggle confirmClose back. Verify config.json on disk shows BOTH `confirmClose: true` AND `sidebarWidth: 500` — the settings save didn't clobber the sidebar width.
  </acceptance_criteria>
</task>

<task type="execute">
  <name>Task 7: Version bump + full UAT pass + commit</name>
  <files>package.json</files>
  <read_first>
    ~/.claude/CLAUDE.md §3 (commit, do NOT push; GitHub remote),
    package.json line 3 (current version — read live; sidebar runs after fontsize per `depends_on: [fontsize]`, so expect 1.31.11 and bump to 1.31.12. Always read line 3 first; never hardcode.)
  </read_first>
  <action>
    Bump `package.json` `version` patch by 1 (whatever the current value is — read the file first; if 1.31.10, → 1.31.11; if 1.31.11, → 1.31.12). Run the full automated verification: `npx vitest run` (must be all-green) and `npx playwright test` (must be all-green). Run `npm run build:css` once more at the end and verify `public/tailwind.css` contains `.sidebar-resize-gutter` rules. Commit with a verbose Lance-personal-style message describing the drag-resize implementation, the live-fit-during-drag + defer-PTY-resize-to-release pattern (D-07), the localStorage paint-hint + config-wins reconciliation (D-06), the 280/min(640,50vw)/354 bounds (D-08), and the mobile inert breakpoint (D-10). DO NOT `git push` (CLAUDE.md §3).
  </action>
  <acceptance_criteria>
    - `grep -n '"version"' package.json | head -1` shows a patch version higher than the value before this task
    - `npx vitest run` exits 0 with `tests/sidebar-width-clamp.test.js` passing AND `tests/config-defaults.test.js` (with sidebarWidth assertion active) passing
    - `npx playwright test` exits 0
    - `git log -1 --format='%s'` shows a descriptive subject mentioning sidebar resize or the phase name
    - `git status` shows clean working tree
    - `git log origin/main..HEAD --oneline` shows the new commit ahead of origin (i.e. NOT pushed)
    - The full manual UAT in the Verification section below passes — all six AC paths green
  </acceptance_criteria>
</task>

## Verification

### Automated
- `npx vitest run` — all existing 88 tests stay green + 2 new files pass (`sidebar-width-clamp.test.js`, plus the un-commented sidebarWidth assertion in `config-defaults.test.js`). Covers AC 11.
- `npx playwright test` — all e2e suites stay green. Covers AC 12. Note: no new e2e suite added for sidebar drag because Playwright pointer-drag tests are slow + flaky; manual UAT covers the drag interaction directly.

### Manual UAT (throwaway :4099)
Boot:
```
$tmp = New-Item -ItemType Directory -Path "$env:TEMP\clideck-uat-$([guid]::NewGuid().ToString('N').Substring(0,8))"
$env:CLIDECK_PORT = "4099"; $env:CLIDECK_DATA_DIR = $tmp.FullName
npm start
```
Open http://localhost:4099 in a fresh browser window. Verify in order:

1. **AC 5 (drag resizes + terminal reflows live):** Open two terminals. Hover the strip right of the sidebar — cursor shows col-resize. Click and drag rightward slowly. The sidebar widens; the terminal pane shrinks; xterm reflows within one frame. Drag leftward; terminal pane widens. Release — no error in console.
2. **AC 6 (bounds clamp):** From any position, drag the gutter sharply LEFT past where the sidebar would go under 280px — observe it stops at exactly 280px (visible session rows still readable). Drag sharply RIGHT past the viewport midpoint — observe it stops at exactly `min(640, 50vw)` px. Resize the browser window narrower so that 50vw < 640; drag the gutter — the cap follows 50vw dynamically.
3. **AC 7 (persists + paint-hint, no flash):** Drag to 500px. Hard-reload (Ctrl+Shift+R). The sidebar reappears at 500px IMMEDIATELY — no visible flash from 354px to 500px (the paint-hint is doing its job). Open DevTools → Application → Local Storage → http://localhost:4099 — observe `clideck.sidebarWidth = 500`. Stop the server, open `<CLIDECK_DATA_DIR>/.clideck/config.json` (or similar — wherever clideck writes it; read paths.js if uncertain), observe `"sidebarWidth": 500`.
4. **AC 8 (PTY resize on release only):** With DevTools → Network → WS open, drag the gutter for 3 seconds continuously. Observe: NO `{"type":"resize"...}` messages during drag. Release. Observe: exactly N resize messages where N = number of open terminals. (Confirms D-07 — no SIGWINCH spam.) In any terminal post-release, run `tput cols` (or `echo $COLUMNS`); the reported value matches xterm's visual cols (the PTY caught up).
5. **AC 9 (double-click reset):** Double-click the gutter. Sidebar snaps to 354px. Verify localStorage and config.json now read 354.
6. **AC 10 (mobile inert):** Resize browser to 800px wide (< 960px). The gutter disappears visually. Click the burger toggle (`#mobile-nav-toggle`) — observe the existing slide-in overlay works exactly as before (no regression in mobile-nav). Resize back to 1400px — gutter reappears, drag works again.

Tear down:
```
taskkill /F /IM node.exe   # throwaway clideck only
Remove-Item -Recurse -Force $tmp.FullName
```

## Risks

- **R1 (D-07, named risk in CONTEXT.md): PTY resize spam during drag (SIGWINCH flood).** Mitigation: pointermove explicitly does NOT send `{type:'resize'}` — only `entry.fit.fit()` for visual reflow. PTY resize is exclusive to pointerup + dblclick. Verification: Network → WS during drag must show zero resize messages. If even one appears mid-drag, the throttle is broken and the plan fails AC 8.
- **R2 — Paint-hint vs config race.** If the localStorage value is stale (config.json says 500 but localStorage says 354 from before a config import) the user sees 354 → snap to 500 on WS connect. Mitigation: case 'config' calls applySidebarWidth which re-mirrors to localStorage, healing the cache. Worst case is one snap on the *next* reload after an out-of-band config edit — acceptable.
- **R3 — `min-w-[354px]` Tailwind class on `#sidebar` fights inline width.** Mitigation: Task 3 explicitly strips it; replaced by JS-driven inline width + the `w-[354px]` cold-start fallback. Verify with `grep -c "min-w-\[354px\]" public/index.html` returns 0.
- **R4 — Pointer events leak into xterm during drag (selecting terminal text instead of dragging).** Mitigation: Task 4 adds `body.sidebar-resizing` class during drag, CSS rule disables `#terminals` pointer-events for the drag duration. If text selection still happens in the terminal mid-drag, the body class or CSS rule isn't applying — debug there.
- **R5 — Mobile breakpoint regression.** Mitigation: D-10 mobile inert; gutter `display:none` via @media and pointerdown short-circuits if `innerWidth <= 960`. UAT step 6 verifies the existing mobile-nav flow is untouched.
- **No threat model:** UI-only phase, no security surface.

## Output

Commit (no push — GitHub remote). Phase 9 ships when both PLAN-fontsize and PLAN-sidebar are committed on Lance's local main. PLAN-fontsize runs first (per `depends_on: [fontsize]`); each commit bumps the patch version by reading line 3 of package.json live (per ~/.claude/CLAUDE.md and the project's bump-per-commit rule).
