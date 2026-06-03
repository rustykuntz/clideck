---
phase: 11-terminal-focus
plan: 01
type: execute
wave: 1
depends_on: []
files_modified:
  - public/js/terminals.js
  - public/js/app.js
  - public/js/toast.js
  - public/js/hotkeys.js          # ONLY if Task 5 (conditional fallback) ships
  - tests/keydown-forward-guard.test.js  # ONLY if Task 5 ships
  - e2e/paste-then-enter.spec.js   # new — AC 8
  - package.json                   # patch bump
autonomous: true
covers_acceptance_criteria: [1, 2, 3, 4, 5, 6, 7, 8]

must_haves:
  truths:
    - "AC 1: After Ctrl+V into the active terminal, Enter submits to the PTY with no intervening click."
    - "AC 2: After a drag-and-drop file paste, once the drop overlay tears down, Enter submits to the PTY."
    - "AC 3: After the file-picker / context-menu paste path resolves, Enter submits to the PTY."
    - "AC 4: A click anywhere over the .term-wrap (not just the prompt row) re-focuses the xterm instance."
    - "AC 5 (conditional): If a global keydown fallback is shipped, it NEVER hijacks focus from sidebar search, any input/textarea, contenteditable, select, role=combobox, or any visible modal/overlay."
    - "AC 6: Dismissing the connection lozenge, version lozenge, paste-blob toast, or any toast/modal leaves keyboard focus on the active terminal, not <body>."
    - "AC 7: `npx vitest run` exits 0 — all existing unit suites still pass."
    - "AC 8: `npx playwright test` exits 0 — all existing E2E pass AND the new paste-then-Enter E2E asserts the PTY received the Enter-terminated input frame."
  artifacts:
    - path: ".planning/2026-05-27-terminal-focus/AUDIT-NOTES.md"
      provides: "Forensic audit of which paste/dismissal paths drop focus to <body> (scratch — deleted in Task 7)."
    - path: "public/js/terminals.js"
      provides: "Focus restoration on every paste path + .term-wrap click delegate."
      contains: "entry.term.focus"
    - path: "e2e/paste-then-enter.spec.js"
      provides: "Playwright E2E: writeText → Ctrl+V → Enter → assert PTY received both frames."
    - path: "package.json"
      provides: "patch version bump (read live, bump patch by 1 — e.g. if live is 1.31.11, write 1.31.12) surfacing in the connection lozenge."
      contains: "\"version\":"
  key_links:
    - from: "Ctrl+V hotkey dispatch (hotkeys.js)"
      to: "pasteIntoTerminal(sessionId) (terminals.js:204)"
      via: "registerHotkey('Ctrl+V', …) → callback → pasteIntoTerminal → entry.term.focus() AS LAST STEP"
      pattern: "entry\\.term\\.focus\\(\\)"
    - from: ".term-wrap pointerdown/click"
      to: "entry.term.focus()"
      via: "el.addEventListener('click', …) installed alongside the existing 'pointerup' selection handler (terminals.js:660)"
      pattern: "addEventListener\\('click'"
    - from: "drop overlay teardown (onDrop in terminals.js:690)"
      to: "entry.term.focus()"
      via: "after el.classList.remove('drag-target') and after all uploadBlobToSession awaits resolve"
      pattern: "drag-target"
    - from: "toast / lozenge dismissal handlers"
      to: "active entry.term.focus()"
      via: "dismiss handler resolves → state.terms.get(state.active)?.term.focus()"
      pattern: "term\\.focus"

---

## Goal

SPEC.md §7-15 names the regression: after every paste path (Ctrl+V, drag-and-drop, file picker, context-menu Paste), focus lands on `<body>` or xterm's hidden helper-textarea's *sibling*, so Enter is a no-op until the user clicks the narrow prompt row. Recently-shipped overlays (`2026-05-20-paste-blobs` drop overlay, `2026-05-19` lozenge relocation, `2026-05-16` Ctrl+V) are the prime suspects — each tears down a DOM element without explicitly returning focus to `entry.term`.

This phase delivers the SPEC's 8 acceptance criteria, ordered by SPEC §82's risk hierarchy: explicit paste-path `entry.term.focus()` first (additive, near-zero risk), then a wider click target (AC 4), then a new Playwright E2E that catches the regression (AC 8). The global keydown fallback (AC 5) is shipped ONLY if the explicit fixes do not close the gap — its risk of hijacking sidebar/search focus outweighs its incremental win when A+B work.

All UAT runs on a throwaway `:4099` instance with an isolated `CLIDECK_DATA_DIR` (per memory `feedback_verify-clideck-ui-altport-playwright.md`). Iterating on a paste fix inside the host clideck would mean every Ctrl+V is suspect — strictly forbidden by `feedback_clideck-meta-work.md`.

## Tasks

<task type="execute">
  <name>Task 1: Focus audit — produce AUDIT-NOTES.md</name>
  <files>
    .planning/2026-05-27-terminal-focus/AUDIT-NOTES.md (new — scratch, deleted in Task 7)
  </files>
  <read_first>
    - public/js/terminals.js — focus on these regions:
      - `pasteIntoTerminal` (line 204-233): note that NEITHER the binary-blob `return` on line 217 NOR the text-paste `send(...)` on line 229 calls `entry.term.focus()` before returning.
      - `onPointerUp` selection-copy (line 660-666): does not re-focus the term after the toast fires.
      - drop handlers (line 678-701): `onDrop` (line 690) awaits `uploadBlobToSession` then returns — no focus restoration.
      - `select(id)` (line 783-810): line 807 already does `if (!document.querySelector('[contenteditable="true"]')) entry.term.focus();` — confirm this is the canonical guard pattern to reuse elsewhere.
      - `restartComplete` (line 1064-1071): line 1070 calls `entry.term.focus()` — confirm pattern.
      - `startRename` (line 1075-1106): contenteditable rename is the reason for the `[contenteditable="true"]` guard in `select()`. Don't break it.
    - public/js/hotkeys.js — `attachToTerminal` (line 118-139) routes xterm's custom key handler through `dispatch()`. Confirm Ctrl+V on a focused xterm routes through hotkeys → pasteIntoTerminal, AND the document-level keydown listener (line 88-91) handles Ctrl+V when focus is on `<body>` (the post-paste state).
    - public/js/app.js — search for `registerHotkey.*Ctrl\\+V` and for `closeLozenge`, `dismissToast`, `connection-lozenge`, `version-lozenge` handlers. Determine which dismissal paths leave focus on the dismiss-button (→ falls to body when button is removed).
    - public/js/toast.js — find the dismiss/close path. Document whether the close button retains focus when `.remove()` is called.
    - public/js/confirm.js — modal close path. Where does focus go after the overlay hides?
    - public/index.html — confirm `.term-wrap` exists as the per-terminal container and `<main id="main">` wraps the terminal area. Identify the click target's bounds.
  </read_first>
  <acceptance_criteria>
    AUDIT-NOTES.md exists and contains:
    1. **Table** of each focus-dropping path with three columns: `Path | Current behaviour | Where to insert entry.term.focus() (file:line)`.
    2. At minimum, one row per: Ctrl+V text paste, Ctrl+V binary-blob paste (the `return` on line 217), drop overlay teardown, context-menu Paste, selection-copy pointerup, connection-lozenge dismiss, version-lozenge dismiss, paste-blob toast dismiss, confirm modal close.
    3. **Verdict** at the bottom: "Risk-1 fix (Tasks 2-3) sufficient" OR "Risk-2 keydown forwarder needed" — to be filled in AFTER Task 6's UAT, not now. Leave a `TBD` placeholder.
    4. Confirms the `select(id)` and `restartComplete` patterns are the focus-restore precedent — every new focus call MUST use the same `entry.term.focus()` form (NOT `el.focus()` — `.term-wrap` is not natively focusable and xterm wants its helper-textarea).
  </acceptance_criteria>
  <action>
    Read each path identified in <read_first>. For every spot where a paste, dismissal, or overlay teardown completes without restoring focus to the active term, add a row to AUDIT-NOTES.md. Use the existing `select(id)` guard pattern as the model for new focus calls: skip restoration only when `document.activeElement` is inside a `[contenteditable="true"]` element, an `<input>`, `<textarea>`, `<select>`, or `[role="combobox"]`. Do NOT modify any production code in this task — AUDIT-NOTES.md is the only output.
  </action>
  <verify>
    <automated>node -e "const f=require('fs');const s=f.readFileSync('.planning/2026-05-27-terminal-focus/AUDIT-NOTES.md','utf8');const required=['Ctrl+V text','Ctrl+V binary','drop overlay','context-menu','pointerup','connection-lozenge','version-lozenge','paste-blob toast','confirm modal'];const missing=required.filter(t=>!s.toLowerCase().includes(t.toLowerCase()));if(missing.length){console.error('missing:',missing);process.exit(1)}console.log('audit OK')"</automated>
  </verify>
  <done>AUDIT-NOTES.md committed alongside PLAN.md. Each focus-dropping path has a named insertion point.</done>
</task>

<task type="execute">
  <name>Task 2: Paste-path focus restoration (AC 1, 2, 3, 6)</name>
  <files>
    public/js/terminals.js
    public/js/app.js
    public/js/toast.js
    public/js/confirm.js  # IF AUDIT-NOTES Task 1 identified a focus-drop on modal close
  </files>
  <read_first>
    AUDIT-NOTES.md (Task 1 output) — the table is the spec for this task.
    public/js/terminals.js lines 204-233, 660-666, 678-701, 783-810 (the `select()` guard pattern is the model).
  </read_first>
  <acceptance_criteria>
    For each path identified in AUDIT-NOTES.md as focus-dropping, an `entry.term.focus()` call (or the active-session equivalent: `state.terms.get(state.active)?.term.focus()`) is the LAST action before the handler returns. Specifically:

    1. `pasteIntoTerminal(sessionId)` (terminals.js:204): BOTH return paths — the binary-blob branch (after `await uploadBlobToSession`) AND the text-paste branch (after `send({type:'input',…})`) — end by calling `state.terms.get(sessionId)?.term.focus()`, guarded by the same `[contenteditable="true"]`/input/textarea/select/[role=combobox] skip as `select()` line 807.
    2. `onDrop` handler (terminals.js:690): after the `for…uploadBlobToSession` loop awaits resolve and `el.classList.remove('drag-target')`, call `state.terms.get(id)?.term.focus()` (with the guard).
    3. `onPointerUp` selection-copy (terminals.js:660): after the showToast fires, restore focus to `term` (the same `term` already in scope) — `term.focus()` with the guard.
    4. Context-menu "Paste" action (terminals.js:363): the `await pasteIntoTerminal(sessionId)` resolution is followed by `closeMenu()` (already called on line 359) — confirm Task 2.1's fix in `pasteIntoTerminal` covers this path (it will, since the focus call is inside `pasteIntoTerminal` itself).
    5. Connection-lozenge / version-lozenge dismiss handler in app.js: after the dismiss handler removes the lozenge node, the handler MUST call `state.terms.get(state.active)?.term.focus()` (guarded).
    6. toast.js close button click handler: same — after `.remove()` of the toast node, call `state.terms.get(state.active)?.term.focus()` (guarded).
    7. confirm.js modal close: same — only if AUDIT-NOTES identified a focus-drop there.

    The guard helper is reusable. Add a single exported helper to terminals.js (e.g. `refocusActiveTerm()`) that:
    - Looks up `state.terms.get(state.active)` (or accepts an id arg for path-specific cases).
    - Skips when `document.activeElement` matches `'input, textarea, select, [contenteditable="true"], [role="combobox"]'`.
    - Skips when any visible modal/overlay is open (`.confirm-overlay:not(.hidden)`, `.creator-card` present in DOM).
    - Calls `entry.term.focus()` only if the entry exists and the guards pass.

    Replace the inline guard at line 807 in `select()` with a call to this helper for consistency.
  </acceptance_criteria>
  <action>
    Add `export function refocusActiveTerm(idOverride)` to terminals.js implementing the guard described above. Wire calls to it at the SIX named insertion points (Task 2.1 through 2.6). Refactor the existing `select()` line 807 guard to call `refocusActiveTerm(id)` — same behaviour, deduped logic. Do NOT use `el.focus()` anywhere — `.term-wrap` is not natively focusable and xterm wants its hidden helper-textarea, which `term.focus()` handles. The focus call MUST be the LAST statement in each handler before return — per Risk R2, ordering matters (any teardown that re-focuses an unrelated element after our call will undo it). When in doubt, defer with `requestAnimationFrame(() => refocusActiveTerm(id))` so the call lands on the next paint, after sibling handlers have run.
  </action>
  <verify>
    <automated>npx vitest run</automated>
  </verify>
  <done>
    `npx vitest run` exits 0. `grep -n "refocusActiveTerm\|term.focus()" public/js/terminals.js` shows the helper exported and called at the 6 insertion points. Manual UAT in Task 6 confirms behaviour.
  </done>
</task>

<task type="execute">
  <name>Task 3: Wider click target on .term-wrap (AC 4)</name>
  <files>
    public/js/terminals.js
  </files>
  <read_first>
    public/js/terminals.js line 625-666 — the per-terminal setup where `el` is the `.term-wrap` container, `term.open(el)` injects xterm inside it, and the existing `pointerup` selection-copy handler is already attached to `el`. The new click handler attaches at the SAME spot in the same idiom.
  </read_first>
  <acceptance_criteria>
    1. A `click` (or `pointerdown`) listener on `el` (the `.term-wrap` container) calls `term.focus()` when the click target is within `el` but NOT inside an interactive child (`button`, `a`, `[contenteditable="true"]`, `input`, `textarea`, the drop-overlay card while visible).
    2. The handler does NOT interfere with xterm's own click handling (text selection, link clicks) — xterm's events live on `.xterm-screen` inside `el`, and `term.focus()` is idempotent / safe to call even when the term already has focus.
    3. The handler does NOT fire when a drag is in progress (i.e. when text selection is being made) — gate on `!term.hasSelection()` to leave the existing pointerup-copy flow untouched. (The pointerup-copy handler already triggers on selection release; our handler triggers on clicks that DIDN'T produce a selection — these are mutually exclusive at runtime.)
    4. The handler is registered in `addTerminal` alongside the existing `pointerup`, `dragover`, `dragleave`, `drop` handlers, and is added to the `state.terms.set(...)` entry so `removeTerminal` (line 754-781) can detach it on cleanup (mirroring the `entry.onPointerUp`/`entry.onDragOver`/etc. teardown pattern on lines 761-764).
  </acceptance_criteria>
  <action>
    In terminals.js around line 666 (immediately after `el.addEventListener('pointerup', onPointerUp);`), add `const onClickRefocus = (e) => { if (e.target.closest('button, a, [contenteditable="true"], input, textarea, .drop-overlay-card')) return; if (term.hasSelection()) return; term.focus(); };` and `el.addEventListener('click', onClickRefocus);`. Extend the `state.terms.set(...)` payload on line 746 to include `onClickRefocus`. In `removeTerminal` (after the `onDrop` teardown on line 764), add `if (entry.onClickRefocus) entry.el.removeEventListener?.('click', entry.onClickRefocus);`. Use `term.focus()`, NOT `el.focus()` — `.term-wrap` is not natively focusable.
  </action>
  <verify>
    <automated>npx vitest run</automated>
  </verify>
  <done>Clicking anywhere on `.term-wrap` in the throwaway :4099 UAT (Task 6) re-focuses the terminal. Cleanup verified — `removeTerminal` detaches the listener.</done>
</task>

<task type="execute">
  <name>Task 4: Playwright E2E — paste-then-Enter (AC 8)</name>
  <files>
    e2e/paste-then-enter.spec.js (new)
  </files>
  <read_first>
    e2e/ctrl-v-paste.spec.js (the entire file) — copy the `installWsRecorder` helper, the `waitForAppReady` helper, the create-session pattern, the `__sentMessages.filter` polling pattern. The new test is `ctrl-v-paste.spec.js` + one extra step.
    e2e/paste-blob-upload.spec.js — for the drag-and-drop variant if you want to add it (optional; the SPEC explicitly names "paste then Enter", text-paste is the canonical case).
  </read_first>
  <acceptance_criteria>
    1. New file `e2e/paste-then-enter.spec.js` mirrors `ctrl-v-paste.spec.js`'s setup: addInitScript installs `__sentMessages` recorder, app boot, `create` session, wait for `.xterm` visible, `xterm.click()` to focus, `navigator.clipboard.writeText(PASTE_TEXT)`, `page.keyboard.press('Control+V')`.
    2. NEW step: WITHOUT another `xterm.click()`, `page.keyboard.press('Enter')` — this is the bug repro. With Tasks 2-3 shipped, the post-paste term has focus and Enter routes to PTY.
    3. Assert `__sentMessages` contains TWO `{type:'input', id:sessionId, data:…}` frames: the first with `data === PASTE_TEXT`, the second with `data === '\\r'` — xterm emits CR for plain Enter; verified against `attachToTerminal` in public/js/hotkeys.js:118-139 which only special-cases Shift+Enter for the `claude-code` preset.
    4. Test PASSES against the patched build and FAILS (or times out on the second frame) against `main` pre-patch — record a one-liner in AUDIT-NOTES.md confirming the failing-baseline observation if you ran it. (Optional; primary acceptance is green on patched build.)
    5. `npx playwright test e2e/paste-then-enter.spec.js` exits 0 against the patched build run on :4099.
  </acceptance_criteria>
  <action>
    Duplicate `e2e/ctrl-v-paste.spec.js` to `e2e/paste-then-enter.spec.js`. Rename the `test.describe` block. After the existing `await page.keyboard.press('Control+V');`, add a small wait for the first `input` frame to be recorded (mirror the existing `expect.poll` but assert `length === 1` first), then `await page.keyboard.press('Enter');`, then `expect.poll` for `length === 2` and assert the second frame's `data` matches Enter's wire bytes. Do NOT add a `click()` between paste and Enter — that defeats the regression test.
  </action>
  <verify>
    <automated>npx playwright test e2e/paste-then-enter.spec.js</automated>
  </verify>
  <done>The new spec is green on the patched build. The full E2E suite (`npx playwright test`) is also green.</done>
</task>

<task type="execute">
  <name>Task 5 (CONDITIONAL — skip if Task 6 UAT shows AC 1-6 closed by Tasks 2-3): Global keydown forwarder fallback (AC 5)</name>
  <files>
    public/js/hotkeys.js
    public/js/terminals.js (export the active-term helper if needed)
    tests/keydown-forward-guard.test.js (new — TDD guard function)
  </files>
  <read_first>
    public/js/hotkeys.js line 73-91 — the existing `isInput()` helper and the document-level keydown listener. The forwarder extends `isInput`'s exclusion list and adds an overlay check.
    AUDIT-NOTES.md — re-read the Verdict line (filled in by Task 6) to confirm this task is needed.
  </read_first>
  <acceptance_criteria>
    **SKIP THIS TASK** if Task 6's UAT shows Tasks 2-3 fully closed the gap. The SPEC §82 explicitly directs us to prefer the explicit paste-path fixes; the forwarder is "the riskiest piece." Update AUDIT-NOTES.md's Verdict line to "Risk-1 fix sufficient — Task 5 skipped" in that case.

    If shipped:

    1. TDD: create `tests/keydown-forward-guard.test.js` FIRST with vitest happy-dom env. Export a pure function `shouldForwardKeydown(activeElement, openOverlays)` from a new file or from `hotkeys.js`. The function returns `true` ONLY when:
       - `activeElement` is `document.body` (or null).
       - `activeElement` is NOT an `<input>`, `<textarea>`, `<select>`, `[contenteditable="true"]`, `[role="combobox"]`, or inside one (use `.closest()`).
       - `openOverlays` (passed in — caller queries `document.querySelector('.confirm-overlay:not(.hidden), .creator-card')`) is null/empty.
       - The combo is NOT one already registered as a global hotkey (avoid hijacking Ctrl+V, Alt+F4, etc.).
    2. Tests RED first, then GREEN:
       - input focused → false
       - textarea focused → false
       - contenteditable focused → false
       - select focused → false
       - [role=combobox] focused → false
       - element INSIDE a contenteditable → false
       - visible `.confirm-overlay` → false
       - `.creator-card` present → false
       - body focused with no overlays → true
       - body focused but combo is a registered hotkey → false (forwarder defers to dispatcher)
    3. Wire the forwarder into the document keydown listener (hotkeys.js line 88-91): when `shouldForwardKeydown(...)` returns true AND `state.active && state.terms.get(state.active)`, call `state.terms.get(state.active).term.focus()` BEFORE the keystroke is lost. **Enter replay is REQUIRED, not conditional** — the keydown that triggered this forwarder is already consumed, so refocusing alone won't deliver Enter to the PTY. When `e.key === 'Enter'` AND the guard returned true, also call `state.terms.get(state.active).term.input('\\r')` and `e.preventDefault()` to inject the CR into the PTY stream. For non-Enter keys, refocus only — the user re-presses naturally. Add a corresponding guard-suite test case: "Enter with body focus + no overlays → guard returns true AND the caller MUST replay '\\r'" (the test asserts the guard return value; the wire-up code is integration-tested in Task 4's paste-then-Enter E2E running against the patched build).
    4. Existing E2E `ctrl-v-paste.spec.js` and the new `paste-then-enter.spec.js` still pass.
    5. Manual UAT: type into the sidebar search box — keystrokes appear in the search field, NOT swallowed by the terminal.
    6. Manual UAT: open the confirm modal (e.g. delete a session) — Enter inside the modal does NOT bubble to the terminal.
  </acceptance_criteria>
  <action>
    Confirm Task 6 UAT first. If skipped, document "Task 5 skipped — Tasks 2-3 closed AC 1-6" in AUDIT-NOTES.md and proceed to Task 7. If shipped: write `tests/keydown-forward-guard.test.js` with the 10 cases above (RED), commit (`test(11-01): add failing guard tests for keydown forwarder`), implement `shouldForwardKeydown` until tests pass (GREEN), commit (`feat(11-01): add keydown forwarder guard function`), wire into hotkeys.js (`feat(11-01): forward keydown to active term when focus is on body`).
  </action>
  <verify>
    <automated>npx vitest run tests/keydown-forward-guard.test.js</automated>
  </verify>
  <done>If shipped: guard tests green, full vitest green, full Playwright green, manual UAT (sidebar search + confirm modal) confirms no hijack. If skipped: AUDIT-NOTES.md Verdict line reads "Risk-1 fix sufficient — Task 5 skipped".</done>
</task>

<task type="execute">
  <name>Task 6: Manual UAT on throwaway :4099 + final verification (AC 1-6 + AC 7-8)</name>
  <files>
    .planning/2026-05-27-terminal-focus/AUDIT-NOTES.md (update Verdict line)
  </files>
  <read_first>
    memory `feedback_verify-clideck-ui-altport-playwright.md` — the throwaway-instance pattern.
    memory `feedback_clideck-meta-work.md` — DO NOT test against the host clideck.
  </read_first>
  <acceptance_criteria>
    All run against a throwaway instance, NOT the host clideck:
    ```powershell
    $env:CLIDECK_PORT="4099"
    $env:CLIDECK_DATA_DIR="$env:TEMP\clideck-phase11-uat-$(Get-Random)"
    node server.js
    ```
    (Run in a separate terminal that is NOT inside the host clideck — this is the recursive footgun from `feedback_clideck-meta-work.md`. The fix touches the paste/focus pathway; if you UAT inside the host clideck, your Ctrl+V to paste a curl command IS the bug under test.)

    UAT script (each step must observably pass — type the failure mode, do not just infer):
    1. **AC 1 (Ctrl+V text paste)**: Click into terminal, click somewhere else to lose focus (e.g. sidebar), use OS clipboard to put text "echo hello", press Ctrl+V — text appears at the cursor — WITHOUT clicking, press Enter — line is submitted, "hello" is echoed by the shell.
    2. **AC 2 (drag-and-drop paste)**: Drag a file from File Explorer onto the terminal, drop — toast says "Pasted → …", path is typed into the prompt — WITHOUT clicking, press Enter — line is submitted (likely "command not found" or the file is opened, depending on what was dropped — the point is Enter REACHED the PTY).
    3. **AC 3 (context-menu paste)**: Right-click the terminal → Paste — text appears — WITHOUT clicking, press Enter — submitted.
    4. **AC 4 (wider click target)**: Click sidebar to focus it. Click near the EDGE of the terminal area (NOT the prompt row, NOT a button) — terminal is re-focused, typing produces output at the cursor.
    5. **AC 5 (no input hijack)**: Click sidebar search box, type "test" — characters appear in the search field, NOT swallowed by the terminal. (This passes trivially if Task 5 is skipped, since no global forwarder exists; still verify the search still works.)
    6. **AC 6 (lozenge/toast dismiss)**: Trigger a paste-blob upload (drag a small file) → wait for "Pasted →" toast → dismiss the toast (if it has a close button) — WITHOUT clicking the terminal, press Enter — submitted. Repeat for: connection lozenge if dismissible, version lozenge if dismissible.
    7. **AC 7**: `npx vitest run` exits 0.
    8. **AC 8**: `npx playwright test` exits 0 (against the patched build; you may need to start the test server separately or rely on Playwright's webServer config — check `playwright.config.js`).

    After UAT:
    - Update AUDIT-NOTES.md Verdict line: "Risk-1 fix sufficient — Task 5 skipped" OR "Risk-2 keydown forwarder needed — Task 5 shipped". If the latter, go run Task 5 now.
    - Tear down the throwaway: `taskkill /F /IM node.exe /FI "WINDOWTITLE eq *4099*"` (or kill the process you spawned). Delete the temp data dir.
  </acceptance_criteria>
  <action>
    Boot the throwaway :4099 server. Run the 8-step UAT script. Record pass/fail per step in your completion report (per §1 of `~/.claude/CLAUDE.md` — "verify before claiming done"). If AC 1-3 or AC 6 fails: extend Task 2's `refocusActiveTerm` coverage to the missed path (paste-path explicit fix is preferred per SPEC §82), then re-UAT. Ship Task 5 (the global keydown forwarder) ONLY if AC 1-6 still fails AFTER Task 2 has been extended to every named insertion point. Update Verdict. Tear down the throwaway when green.
  </action>
  <verify>
    <automated>npx vitest run && npx playwright test</automated>
    <human-check>UAT script (1-6 above) all green. Verdict line in AUDIT-NOTES.md updated.</human-check>
  </verify>
  <done>All 8 ACs pass observationally. AUDIT-NOTES.md Verdict line is set. Throwaway torn down.</done>
</task>

<task type="execute">
  <name>Task 7: Version bump, scratch cleanup, commit (no push)</name>
  <files>
    package.json (patch bump)
    .planning/2026-05-27-terminal-focus/AUDIT-NOTES.md (DELETE)
  </files>
  <read_first>
    package.json LIVE — read line 3 to confirm the CURRENT version at commit time (do not trust the planning-time value of 1.31.10; another commit may have landed between planning and execute). Use `node -e "console.log(require('./package.json').version)"`.
    `~/.claude/CLAUDE.md` §3 (no push to GitHub remote) and §5 (verbose, beautiful commit messages for personal projects). The clideck repo's `origin` is `github.com/tekstaker/clideck.git` (Lance's GitHub fork — DO NOT push without explicit instruction). `upstream` is `github.com/rustykuntz/clideck.git` (the original — also DO NOT push). No Gitea remote exists for this repo despite the memory note `clideck-fork.md`; verify with `git remote -v` at execute time and only push to a Gitea remote if one is actually present.
  </read_first>
  <acceptance_criteria>
    1. `package.json` version is bumped one patch from the LIVE value at execute time (e.g. if live is 1.31.11, write 1.31.12). Read the LIVE value first; never hardcode.
    2. `AUDIT-NOTES.md` is deleted (`git rm` it — it was a scratch).
    3. A single commit lands containing: the code changes (terminals.js, app.js, toast.js, possibly confirm.js, possibly hotkeys.js + the guard test if Task 5 shipped), the new E2E file, the package.json bump, and the AUDIT-NOTES.md deletion.
    4. Commit message is verbose per §5 — covers what (AC-by-AC), why (the regression hypothesis from SPEC §27), what was deferred (Task 5 if skipped, with rationale tied to UAT pass), what was UAT'd manually, and the risks (R1 + R2 from the Risks section).
    5. Commit author is correct for this repo. `clideck` on GitHub uses `Samuel Harding <dev1@lancetek.com>` per ~/.claude/CLAUDE.md §4. Verify with `git config user.email` BEFORE committing. (Recent commits confirm `Samuel Harding` is in use.)
    6. `git push origin` is NOT run. If a Gitea remote exists in `git remote -v` and the memory `clideck-fork.md` confirms `tekstaker/clideck` is the Gitea fork, push to THAT remote only.
    7. Connection lozenge in the UAT shows the new version (already torn down — verify on the next launch, or note as a follow-up sanity check).
  </acceptance_criteria>
  <action>
    Read `package.json` line 3 live. Bump the patch component. Delete `AUDIT-NOTES.md` (`git rm`). Stage explicitly named files (no `git add -A` per §3). Compose a verbose commit message documenting AC coverage, the regression theory, UAT results, and Task 5 disposition. Commit. Do NOT push to GitHub origin. If a Gitea remote exists, push to it.
  </action>
  <verify>
    <automated>node -e "const v=require('./package.json').version;console.log('version:',v);process.exit(0)" && git log -1 --format=%s</automated>
  </verify>
  <done>One commit on main containing all phase changes, AUDIT-NOTES.md removed, version bumped, NOT pushed to GitHub origin.</done>
</task>

## Verification

**Automated:**
```
npx vitest run                       # AC 7
npx playwright test                  # AC 8 (full suite including new paste-then-Enter spec)
```

**Manual UAT (throwaway :4099 — see Task 6):**
The footgun: iterating on a focus/paste fix inside the host clideck means every Ctrl+V interaction is the bug under test. Boot a throwaway with isolated data dir, drive it with Playwright + manual clicks, tear it down when done. NEVER run UAT against the host clideck for this phase. (memory: `feedback_clideck-meta-work.md`, `feedback_verify-clideck-ui-altport-playwright.md`).

UAT script lives in Task 6's acceptance criteria — 6 click-by-click scenarios covering AC 1-6, plus the two automated commands above for AC 7-8.

## Risks

**R1: Keydown forwarder hijacks legitimate input focus.**
If Task 5 ships, a top-level keydown listener that calls `term.focus()` could swallow keystrokes from the sidebar search box, contenteditable rename inputs, confirm-modal inputs, or any future form control. **Mitigation:** the `shouldForwardKeydown` guard (pure function, fully unit-tested per the TDD spec in Task 5) excludes input/textarea/select/[contenteditable="true"]/[role="combobox"] elements AND elements *inside* them (`.closest()` check) AND any visible overlay (`.confirm-overlay:not(.hidden)`, `.creator-card`). Secondary mitigation: Task 5 is CONDITIONAL — if Tasks 2-3 close AC 1-6 in UAT, the forwarder is not shipped at all, eliminating the risk entirely. SPEC §82 explicitly prefers this posture.

**R2: Post-paste focus race — `entry.term.focus()` runs BEFORE a sibling handler that re-focuses an unrelated element.**
The toast/lozenge/overlay teardown paths are async and may interleave: our paste handler calls `term.focus()`, then a separate `setTimeout`-scheduled animation callback re-focuses the dismiss button, then the dismiss button is removed, focus falls to body — and we're back to the bug. **Mitigation:** every paste-path focus call in Task 2 uses `requestAnimationFrame(() => refocusActiveTerm(id))` so the call lands on the NEXT paint, after sibling synchronous + microtask handlers have run. Ordering is explicit in the action prose: focus is the LAST statement in each handler. Task 6's manual UAT specifically catches this — if Enter is still lost after a toast dismiss, the race is the cause and the rAF defer is the fix.

## Success Criteria

- [ ] All 8 SPEC ACs pass: AC 1-6 by manual UAT on :4099, AC 7 by `vitest run`, AC 8 by `playwright test` (new spec + existing suite).
- [ ] No regression in existing E2E (paste-blob upload, dictation Alt+F4 flow, etc.).
- [ ] `package.json` patch bumped; connection lozenge reflects new build on next launch.
- [ ] `AUDIT-NOTES.md` deleted (scratch).
- [ ] Single commit on `main`, NOT pushed to `origin` (GitHub).
- [ ] Sidebar search box typing still works (negative test for R1).

## Output

Create `.planning/2026-05-27-terminal-focus/11-01-SUMMARY.md` when done, per the standard execute-plan summary template. Document Task 5's disposition (shipped vs skipped) and the AUDIT-NOTES Verdict line explicitly — the next phase that touches focus management will want that breadcrumb.
