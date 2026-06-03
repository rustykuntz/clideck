---
phase: 10-creator-ergonomics
plan: 1
type: execute
wave: 1
depends_on: []
files_modified:
  - utils.js
  - handlers.js
  - public/js/confirm.js
  - public/js/creator.js
  - public/index.html
  - package.json
  - tests/path-validation.test.js
  - tests/check-cwd-handler.test.js
  - tests/mkdir-cwd-handler.test.js
  - tests/confirm-modal-onebutton.test.js
autonomous: true
covers_acceptance_criteria: [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13]
must_haves:
  truths:
    - "Typing a non-existent cwd into the creator and clicking a preset surfaces a modal (not a silent ~ landing) (AC 1)."
    - "Modal 'Create and open' button issues mkdir then proceeds to create the session in the now-existing path (AC 2)."
    - "Modal 'Cancel' returns focus to the cwd input with the offending path text selected (AC 3)."
    - "A cwd that exists but is a file shows a one-button 'that's a file, not a folder' modal — no Create affordance (AC 4)."
    - "A cwd whose stat throws EACCES shows a one-button 'permission denied' modal — no Create affordance (AC 5)."
    - "Folder-picker selections and drag-folder selections do not trigger the check-cwd round-trip (AC 6)."
    - "Empty/whitespace cwd skips the check entirely and uses the existing home-dir fallback (AC 7)."
    - "mkdir-cwd rejects any non-absolute path and any path containing a '..' segment (AC 8)."
    - "Opening the creator card shows the project trigger labelled 'None (outside project hierarchy)' with cwdWrap visible (AC 9)."
    - "Submitting the creator immediately without touching the dropdown creates an ungrouped session — no 'choose a project' toast ever fires (AC 10)."
    - "The real projects still appear in the dropdown; switching to a real project then back to None still works via setProjectSelection (AC 11)."
    - "`npx vitest run` exits 0 (AC 12)."
    - "`npx playwright test` exits 0 (AC 13)."
  artifacts:
    - path: "utils.js"
      provides: "validateCwdPath(p) helper exported alongside resolveValidDir"
      contains: "validateCwdPath"
    - path: "handlers.js"
      provides: "check-cwd and mkdir-cwd WS message cases in the dispatcher switch"
      contains: "case 'check-cwd'"
    - path: "public/js/confirm.js"
      provides: "confirmClose extended to accept an options object with hideConfirm/oneButton flag"
      contains: "hideConfirm"
    - path: "public/js/creator.js"
      provides: "Pre-flight check before create + projHidden pre-seeded to NO_PROJECT_VALUE"
      contains: "check-cwd"
    - path: "tests/check-cwd-handler.test.js"
      provides: "Vitest server-env test exercising the check-cwd handler"
      contains: "check-cwd"
    - path: "tests/mkdir-cwd-handler.test.js"
      provides: "Vitest server-env test exercising mkdir-cwd including relative/`..` rejection"
      contains: "rejects relative"
    - path: "tests/path-validation.test.js"
      provides: "Vitest test for the validateCwdPath helper"
      contains: "validateCwdPath"
    - path: "tests/confirm-modal-onebutton.test.js"
      provides: "Happy-dom test verifying hideConfirm hides the confirm button and one-button resolution still works"
      contains: "hideConfirm"
  key_links:
    - from: "public/js/creator.js"
      to: "ws (state.send)"
      via: "send({type:'check-cwd', path}) and send({type:'mkdir-cwd', path})"
      pattern: "send\\(\\{ ?type: ?'check-cwd'"
    - from: "handlers.js"
      to: "utils.js validateCwdPath"
      via: "case 'mkdir-cwd' calls validateCwdPath before mkdirSync"
      pattern: "validateCwdPath"
    - from: "public/js/creator.js"
      to: "public/js/confirm.js confirmClose"
      via: "await confirmClose(message, label, { hideConfirm }) for the three modal variants"
      pattern: "confirmClose\\("
    - from: "public/js/creator.js"
      to: "createFromPreset"
      via: "Only invoked after check-cwd resolves exists+isDirectory OR after mkdir-cwd-result ok:true"
      pattern: "createFromPreset"
---

## Goal

Remove two daily-friction tolls from the new-session creator card so the common-case create flow is zero-typo-cost (SPEC.md AC 1–11):

1. **Pre-flight existence check** (AC 1–8). Before sending `{type:'create'}`, the client asks the server whether the typed cwd exists. Exists → proceed. Doesn't exist → modal offering **Cancel** or **Create and open** (server mkdir's recursively, then proceeds). File-at-path or EACCES → one-button acknowledge-only modal. Folder-picker / drag-folder paths and empty/whitespace cwds skip the check by design.
2. **Default project to None** (AC 9–11). At creator-card open, pre-seed `projHidden.value = NO_PROJECT_VALUE`, label the trigger "None (outside project hierarchy)", unhide `cwdWrap`, and remove the now-dead "Choose a project" toast guard at creator.js:339.

Cross-cutting: all existing Vitest and Playwright suites stay green (AC 12, 13). The package.json patch version is bumped on the final commit so the connection lozenge reflects the new build. No push to GitHub.

The plan ships as a single PLAN.md with task-level ordering that mirrors a natural test-first → server → modal → client wiring → cleanup → UAT cadence. Two early tasks are full RED→GREEN→REFACTOR TDD; later tasks are DOM-coupled and verified via Playwright + a throwaway :4099 manual UAT.

## Tasks

<task type="auto" tdd="true">
  <name>Task 1: validateCwdPath helper (TDD)</name>
  <files>utils.js, tests/path-validation.test.js</files>
  <read_first>
    - C:\_Projects\clideck\utils.js (lines 40–45 — existing resolveValidDir lives here; the new helper sits alongside, exported from the same module)
    - C:\_Projects\clideck\.planning\2026-05-27-creator-ergonomics\SPEC.md (AC 8 — "mkdir-cwd rejects relative paths and paths containing `..`")
    - C:\_Projects\clideck\tests\session-reorder.test.js (lines 1–60 — vitest `@vitest-environment node` header pattern, beforeEach/afterEach using mkdtempSync, ESM imports for vitest)
  </read_first>
  <behavior>
    - Test 1: validateCwdPath('') returns { ok:false, error:'empty' }
    - Test 2: validateCwdPath(null) returns { ok:false, error:'empty' }
    - Test 3: validateCwdPath('relative/path') returns { ok:false, error:'not-absolute' }
    - Test 4: validateCwdPath('./foo') returns { ok:false, error:'not-absolute' }
    - Test 5: validateCwdPath('C:/abs/../escape') returns { ok:false, error:'parent-traversal' } (the `..` segment is the trigger, regardless of where it appears)
    - Test 6: validateCwdPath('/abs/sub/..') returns { ok:false, error:'parent-traversal' }
    - Test 7 (Windows): validateCwdPath('C:\\Users\\Lance\\Projects\\new') returns { ok:true } (path.isAbsolute('C:\\...') is true on win32)
    - Test 8 (POSIX): validateCwdPath('/home/lance/projects/new') returns { ok:true }
    - Test 9: validateCwdPath whitespace-only string '   ' returns { ok:false, error:'empty' }
    - Test 10: Trailing slash and odd separators normalise without false-positives (e.g. 'C:/Users/Lance/' → ok:true)
  </behavior>
  <action>
    RED: Author `tests/path-validation.test.js` using `// @vitest-environment node` header, `import { describe, it, expect } from 'vitest'`, and `import { validateCwdPath } from '../utils.js'` (utils.js is CommonJS — use `const { validateCwdPath } = require('../utils.js')` or a top-level await import; mirror tests/session-reorder.test.js's pattern of `require('../sessions.js')` for CJS modules). Run `npx vitest run tests/path-validation.test.js` — must FAIL with "validateCwdPath is not a function" or similar.

    GREEN: Add `validateCwdPath(p)` to utils.js. Trim the input. Empty/whitespace → `{ok:false, error:'empty'}`. Use `path.isAbsolute(trimmed)` (require `path` at top of file — only `dirname`/`join` are imported today) to reject relative → `{ok:false, error:'not-absolute'}`. Split the trimmed path on both `/` and `\\` (a single regex `[\\/]+`) and if any segment equals `..` → `{ok:false, error:'parent-traversal'}`. Otherwise `{ok:true, path: trimmed}`. Export `validateCwdPath` from the module.exports list (do NOT touch resolveValidDir — SPEC §7 says it keeps its silent fallback).

    REFACTOR: If the segment-split is awkward, extract a tiny `splitSegments(p)` local function. Keep validateCwdPath under ~15 LOC. Run vitest again — all 10 tests pass.
  </action>
  <acceptance_criteria>
    - `npx vitest run tests/path-validation.test.js` exits 0 with 10 passing tests
    - `grep -n 'validateCwdPath' utils.js` returns at least 2 matches (function decl + module.exports)
    - `grep -n 'validateCwdPath' tests/path-validation.test.js` returns at least 10 matches
    - resolveValidDir at utils.js:40–45 is byte-identical to the pre-change version (verify with `git diff utils.js` — only additions, no deletions in that range)
    - Discharges SPEC AC 8 (pure-logic half — the helper)
  </acceptance_criteria>
  <verify>
    <automated>npx vitest run tests/path-validation.test.js</automated>
  </verify>
  <done>validateCwdPath exported from utils.js, ten unit tests green, resolveValidDir untouched, no other behaviour changed.</done>
</task>

<task type="auto" tdd="true">
  <name>Task 2: check-cwd + mkdir-cwd WS handlers (TDD)</name>
  <files>handlers.js, tests/check-cwd-handler.test.js, tests/mkdir-cwd-handler.test.js</files>
  <read_first>
    - C:\_Projects\clideck\handlers.js (lines 1–10 for fs/path imports already in scope; lines 300–310 for the `switch (msg.type)` dispatcher anchor; lines 516–569 for `dirs.list`, `dirs.listSubdirs`, `dirs.mkdir` — the closest analogs to what we're adding: same try/catch + ws.send shape, same target/result envelope, same use of `mkdirSync`)
    - C:\_Projects\clideck\utils.js (validateCwdPath from Task 1 — Task 2 consumes it via `const { validateCwdPath } = require('./utils')`)
    - C:\_Projects\clideck\tests\session-reorder.test.js (lines 1–60 — `freshSessionsModule` cache-busting and `captureClient` patterns)
    - C:\_Projects\clideck\.planning\2026-05-27-creator-ergonomics\SPEC.md (AC 1, 2, 4, 5, 8 — handler contract: { type, path, exists, isDirectory, error } and { type, path, ok, error })
  </read_first>
  <behavior>
    check-cwd tests (tests/check-cwd-handler.test.js):
    - Test 1: check-cwd on a freshly-created mkdtempSync directory → response `{type:'check-cwd-result', path, exists:true, isDirectory:true, error:null}` (AC 1 negative path — confirms existing dirs DON'T pop the modal)
    - Test 2: check-cwd on a path that does not exist (e.g. `join(tmpDir, 'does-not-exist')`) → `{type:'check-cwd-result', path, exists:false, isDirectory:false, error:null}` (drives AC 1)
    - Test 3: check-cwd on a file path (writeFileSync a fixture file) → `{type:'check-cwd-result', path, exists:true, isDirectory:false, error:null}` (drives AC 4)
    - Test 4: check-cwd on a path that throws EACCES (mock fs.statSync to throw an Error with code:'EACCES') → `{type:'check-cwd-result', path, exists:false, isDirectory:false, error:'EACCES'}` (drives AC 5; on Windows you can't actually create an EACCES dir easily — mock fs.statSync via `vi.spyOn(fs, 'statSync').mockImplementation(...)` for this one test)
    - Test 4b: check-cwd on a BROKEN symlink (symlinkSync to a path that's then unlinked) → `{type:'check-cwd-result', path, exists:false, isDirectory:false, error:null}` — confirms ENOENT on a dangling symlink is mapped to not-exists, per SPEC §61 "Broken symlink → reports not-exists (correct)". The handler uses statSync (not lstatSync) so broken symlinks raise ENOENT, which the code maps to error:null + exists:false; this test pins that behaviour. Skip on Windows where symlink creation requires admin — guard with `it.skipIf(process.platform === 'win32')`.
    - Test 5: check-cwd never throws — even if msg.path is `null` or missing, it sends a `check-cwd-result` with `exists:false, error:'invalid-input'` (handler robustness)

    mkdir-cwd tests (tests/mkdir-cwd-handler.test.js):
    - Test 6: mkdir-cwd with absolute path inside tmpdir, recursive multi-level → `{type:'mkdir-cwd-result', path, ok:true, error:null}` AND the directory exists on disk afterward (statSync().isDirectory() === true) (drives AC 2)
    - Test 7: mkdir-cwd with `path:'relative/foo'` → `{type:'mkdir-cwd-result', path, ok:false, error:'not-absolute'}` and nothing is created (drives AC 8)
    - Test 8: mkdir-cwd with `path:'C:/abs/../escape'` (POSIX equivalent `/abs/../escape`) → `{type:'mkdir-cwd-result', path, ok:false, error:'parent-traversal'}` and nothing is created (drives AC 8)
    - Test 9: mkdir-cwd targeting an existing directory → ok:true (recursive mkdir is a no-op, EEXIST swallowed by `recursive:true` — confirms create-on-existing doesn't double-fault)
    - Test 10: mkdir-cwd against a path whose mkdirSync throws EACCES (mock fs.mkdirSync to throw Error with code:'EACCES') → `{type:'mkdir-cwd-result', path, ok:false, error:'EACCES'}` (drives R2 — the planner risk)
    - Test 11: mkdir-cwd never throws on null/missing path — returns `{ok:false, error:'invalid-input'}`
  </behavior>
  <action>
    RED: Author both test files. Each starts with `// @vitest-environment node`. Use the `freshSessionsModule` cache-busting trick from tests/session-reorder.test.js, but for handlers.js — write a small helper that requires handlers.js fresh per test. **Drive the handler through the exported `onConnection(ws)` — do NOT hoist the dispatcher out of its closure.** Hoisting `dispatchMessage` would require passing every closure-captured dep (cfg, broadcast helpers, logger) explicitly, which is a large refactor for negligible test gain. Instead, instantiate a fake ws as a Node EventEmitter with `readyState:1` and a recording `send` method, call `onConnection(fakeWs)`, then `fakeWs.emit('message', JSON.stringify({type:'check-cwd', path:...}))` to dispatch — handlers.js uses `ws.on('message', ...)` so emitting fires the existing switch. The recorded `send` calls are then asserted. Confirm both test files initially FAIL (no `check-cwd`/`mkdir-cwd` cases exist yet).

    GREEN: In handlers.js, find the dispatcher `switch (msg.type)` (around line 302). After the existing `dirs.mkdir` case (~line 569) add two new cases:

      - `case 'check-cwd'`: trim msg.path. If falsy → ws.send `{type:'check-cwd-result', path:msg.path, exists:false, isDirectory:false, error:'invalid-input'}` and break. Try `const s = statSync(trimmed)` inside a try/catch. On success → ws.send `{type:'check-cwd-result', path:trimmed, exists:true, isDirectory:s.isDirectory(), error:null}`. On catch — if `e.code === 'ENOENT'` send `exists:false, isDirectory:false, error:null` (not-exists is normal, not an error). Otherwise serialize `e.code || e.message` as the error string (EACCES, EPERM, etc.) and `exists:false, isDirectory:false`.

      - `case 'mkdir-cwd'`: require validateCwdPath at top of file (add to the existing destructure on line 9: `const { listDirs, binName, defaultShell, validateCwdPath } = require('./utils');`). Run `const v = validateCwdPath(msg.path)`. If `!v.ok` → ws.send `{type:'mkdir-cwd-result', path:msg.path, ok:false, error:v.error}` and break. Try `mkdirSync(v.path, {recursive:true})` and on success send `ok:true, error:null`. On catch send `ok:false, error: e.code || e.message`.

    Both cases use the existing `ws.send(JSON.stringify(...))` style — mirror the `dirs.mkdir` case at line 555-569 for shape. Never throw; always send a result.

    REFACTOR: If both cases share the same `ws.send(JSON.stringify({...}))` boilerplate enough to warrant a small `reply(type, payload)` helper inside onConnection's closure, extract it. Otherwise leave inline (handlers.js is already a switch-heavy file — consistency wins over DRY here).

    Run `npx vitest run tests/check-cwd-handler.test.js tests/mkdir-cwd-handler.test.js`. All 11 tests pass.
  </action>
  <acceptance_criteria>
    - `npx vitest run tests/check-cwd-handler.test.js tests/mkdir-cwd-handler.test.js` exits 0 with 11 passing tests
    - `grep -n "case 'check-cwd'" handlers.js` returns 1 match
    - `grep -n "case 'mkdir-cwd'" handlers.js` returns 1 match
    - `grep -n 'validateCwdPath' handlers.js` returns at least 1 match (the require line)
    - check-cwd and mkdir-cwd handlers never throw — verified by Test 5 and Test 11
    - Discharges SPEC AC 1, 2, 4, 5, 8 (server half), R2 (handler returns ok:false cleanly on mkdir EACCES)
  </acceptance_criteria>
  <verify>
    <automated>npx vitest run tests/check-cwd-handler.test.js tests/mkdir-cwd-handler.test.js</automated>
  </verify>
  <done>Two new WS handler cases live in handlers.js; eleven unit tests green; validateCwdPath wired in; resolveValidDir still untouched.</done>
</task>

<task type="auto" tdd="true">
  <name>Task 3: confirm.js — add hideConfirm/oneButton mode</name>
  <files>public/js/confirm.js, tests/confirm-modal-onebutton.test.js</files>
  <read_first>
    - C:\_Projects\clideck\public\js\confirm.js (the entire file — 28 lines; the current 2-button signature is `confirmClose(message, confirmLabel)` returning a Promise<boolean>)
    - C:\_Projects\clideck\public\index.html (lines 463–471 — the #confirm-close overlay markup with #cc-cancel and #cc-confirm buttons; we will NOT change the DOM, only show/hide #cc-confirm)
    - C:\_Projects\clideck\public\js\creator.js (line 111-122 — existing caller using the 2-arg form `confirmClose(message, 'Open another')`; this caller must remain working unchanged) and line 6 (the import)
    - Other callers: `grep -rn 'confirmClose' public/js` will show every consumer — the change must be backwards compatible with every one of them
    - C:\_Projects\clideck\tests\folder-picker-host-button.test.js (happy-dom + index.html loading pattern; mirror its setup)
  </read_first>
  <behavior>
    - Test 1: confirmClose('msg', 'OK') (old 2-arg form) still works — Promise resolves true on #cc-confirm click, false on #cc-cancel click (backwards compat)
    - Test 2: confirmClose('msg', 'OK', { hideConfirm:true }) — #cc-confirm has the `hidden` class set, only #cc-cancel is interactive; clicking #cc-cancel resolves the Promise to `false` (acknowledge-only treats dismissal as the only resolution path)
    - Test 3: After a hideConfirm:true call resolves, a subsequent confirmClose('msg2','OK') (old 2-arg form) shows #cc-confirm again (no `hidden` class) — state must reset between calls
    - Test 4: hideConfirm:true also accepts a customized cancel label via an optional `cancelLabel` field of the options object (so we can render "OK" or "Got it" instead of "Cancel" — the existing markup says "Cancel"; we want "OK" for info-only modals). Verify cancelBtn.textContent === 'OK' when called with { hideConfirm:true, cancelLabel:'OK' }.
  </behavior>
  <action>
    RED: Author tests/confirm-modal-onebutton.test.js. Use happy-dom env (default vitest.config.js). Load public/index.html into the document (mirror tests/folder-picker-host-button.test.js — `readFileSync` the html, set `document.documentElement.innerHTML` to the body innerHTML, or use a `JSDOM`-style approach matching the existing test's pattern). Import confirm.js dynamically and assert each test. RUN — must FAIL (hideConfirm not implemented).

    GREEN: Change confirm.js's signature from `export function confirmClose(message, confirmLabel)` to `export function confirmClose(message, confirmLabel, opts = {})`. Inside the function:
      - If `opts.hideConfirm === true`, set `confirmBtn.classList.add('hidden')`; else `confirmBtn.classList.remove('hidden')` (so subsequent calls reset)
      - If `opts.cancelLabel` is a non-empty string, set `cancelBtn.textContent = opts.cancelLabel`; else reset to `'Cancel'` (the original markup default)
      - Everything else stays the same — messageEl.textContent, confirmBtn.textContent, overlay.classList.remove('hidden')/.add('flex')
    The two existing event listeners (lines 25–27) are wired once at module load and resolve to true/false respectively. They keep working unchanged. The overlay backdrop click → close(false) keeps working — and in hideConfirm mode that's the equivalent of an acknowledge dismissal (still resolves false, which the caller doesn't care about for info-only modals).

    REFACTOR: If the cancelLabel reset is awkward, consider always setting it explicitly at the top of confirmClose: `cancelBtn.textContent = opts.cancelLabel || 'Cancel'`. Single line, no branching needed.

    Run `npx vitest run tests/confirm-modal-onebutton.test.js` — 4 tests pass. Also re-run `npx vitest run` (full suite) to confirm no regression elsewhere (R1 — existing callers).
  </action>
  <acceptance_criteria>
    - `npx vitest run tests/confirm-modal-onebutton.test.js` exits 0 with 4 passing tests
    - `npx vitest run` (full suite) exits 0 — no existing caller regresses (R1 mitigation)
    - `grep -n 'hideConfirm' public/js/confirm.js` returns at least 1 match
    - The 2-arg call form `confirmClose(message, label)` is byte-compatible with pre-change callers (Test 1 + Test 3 prove this)
    - Discharges the modal-extension half of AC 4 and AC 5 (the one-button modal infrastructure)
  </acceptance_criteria>
  <verify>
    <automated>npx vitest run tests/confirm-modal-onebutton.test.js &amp;&amp; npx vitest run</automated>
  </verify>
  <done>confirm.js exports a backwards-compatible confirmClose with optional hideConfirm + cancelLabel; new test green; full vitest suite still green.</done>
</task>

<task type="auto">
  <name>Task 4: creator.js — pre-flight check before create</name>
  <files>public/js/creator.js</files>
  <read_first>
    - C:\_Projects\clideck\public\js\creator.js (lines 107–128 — `createFromPreset` which sends `{type:'create',...}`; lines 320–350 — the click handler that builds `cwd` from `cwdInput.value.trim()` and calls `createFromPreset(preset, name, cwd, projectId)`; line 246–250 — the folder-picker `onClick` callback that writes `cwdInput.value = path`)
    - C:\_Projects\clideck\public\js\confirm.js (the updated 3-arg signature from Task 3)
    - C:\_Projects\clideck\public\js\state.js (the `send` helper signature)
    - C:\_Projects\clideck\.planning\2026-05-27-creator-ergonomics\SPEC.md (AC 1–7 — the full UX matrix)
  </read_first>
  <action>
    Add a `cwdCheckedViaPicker` flag at the top of `openCreator()` scope, initially `false`. Set it to `true` inside both:
      (a) the folder-picker callback at line ~247 (`openFolderPicker(...,(path) => { cwdInput.value = path; cwdCheckedViaPicker = true; })`)
      (b) any future drag-folder hook — verify by searching for `dragenter`/`drop` listeners on `#creator-cwd` (likely none today; if found, reset the flag on user typing). Reset the flag to `false` on any `cwdInput` input event (`cwdInput.addEventListener('input', () => { cwdCheckedViaPicker = false; })`) so a user-typed override after picker use is still validated.

    Add a new async helper inside `openCreator()` closure: `async function ensureCwdExistsOrConfirm(cwd) { ... }` that:
      1. If `!cwd || !cwd.trim()` → return `'proceed'` (empty/whitespace skips, AC 7).
      2. If `cwdCheckedViaPicker` → return `'proceed'` (AC 6).
      3. Send `{type:'check-cwd', path: cwd}` via `state.send`. Set up a one-shot message listener on `state.ws` for `check-cwd-result` whose `path === cwd`. Race against a 5-second timeout (resolve `'proceed'` on timeout — soft fail; better to let the existing silent-fallback handle than to block the create flow forever).
      4. On `exists:true, isDirectory:true` → return `'proceed'`.
      5. On `exists:true, isDirectory:false` (file at path) → `await confirmClose('A file already exists at that path — pick a different folder.', '', { hideConfirm:true, cancelLabel:'OK' })`; then `cwdInput.focus(); cwdInput.select();` and return `'cancel'` (AC 4).
      6. On `error === 'EACCES' || error === 'EPERM'` → `await confirmClose('Permission denied for that path. Try a different folder.', '', { hideConfirm:true, cancelLabel:'OK' })`; focus+select cwdInput; return `'cancel'` (AC 5).
      7. On `exists:false` (the not-exists branch) → `const ok = await confirmClose('That folder doesn\'t exist yet. Create it and open the session there?', 'Create and open')`. If `!ok` → focus+select cwdInput and return `'cancel'` (AC 3). If ok → send `{type:'mkdir-cwd', path: cwd}` and await `mkdir-cwd-result`. If `ok:true` → return `'proceed'` (AC 2). If `ok:false` → `await confirmClose('Couldn\'t create that folder: ' + (error || 'unknown error'), '', { hideConfirm:true, cancelLabel:'OK' })`; focus+select; return `'cancel'` (R2 — mkdir EACCES surfaces, no session is created).

    In the click handler at the bottom of `openCreator()` (around line 343–349, AFTER the project guard is removed in Task 5 but order-of-edits doesn't matter — both tasks live in this file), wrap the call to `createFromPreset` with the new helper:

      Replace the existing
          `createFromPreset(preset, name, cwd, projectId).then(ok => { if (ok) closeCreator(); });`
      with
          `const decision = await ensureCwdExistsOrConfirm(cwd);`
          `if (decision !== 'proceed') return;`
          `const ok = await createFromPreset(preset, name, cwd, projectId);`
          `if (ok) closeCreator();`

      The enclosing click listener at line 320 is currently `(e) => { ... }` — make it `async (e) => { ... }` so await works. (Top-level arrow → async arrow is the only signature change.)

    Implementation notes:
      - Use a small inline promise helper for the WS round-trip: `function waitForResult(ws, predicate, timeoutMs) { return new Promise((resolve) => { const onMsg = (e) => { try { const m = JSON.parse(e.data); if (predicate(m)) { ws.removeEventListener('message', onMsg); clearTimeout(t); resolve(m); } } catch {} }; const t = setTimeout(() => { ws.removeEventListener('message', onMsg); resolve(null); }, timeoutMs); ws.addEventListener('message', onMsg); }); }` — mirror the install-toast pattern at creator.js:411–419.
      - Predicate for check-cwd: `m => m.type === 'check-cwd-result' && m.path === cwd`.
      - Predicate for mkdir-cwd: `m => m.type === 'mkdir-cwd-result' && m.path === cwd`.
      - "focus+select" → `cwdInput.focus(); cwdInput.setSelectionRange(0, cwdInput.value.length);`
  </action>
  <acceptance_criteria>
    - `grep -n "type: 'check-cwd'" public/js/creator.js` returns 1 match
    - `grep -n "type: 'mkdir-cwd'" public/js/creator.js` returns 1 match
    - `grep -n 'cwdCheckedViaPicker' public/js/creator.js` returns at least 3 matches (decl + 1 set + 1 read; +1 reset on input)
    - `grep -n 'ensureCwdExistsOrConfirm\\|setSelectionRange' public/js/creator.js` returns at least 2 matches
    - The click handler at the bottom of openCreator is now `async (e) =>`
    - Discharges SPEC AC 1, 2, 3, 4, 5, 6, 7 (client integration), R2 (mkdir error surfaces a modal, session is NOT created)
    - Manual UAT (Task 7) will exercise each branch end-to-end
  </acceptance_criteria>
  <verify>
    <automated>npx vitest run</automated>
  </verify>
  <done>Pre-flight check wires check-cwd + mkdir-cwd into the create flow with the three modal variants; folder-picker and empty-cwd paths skip the check; vitest still green; manual UAT in Task 7 exercises the branches.</done>
</task>

<task type="auto">
  <name>Task 5: Default project to None + remove dead toast guard</name>
  <files>public/js/creator.js</files>
  <read_first>
    - C:\_Projects\clideck\public\js\creator.js (lines 189–237 — `openCreator()` initial wiring; lines 217 — `creator-cwd-wrap` has the inline `${(state.cfg.projects?.length) ? 'hidden' : ''}` class that needs to flip; lines 252–274 — `setProjectSelection` closure exists; we'll call it with NO_PROJECT_VALUE at open; lines 339–343 — the dead toast guard to remove; line 18 — NO_PROJECT_VALUE constant)
    - C:\_Projects\clideck\.planning\2026-05-27-creator-ergonomics\SPEC.md (AC 9, 10, 11)
  </read_first>
  <action>
    In `openCreator()` after the project picker is set up (after the closing `}` of the `if (projTrigger) { ... }` block at line ~317), and only when `projTrigger` exists (i.e. there are configured projects — if there are none, the `cwdWrap` is already visible per the inline template at line 217):
      - Call `setProjectSelection(NO_PROJECT_VALUE);` once. Because `setProjectSelection` is defined inside the same `if (projTrigger)` block, lift the call inside that block immediately after the function is declared (i.e. after line 274, before the click-listener setup at line 277). This sets `projHidden.value = NO_PROJECT_VALUE`, sets the label to 'None (outside project hierarchy)', and runs `cwdWrap.classList.remove('hidden')` + `cwdInput.value = cwdInput.value.trim() || defaultPath`. The cwdWrap is now visible at first render (AC 9).

      Note: the existing inline template at line 217 sets `cwdWrap` to `hidden` when projects exist. setProjectSelection(NO_PROJECT_VALUE) flips it off — verify with the manual UAT that on a fresh creator open, the cwd input is visible and the trigger reads "None (outside project hierarchy)".

    Also at line ~237 (`(projTrigger || nameInput).focus();`), change focus target to `nameInput` always — since the default is now None, the user no longer needs to interact with the project picker to proceed, so focusing the name input (or the cwd input) is the friendlier default. Use `nameInput.focus();` and drop the `projTrigger ||` fallback. (Verify this doesn't break any existing test — grep tests/*.js for `creator-project-trigger` and `nameInput.focus`.)

    Delete the dead guard at lines 339–343:
      ```
      if (projTrigger && !projHidden.value) {
        showToast('Choose a project or select `None (outside project hierarchy)`.', { title: 'Choose Project', type: 'warn' });
        projTrigger.focus();
        return;
      }
      ```
      Since projHidden is now always pre-seeded to NO_PROJECT_VALUE at creator-card open (and stays that way unless the user picks a real project, which sets projHidden.value to the real id), the `!projHidden.value` predicate can never be true on a freshly-opened creator. Remove the whole 5-line block (AC 10). Also remove the `import { showToast } from './toast.js';` line at line 5 ONLY IF no other call to showToast remains in creator.js — `grep -n 'showToast' public/js/creator.js` after deletion. If `showInstallToast` and other usages remain (line 340 was the only `showToast(` call — `showInstallToast` is a different local function), the import is still required; keep it. (Likely: keep the import; other internal helpers may use showToast for install errors at line 406.)
  </action>
  <acceptance_criteria>
    - `grep -n 'Choose a project' public/js/creator.js` returns 0 matches (toast string deleted)
    - `grep -n "setProjectSelection(NO_PROJECT_VALUE)" public/js/creator.js` returns at least 1 match
    - `grep -cn 'projTrigger && !projHidden.value' public/js/creator.js | grep -v '^#' | grep -c '.'` is 0 — the guard is gone
    - `grep -n 'showToast' public/js/creator.js` does not match the deleted string (only legitimate install-toast callers remain)
    - Manual UAT (Task 7) confirms first-render submit creates an ungrouped session with NO toast (AC 10)
    - Discharges SPEC AC 9, 10, 11 (11 is by-construction: setProjectSelection still handles real-project picks unchanged)
  </acceptance_criteria>
  <verify>
    <automated>npx vitest run</automated>
  </verify>
  <done>Creator opens with None pre-selected, cwdWrap visible, no Choose-a-project toast possible. Existing vitest suite still green.</done>
</task>

<task type="auto">
  <name>Task 6: Full Vitest + Playwright pass</name>
  <files>(no source changes — verification only)</files>
  <read_first>
    - C:\_Projects\clideck\package.json (lines 9–17 — confirm `test` and `test:e2e` scripts)
    - C:\_Projects\clideck\.planning\2026-05-27-creator-ergonomics\SPEC.md (AC 12, 13)
  </read_first>
  <action>
    Run the full vitest suite: `npx vitest run`. Capture the pass/fail count. If anything fails that didn't exist pre-phase, debug — the most likely sources are:
      (a) confirm.js callers in tests that relied on the 2-arg signature (R1) — verify each by `grep -rn 'confirmClose' tests/` and inspecting each call site
      (b) creator.js tests that assert the old "Choose a project" toast or `projHidden.value === ''` at first render — these are now legitimately wrong and need updating (note in commit message)
      (c) the async click handler change may affect any test that synchronously asserts post-click state

    Run the full Playwright suite: `npx playwright test`. Capture pass/fail. Smoke + paste E2E suites likely don't exercise the creator card's path-check branch directly, so this is a regression-only check. If a smoke test asserts the creator's initial label or asserts that pressing a preset without typing a cwd works, those should continue to pass — empty cwd skips the check (AC 7).

    If both suites are green, advance to Task 7. If any test fails, fix it (preferring updating obsolete assertions over reverting feature behaviour) and re-run before proceeding. Do NOT continue to UAT/commit until both green.
  </action>
  <acceptance_criteria>
    - `npx vitest run` exits 0
    - `npx playwright test` exits 0
    - Any test that was updated (rather than written net-new) is documented in the eventual commit message under "Test fallout" so reviewers know what changed and why
    - Discharges SPEC AC 12, 13
  </acceptance_criteria>
  <verify>
    <automated>npx vitest run &amp;&amp; npx playwright test</automated>
  </verify>
  <done>Both suites green. Any pre-existing test that asserted "Choose a project" toast or unselected project-default has been updated and noted.</done>
</task>

<task type="checkpoint:human-verify" gate="blocking">
  <name>Task 7: Manual UAT on throwaway :4099 instance</name>
  <what-built>
    Pre-flight cwd existence check (with three modal variants) and default-to-None project picker, both on the creator card.
  </what-built>
  <how-to-verify>
    Boot a throwaway clideck instance OUTSIDE the host clideck (per memory `feedback_verify-clideck-ui-altport-playwright.md` — never test against the editor's clideck or you taskkill yourself):

    1. From a fresh PowerShell terminal (NOT inside the running clideck UI):
       ```
       $env:CLIDECK_PORT="4099"; $env:CLIDECK_DATA_DIR="$env:TEMP\clideck-phase10-uat"; Remove-Item -Recurse -Force $env:CLIDECK_DATA_DIR -ErrorAction SilentlyContinue; node C:\_Projects\clideck\server.js
       ```
       Leave the server running. In a browser, open http://localhost:4099/.

    2. **AC 9 — default-to-None on open.** Click the "+" / new session button to open the creator card. Verify:
       - The project trigger reads "None (outside project hierarchy)"
       - The cwd input is visible directly below (not hidden behind the project picker)
       - Focus is in the session-name input
       Configure a fake project first if there are zero projects (Settings → Add project pointing at any existing folder), then redo Step 2 — the None default should apply *because* projects exist now.

    3. **AC 10 — submit without touching dropdown creates ungrouped.** Without touching the project dropdown, leave the cwd input pointing at an existing folder (e.g. `C:\_Projects\clideck`), type a session name like "uat-default-none", and click any preset (e.g. Shell). Verify:
       - A session opens with no "choose a project" toast
       - The session appears under the "None" / ungrouped section (NOT under a real project)

    4. **AC 1 + AC 2 — non-existent path → create.** Open creator. Type `C:\_Projects\clideck-phase10-uat-not-yet-existing` (or any verifiably-not-existing path) into the cwd field. Click any preset. Verify:
       - The modal pops with the message "That folder doesn't exist yet. Create it and open the session there?" (or your final phrasing)
       - Confirm button reads "Create and open"
       - Cancel button reads "Cancel"
       - Click "Create and open" — the modal closes, the folder is created on disk (verify via `Test-Path C:\_Projects\clideck-phase10-uat-not-yet-existing` → True), and a new session opens in it

    5. **AC 3 — cancel returns focus.** Open creator. Type another not-existing path. Click preset. When the modal pops, click "Cancel". Verify:
       - No session was created
       - Focus is back in the cwd input
       - The offending path text is selected (so the user can immediately retype)

    6. **AC 4 — file-at-path.** Create a known-file path (e.g. `New-Item -ItemType File C:\_Projects\clideck\package.json` already exists). Open creator, type `C:\_Projects\clideck\package.json` into cwd, click preset. Verify:
       - Modal pops with "A file already exists at that path — pick a different folder." (or your final phrasing)
       - Only one button is visible (no "Create" affordance)
       - Button reads "OK" (cancelLabel:'OK')
       - Click OK — modal closes, cwd input is focused with the path text selected, NO session was created

    7. **AC 5 — permission denied.** On Windows, this requires a path under e.g. `C:\System Volume Information\anything` that statSync will EACCES. Open creator, type that path, click preset. Verify:
       - Modal pops with permission-denied wording
       - One-button (OK)
       - No session created
       Skip this if your account is admin and the path doesn't actually EACCES — note in completion report.

    8. **AC 6 — folder-picker bypasses check.** Open creator, click the folder-browse button next to the cwd field, navigate to and select an existing folder. Verify the picker writes the path into cwd. Then click a preset. The check-cwd should NOT fire (no modal pops, even briefly). Open browser devtools Network/WS tab to confirm no `check-cwd` message is sent.

    9. **AC 7 — empty cwd bypasses check.** Open creator. Clear the cwd field completely. Click any preset. Verify the session opens immediately in the default home dir, no modal, no check-cwd WS round-trip.

    10. **AC 11 — switching between None and a real project.** Open creator. Click the project trigger dropdown, pick a real project. Verify cwdWrap hides and cwd input is set to the project's path. Click the dropdown again, pick None. Verify cwdWrap re-appears and the label reverts to "None (outside project hierarchy)". Submit — ungrouped session created.

    11. **R2 — mkdir failure surfaces, session is NOT created.** Type a not-existing path that the user definitely can't mkdir (e.g. `C:\Windows\System32\definitely-cannot-create-here\new-folder`). Click preset. Verify the "Create and open" modal pops. Click "Create and open". Verify:
        - A SECOND modal pops with an error message ("Couldn't create that folder: EACCES" or similar)
        - One-button OK
        - NO session is created (the session list shows no new session)
        - On dismissing the error, focus returns to cwd input

    12. After all 11 checks pass, kill the throwaway instance: `taskkill /F /PID <pid>` (the PowerShell session running node server.js) or close that PowerShell window. Delete the test data dir: `Remove-Item -Recurse -Force $env:TEMP\clideck-phase10-uat`. Confirm the host clideck (port 3000 or wherever) is untouched.
  </how-to-verify>
  <resume-signal>Type "approved" to advance to commit + version bump, or describe issues (which AC failed, what you saw vs expected). Do NOT proceed to Task 8 until all 11 manual checks pass.</resume-signal>
</task>

<task type="auto">
  <name>Task 8: Version bump + verbose commit (no push)</name>
  <files>package.json</files>
  <read_first>
    - C:\_Projects\clideck\package.json (line 3 — read it LIVE at task time, do not rely on the value cached above; the version increments with every code-changing commit per memory `feedback_bump-version-on-code-changes.md`)
    - C:\_Projects\clideck\.planning\2026-05-27-creator-ergonomics\SPEC.md (for the commit message body)
    - ~/.claude/CLAUDE.md §3 (commit yes, push NO — origin is GitHub)
    - ~/.claude/CLAUDE.md §5 (verbose commit style — personal project default)
  </read_first>
  <action>
    1. Read `package.json` line 3 LIVE: `node -p "require('./package.json').version"`. Bump the patch segment by 1 (e.g. 1.31.10 → 1.31.11). Edit package.json directly. Verify with `node -p "require('./package.json').version"` again.

    2. Confirm the GitHub-bound git identity is configured locally — `git config user.email` should return `dev1@lancetek.com` and `git config user.name` should return `Samuel Harding`. If not, set them with `git config --local user.email dev1@lancetek.com` and `git config --local user.name "Samuel Harding"` (per ~/.claude/CLAUDE.md §4 — GitHub repos get the dev persona, never `git@lancetek.com`).

    3. `git status` — review what's staged. Expected dirty files: utils.js, handlers.js, public/js/confirm.js, public/js/creator.js, package.json, tests/path-validation.test.js, tests/check-cwd-handler.test.js, tests/mkdir-cwd-handler.test.js, tests/confirm-modal-onebutton.test.js. NO snapshot or .env files (per ~/.claude/CLAUDE.md §3 — respect .gitignore intent).

    4. `git add` ONLY the listed files explicitly by name (do NOT `git add -A`).

    5. `git commit` with a verbose message via HEREDOC. Body covers:
       - Title: `feat(creator): existence pre-flight + default-to-None project (v{NEW_VERSION})`
       - Body: phase summary, what changed in each file, the three modal variants, the 13 acceptance criteria status (all 13 ✓), R1/R2 risks discharged, vitest + playwright counts (paste actual numbers from Task 6), pointer to SPEC.md and this PLAN.md, link to the throwaway-:4099 UAT log from Task 7. Mention that resolveValidDir at utils.js:40-45 was intentionally left untouched.

    6. **DO NOT PUSH.** `origin` for this repo is GitHub (`git remote -v` will confirm `github.com/.../clideck`). Per ~/.claude/CLAUDE.md §3, GitHub remotes are commit-but-do-not-push. Lance reviews before push.

    7. Final `git status` to confirm clean, and `git log -1 --oneline` to confirm the commit is in. Surface the new version number to the user in the completion report.
  </action>
  <acceptance_criteria>
    - `node -p "require('./package.json').version"` reports the new patch-bumped version
    - `git log -1` shows the new commit authored by `Samuel Harding <dev1@lancetek.com>`
    - `git status` is clean
    - NO push has happened — confirm via `git status -sb` showing `ahead 1` on whatever branch
    - The commit message includes the AC tracking, file list, and risk disposition
    - Discharges the version-bump rule and ships the phase
  </acceptance_criteria>
  <verify>
    <automated>node -p "require('./package.json').version" &amp;&amp; git log -1 --pretty=fuller</automated>
  </verify>
  <done>Patch version bumped, commit landed locally with verbose message and the correct Samuel Harding identity, no push to GitHub.</done>
</task>

## Verification

Phase-level checks, all must pass before Task 7 (manual UAT) is taken:

1. `npx vitest run` exits 0 — includes the four new test files plus all existing suites (AC 12).
2. `npx playwright test` exits 0 — existing smoke + paste E2E suites green (AC 13).
3. `grep -n "case 'check-cwd'\\|case 'mkdir-cwd'" handlers.js` returns 2 matches.
4. `grep -n 'validateCwdPath' utils.js handlers.js tests/path-validation.test.js` returns matches across all three.
5. `grep -n "Choose a project" public/js/creator.js` returns 0 matches.
6. `grep -n 'hideConfirm' public/js/confirm.js public/js/creator.js` returns matches in both.
7. `git diff utils.js` shows only additions (validateCwdPath + path require + module.exports update) — resolveValidDir lines 40–45 unchanged.

Manual UAT (Task 7) covers all 11 user-visible AC (1–11) end-to-end on a throwaway :4099 instance, with the host clideck untouched.

## Risks

**R1 — confirm.js extension breaks existing 2-button callers.**
The current `confirmClose(message, confirmLabel)` is used by at least creator.js:118 (in-cwd collision warning), session-row delete confirm, and possibly more. Task 3 changes the signature to `confirmClose(message, confirmLabel, opts = {})` — backwards compatible by default-arg, but the new behaviour also has to RESET state between calls: if a hideConfirm:true call leaves `#cc-confirm` with the `hidden` class, a subsequent old-form call would render only the cancel button. **Mitigation:** Task 3 explicitly sets `confirmBtn.classList.remove('hidden')` and `cancelBtn.textContent = opts.cancelLabel || 'Cancel'` on EVERY confirmClose entry, regardless of opts shape. Test 3 in Task 3 verifies the reset. The full vitest run in Task 6 catches any caller regression.

**R2 — mkdir-cwd race / partial-create / EACCES surfacing.**
If `mkdirSync(path, {recursive:true})` fails partway through a multi-segment create (e.g. `C:\readonly\new\sub\folder` — the first two segments may be created before EACCES on the third), the on-disk state is partial-success but the WS result is `ok:false`. **Mitigation:** Task 2 Test 10 verifies the handler returns `ok:false` with the error code when mkdirSync throws. Task 4 routes `ok:false` into a second one-button error modal and explicitly does NOT call `createFromPreset`. Task 7 UAT step 11 exercises this branch end-to-end with `C:\Windows\System32\definitely-cannot-create-here\new-folder`. The partial on-disk state is acceptable — the user sees the error, sees nothing was opened, and can manually clean up if they care.

**Secondary risk note — Windows-specific EACCES path for AC 5.**
On a fully-admin Windows account, very few stat paths actually return EACCES (the OS opens them for admin). The vitest test uses `vi.spyOn(fs, 'statSync').mockImplementation(() => { throw Object.assign(new Error('EACCES'), { code:'EACCES' }) })` so the test always works regardless of the runner's privileges. UAT step 7 may need to be "best-effort" on admin machines — note in completion report if you can't reproduce the EACCES branch manually.

## Output

After Task 8 completes, create `.planning/2026-05-27-creator-ergonomics/PLAN-SUMMARY.md` with:
- Acceptance criteria 1–13 each checked off with the task that discharged it
- Version bumped from {OLD} → {NEW}
- vitest count delta (X new tests, Y total)
- playwright count (Z unchanged)
- Commit SHA
- Confirmation that resolveValidDir was NOT modified (per SPEC §59)
- Confirmation that NO push to GitHub happened
- Any test fallout (updated obsolete assertions, with reasoning)
- Any UAT caveats (e.g. AC 5 EACCES couldn't be manually reproduced on admin Windows — covered by automated test instead)
