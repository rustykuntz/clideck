# Phase 11 — Focus audit (scratch — deleted in Task 7)

Date: 2026-06-03
Author: gsd-executor
Live HEAD at audit time: `67a29e6` (v1.31.13)
Read against the current source — line numbers verified live, not from the
SPEC's planning-time snapshot.

## Canonical focus-restore patterns already in tree

| # | Location | Pattern | Notes |
|---|----------|---------|-------|
| A | `terminals.js:864` (`select()`) | `if (!document.querySelector('[contenteditable="true"]')) entry.term.focus();` | The reference guard. Skip if a rename's contenteditable is live. |
| B | `terminals.js:1127` (`restartComplete()`) | `entry.term.focus();` (unguarded — selects via `select()` if not active) | The post-restart precedent. |

**Verdict:** Both call `entry.term.focus()` — never `el.focus()`. `.term-wrap`
is a plain `<div>`, not natively focusable; xterm wants its hidden helper
textarea, which `term.focus()` routes correctly. New focus calls MUST use the
same form. The guard in A is the minimum — Task 2's `refocusActiveTerm()`
extends it to inputs, textareas, selects, role=combobox, and visible overlays.

## Focus-dropping paths

| Path | File:line | Current behaviour | Where to insert `refocusActiveTerm(sessionId)` |
|------|-----------|-------------------|-----------------------------------------------|
| Ctrl+V text paste | `terminals.js:204` (`pasteIntoTerminal`) text branch line 229 | After `send({type:'input',…})` returns, no focus restoration. xterm's keypress fired against the helper-textarea, but Ctrl+V is dispatched via the document-level listener (hotkeys.js:88) which fires AFTER xterm's custom handler — at that point focus has already left `entry.term` because the user just released Ctrl+V on something else. drops focus to: `<body>` (or the dispatcher target) | Immediately after line 229 `if (text) send(...);` — call `refocusActiveTerm(sessionId)` (rAF-deferred per R2). |
| Ctrl+V binary paste | `terminals.js:217` (binary-blob branch) | After `await uploadBlobToSession(...)` returns, the function returns without restoring focus. drops focus to: `<body>` | Immediately before `return;` on line 217 — call `refocusActiveTerm(sessionId)` (rAF). |
| drop overlay teardown | `terminals.js:747` (`onDrop`) | After `await uploadBlobToSession` loop and `el.classList.remove('drag-target')`, no focus restoration. The browser's drag-drop pipeline ends with focus on `<body>`. drops focus to: `<body>` | At end of `onDrop` after the `for…await` loop completes — `refocusActiveTerm(id)` (rAF). |
| context-menu Paste | `terminals.js:363` (`openMenu` action `paste`) | Calls `await pasteIntoTerminal(sessionId)`; if Task 2 fixes pasteIntoTerminal, this path is covered transitively. The menu cleanup itself doesn't restore focus, but `pasteIntoTerminal` will after the fix. drops focus to: `<body>` (transitively fixed) | Covered by `pasteIntoTerminal` fix; no separate insertion needed. |
| selection-copy pointerup | `terminals.js:717` (`onPointerUp`) | After `showToast('Copied', …)` fires, returns without explicit focus restoration. drops focus to: ambiguous — `term` still likely focused because the click landed in `.xterm-screen`, but the showToast call mutates DOM and may shift activeElement | At end of `onPointerUp` after `await copyTerminalSelection(id)` — `refocusActiveTerm(id)` (rAF) for defence-in-depth. |
| connection-lozenge dismiss | `app.js:47-80` / `index.html:197` | Lozenge `#app-status-badge` is a `<div>`, NOT a `<button>`, no close handler, no dismiss UI. **Not dismissible.** drops focus to: N/A | **No insertion needed** — AC 6 leg satisfied by absence. Document in PLAN summary. |
| version-lozenge dismiss | `index.html` — searched: no `#version-lozenge` element exists | No version lozenge exists; the version string is rendered inline inside `#app-status-badge`'s text (`text.textContent = '… · v1.31.13 · overlay …'`). **Not dismissible.** drops focus to: N/A | **No insertion needed** — AC 6 leg satisfied by absence. |
| paste-blob toast dismiss | `toast.js:57-63` (`dismiss` arrow + `.toast-close` click handler) | The toast close button receives focus on click; clicking it triggers `dismiss` which animates the toast out and then `el.remove()` after 300ms. After `el.remove()` the focused close button is gone, focus falls to `<body>`. drops focus to: `<body>` | Inside `dismiss()` in toast.js (lines 57-63), schedule `refocusActiveTerm()` (no id — uses `state.active`) for after the `setTimeout(remove, 300)`. Either inline the rAF/setTimeout there, or call a helper exported from terminals.js. |
| confirm modal close | `confirm.js:35-39` (`close(result)`) | After `overlay.classList.add('hidden')`, the focused confirm/cancel button is hidden but still the activeElement. Browser typically falls focus to `<body>` once the focused element is hidden (display:none-ish). drops focus to: `<body>` | At end of `close(result)` in confirm.js — `refocusActiveTerm()` (rAF), but ONLY after `pendingResolve(result)` runs so the caller's continuation isn't preempted. |

## Read-first findings — caveats

1. **No `#version-lozenge`** exists in the DOM. The version string is part of
   `#app-status-badge`'s text content; it's not a separately-dismissible UI.
2. **`#app-status-badge` is non-dismissible** — no close button, no handler.
   AC 6's "connection lozenge dismiss" leg is satisfied by absence.
3. **`#remote-error-dismiss`** in index.html:478 is a close button for the
   remote-pairing modal (separate concern from paste/focus, but it lives in a
   modal overlay so it would also drop focus to body on dismiss). The SPEC's
   AC 6 mentions "any toast/modal" — adding refocus to `closeRemoteModal`
   would be defensible but it's a low-traffic path and not in the named SPEC
   list. Skip for now; document and revisit if Task 6 UAT shows residual issues.
4. **`onPointerUp` selection-copy** — debatable inclusion. Tasks 2's plan
   names it, but in practice the user's pointerup happens inside `.xterm-screen`
   which keeps focus on xterm. The `showToast` does NOT call `.focus()` on
   anything. Still — defence in depth, no-op cost, mirrors `select()`'s
   pattern. Include.
5. The Phase 9 keydown-guard ordering lesson (xterm's hidden
   `.xterm-helper-textarea` is a TEXTAREA inside `.term-wrap.active`) is
   directly relevant to **Task 5's optional forwarder**, not to
   `refocusActiveTerm`. `refocusActiveTerm`'s guard skips focus restoration
   when an input/textarea/contenteditable is focused — that's correct
   because if the user is in a sidebar search box, we MUST NOT yank focus.
   The xterm helper-textarea quirk only matters for the keydown forwarder
   that decides whether to dispatch to the active term.

## Helper API

```js
// In public/js/terminals.js (exported)
export function refocusActiveTerm(idOverride) {
  const id = idOverride ?? state.active;
  if (!id) return;
  const entry = state.terms.get(id);
  if (!entry) return;
  // Defer to the next paint — R2 mitigation. Sibling synchronous + microtask
  // handlers (toast teardown, lozenge animation, modal hide) have all run by
  // the time the rAF callback fires, so our focus call is the LAST word.
  requestAnimationFrame(() => {
    // Re-check guards on the rAF tick — DOM may have shifted in between.
    if (document.querySelector('.confirm-overlay:not(.hidden), .creator-card')) return;
    const ae = document.activeElement;
    if (ae && ae.matches?.('input, textarea, select, [contenteditable="true"], [role="combobox"]')) {
      // Exception: xterm's hidden helper-textarea IS a TEXTAREA but it's
      // a descendant of .term-wrap.active. The whole point of this helper
      // is to focus that textarea, so a TEXTAREA inside .term-wrap is
      // not a "real input" — fall through to focus.
      if (!ae.closest('.term-wrap.active')) return;
    }
    // Final entry re-lookup; another microtask could have removed it.
    const live = state.terms.get(id);
    if (live) live.term.focus();
  });
}
```

The guard considers `.creator-card` AND `.confirm-overlay:not(.hidden)` as
"don't steal focus" markers — these are the visible-modal indicators in
the current DOM (creator.js builds `.creator-card`, confirm.js toggles
`.hidden` on `#confirm-close.confirm-overlay`).

## Verdict (filled in after Task 6 UAT)

**TBD** — will be populated by Task 6 with one of:
- "Risk-1 fix sufficient — Task 5 skipped" (preferred per SPEC §82)
- "Risk-2 keydown forwarder needed — Task 5 shipped" (with rationale)
