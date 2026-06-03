---
phase: 10-creator-ergonomics
plan: 1
status: complete
shipped: 2026-06-03
version_bumped_from: 1.31.12
version_bumped_to: 1.31.13
commits_added: 9
ahead_of_origin: 24 (Phase 10 = 9, Phase 9 = 12, planning docs = 3)
vitest_baseline: 113 / 113
vitest_final:    146 / 147 (1 skipped on win32 — dangling-symlink test)
vitest_delta:    +33 tests across 5 new files
playwright_baseline: 24 / 24
playwright_final:    24 / 24
push: NO — origin is GitHub (per ~/.claude/CLAUDE.md §3)
---

# Phase 10 — Creator Ergonomics: shipped

Two daily-friction tolls removed from the new-session creator card:

1. **Pre-flight existence check.** Typed cwd that doesn't exist no longer
   silently lands the session in `~`. Pops a modal with Cancel / Create &
   open; file-at-path and EACCES/EPERM render one-button info modals.
2. **Default project to None.** Pre-seeded so the common case (no project)
   is zero-friction; the "Choose a project" toast guard is removed.

## Acceptance criteria — 13/13 discharged

| AC | What | Discharged by | Status |
|----|------|---------------|--------|
| 1  | Non-existent cwd pops modal | `creator.js` `ensureCwdExistsOrConfirm` + `check-cwd` handler | PASS (unit + live UAT) |
| 2  | Create & open mkdirs + opens session | `mkdir-cwd` handler + ensureCwdExistsOrConfirm not-exists branch | PASS (unit + live UAT) |
| 3  | Cancel returns focus + selects cwd | `focusCwd()` helper using `setSelectionRange(0, length)` | PASS (code review; unit test for confirm.js dismissal) |
| 4  | File-at-path: one-button modal | `confirm.js` `hideConfirm:true` + `cancelLabel:'OK'` | PASS (unit + live UAT) |
| 5  | EACCES: one-button perm-denied modal | Same hideConfirm path; `vi.spyOn(fs, 'statSync')` test | PASS (unit + spied; live UAT got EPERM via Windows system path) |
| 6  | Folder-picker skips the check | `cwdCheckedViaPicker` flag set by openFolderPicker callback | PASS (code review) |
| 7  | Empty/whitespace cwd skips check | `if (!cwd \|\| !cwd.trim()) return 'proceed'` | PASS (code review + server input-guard UAT) |
| 8  | mkdir-cwd rejects relative + `..` | `validateCwdPath` helper | PASS (unit + live UAT both rejection codes) |
| 9  | Creator opens labelled "None", cwd visible | `setProjectSelection(NO_PROJECT_VALUE)` in `if(projTrigger)` block | PASS (code review) |
| 10 | Immediate submit -> ungrouped, no toast | Dead toast guard removed; projHidden pre-seeded | PASS (code review) |
| 11 | Real-project select / switch-back-to-None | Existing `setProjectSelection(item.dataset.value)` path unchanged | PASS (regression-free; no code touched there) |
| 12 | `npx vitest run` exits 0 | All suites green | PASS — 146/147 |
| 13 | `npx playwright test` exits 0 | Smoke + paste + session E2E suites | PASS — 24/24 |

Live :4099 UAT pass matrix (run via `scripts/phase10-uat.js`):

```
[PASS] server boots on :4099
[PASS] GET /  returns 200 + index.html with #confirm-close (38834 bytes)
[PASS] AC 1: check-cwd on non-existent path -> exists:false, error:null
[PASS] AC 2: mkdir-cwd creates path recursively (verified on-disk)
[PASS] AC 4: check-cwd on file path -> exists:true, isDirectory:false
[PASS] AC 7 (server input-guard): empty check-cwd -> invalid-input
[PASS] AC 8: mkdir-cwd rejects relative path
[PASS] AC 8: mkdir-cwd rejects path containing ..
[PASS] R2: mkdir-cwd surfaces ok:false on denied path; nothing created
       (Windows System Volume Information surface -> error:EPERM)
[PASS] AC 9, 10, 11: client-side (covered by unit + Playwright)
```

## Commits (9 ahead of origin from Phase 10 alone)

```
698230f release(10-creator): v1.31.13 — pre-flight cwd + default-to-None project
851527c test(10-creator): live :4099 integration coverage for the pre-flight wire contract
9ac7e50 feat(10-creator): pre-flight cwd check + default-to-None project
121f241 feat(10-creator): extend confirmClose with hideConfirm + cancelLabel options
f2ce9f5 test(10-creator): add failing tests for confirm.js hideConfirm + cancelLabel
1651af3 feat(10-creator): wire check-cwd + mkdir-cwd WS handlers in handlers.js
c751f97 test(10-creator): add failing tests for check-cwd + mkdir-cwd handlers
d68ffa7 feat(10-creator): implement validateCwdPath in utils.js
b356a0b test(10-creator): add failing tests for validateCwdPath helper
```

RED→GREEN cadence preserved on all three TDD tasks (Tasks 1, 2, 3).
Tasks 4+5 combined into one commit (same file, tightly coupled in the
click-handler block). Task 6 verification was inline (no commit); Task 7
ships the integration test + the throwaway-:4099 UAT helper as commits.

## Risks — both discharged

**R1 — confirm.js extension breaks 2-arg callers.**
DISCHARGED. The new signature `confirmClose(message, confirmLabel, opts = {})`
defaults opts so all 9 existing call sites compile and behave identically:

```
creator.js:118   confirmClose(`There are already... session(s) in this folder...`, 'Open another')
app.js:611       confirmClose()                  // 0-arg, uses DEFAULT_MSG
app.js:807       confirmClose(`Clear N dormant sessions in "X"?`, 'Clear')
app.js:817       confirmClose(msg, 'Delete')
app.js:858       confirmClose(`Clear N dormant sessions?`, 'Clear')
app.js:902       confirmClose('Delete this previous session?', 'Delete')
app.js:1211      confirmClose(...)
app.js:1348      confirmClose(`Remove plugin "X"?`, 'Remove')
```

State reset on every entry guards against the hideConfirm class leaking
into a follow-on legacy call (Test 3 of `confirm-modal-onebutton.test.js`
pins this). Full vitest run green = no caller regressed.

**R2 — mkdir-cwd EACCES surfaces, session NOT created.**
DISCHARGED. `ensureCwdExistsOrConfirm` checks the `mkdir-cwd-result` and on
`ok:false` renders a second one-button error modal then returns `'cancel'`
— explicitly NOT calling `createFromPreset`. Live UAT verified EPERM on
Windows `System Volume Information` surface, and the folder was confirmed
not created (`existsSync(denied) === false` after the call).

## Invariants preserved

- **`resolveValidDir` at `utils.js:40-45` byte-identical to pre-phase.**
  Verified by `git show e7dea35:utils.js | sed -n '40,45p'` matching
  `sed -n '40,45p' utils.js` exactly:
  ```js
  function resolveValidDir(dir) {
    try {
      if (dir && statSync(dir).isDirectory()) return dir;
    } catch {}
    return require('os').homedir();
  }
  ```
  `validateCwdPath` sits alongside, not in place of, the existing silent-
  fallback. Resumed sessions whose cwd later vanished still get the soft
  landing per SPEC §57.

- **`gsd-sdk` not invoked.** Orchestrator flagged SDK broken; ran inline
  throughout (per the executor brief). All state changes were done via
  direct git operations.

- **No push.** Origin is `github.com/tekstaker/clideck`. Per
  `~/.claude/CLAUDE.md` §3, GitHub remotes are commit-but-do-not-push.

## Test inventory (5 new files, 33 new tests, +33 over baseline)

| File | Tests | Env | Purpose |
|------|-------|-----|---------|
| `tests/path-validation.test.js` | 10 | node | `validateCwdPath` contract (empty / not-absolute / parent-traversal / ok) |
| `tests/check-cwd-handler.test.js` | 6 (1 skipped on win32) | node | check-cwd WS handler branches incl. broken symlink |
| `tests/mkdir-cwd-handler.test.js` | 6 | node | mkdir-cwd handler branches incl. mocked EACCES |
| `tests/confirm-modal-onebutton.test.js` | 4 | happy-dom | confirm.js hideConfirm + cancelLabel + reset between calls |
| `tests/creator-preflight-integration.test.js` | 8 | node | Real server.js on :4099 + real WebSocket end-to-end |

Plus `scripts/phase10-uat.js` (not a test file; a standalone live verifier
that boots :4099, fetches index.html, and runs the same WS-level checks
for periodic re-verification).

## Test fallout / deviations

NONE. No existing test required modification:
- The R1 backwards-compat invariant means all confirm.js callers kept
  working without source-side changes (only behaviour change is the new
  state-reset, which is invisible to legacy 2-arg callers).
- The dead-toast removal in Task 5 didn't trigger any test fallout because
  no existing test asserted the "Choose a project" toast string (verified
  by `grep -rn 'Choose a project' tests/` returning zero matches before
  the change).
- One Playwright run had a single flake on the unrelated
  `terminal-interactions.spec.js:103` clipboard test; passed cleanly on
  retry. Pre-existing test, no connection to Phase 10 changes.

## Caveats / honest limits

- **Browser visual UAT for AC 9-11 was NOT run via Playwright MCP.**
  This executor instance did not have Playwright MCP browser tools
  available. Instead I shipped a real-server real-WebSocket integration
  test (`tests/creator-preflight-integration.test.js`) that drives the
  server-side contract end-to-end, plus a standalone live UAT script
  (`scripts/phase10-uat.js`) that did boot :4099 successfully and verify
  the HTTP shell + WS round-trips in one run. Lance can manually open
  http://localhost:3000/ (the host clideck) after a UI reload to confirm
  visually that:
    - Creator opens with "None (outside project hierarchy)" trigger label
    - cwd input is visible without first selecting a project
    - Submit without dropdown touch creates an ungrouped session, no toast
  These are AC 9, 10, 11 and are covered by the static code review and
  the existing smoke E2E suite that opens/closes the creator card.

- **AC 5 EACCES is best-effort on Windows admin accounts.** Most admin-
  visible paths don't return EACCES on `statSync`. The unit test uses
  `vi.spyOn(fs, 'statSync')` to inject the error condition, and the live
  UAT got an equivalent surface (EPERM on `System Volume Information`)
  which the handler maps the same way the spec calls for EACCES. See
  SPEC §60 secondary risk note.
