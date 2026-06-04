---
created: 2026-06-04
title: Visible shutdown feedback — Ctrl+C ack, progress log, and hard timeout
area: server
files:
  - server.js
  - sessions.js
  - bin/clideck.js
---

## Problem

When the user hits **Ctrl+C** in the terminal where they launched `clideck`,
the server gives **no feedback at all**:

- No log message acknowledging the SIGINT.
- No progress messages while shutdown work runs.
- No "goodbye" line before exit.
- Sometimes the process appears to hang indefinitely with no indication of
  what's happening.

The workaround the user has been forced into: **close the terminal window
entirely**, which is heavier than necessary and risks orphaning child
processes.

The user's stated expectation:

> *"I would like some sort of feedback when I hit control C. And then some
> sort of logging messages to let me know what's happening. I mean it should
> shut down pretty instantly. Um but if it's got things to do, then just you
> know throw a message every few seconds until it's done. Let me know how
> long it's gonna take."*

## Root cause (verified)

`onShutdown` at **`server.js:385-390`** is the SIGINT/SIGTERM handler. Its
body:

```
function onShutdown() {
  try { plugins.shutdown(); }            catch (e) { console.error('[shutdown] plugins:',  e.message); }
  try { activity.stop(); }               catch (e) { console.error('[shutdown] activity:', e.message); }
  try { sessions.shutdown(getConfig()); } catch (e) { console.error('[shutdown] sessions:', e.message); }
  process.exit(0);
}
```

It logs **nothing on the happy path** — only errors. From the user's
perspective: dead silence between "I pressed Ctrl+C" and the process
disappearing (or appearing to hang).

If any step blocks synchronously (e.g. `node-pty.kill()` on Windows ConPTY
has known cases of hanging), `process.exit(0)` is never reached and the
user sees no feedback at all — exactly the "just sits there silently"
symptom.

Additional consideration: `bin/clideck.js` may launch the server via a
wrapper; if SIGINT is delivered to the wrapper rather than the server (or
vice versa), the registered handler may not run at all. Verify the signal
chain before writing the fix.

## Solution sketch

Three behaviours to add, in order of priority:

### 1. Immediate acknowledgement on SIGINT (most important)

First thing inside `onShutdown` — log a clear, styled banner:

```
console.log('\n[clideck] Ctrl+C received — shutting down…');
```

The leading newline matters: the user's shell typically prints `^C` on the
current line; the newline separates clideck's message from that and makes
it readable.

### 2. Per-step progress + duration

Wrap each step with a labelled timer and result:

```
const step = (label, fn) => {
  const t0 = Date.now();
  process.stdout.write(`[clideck] ${label}… `);
  try { fn(); console.log(`done (${Date.now()-t0}ms)`); }
  catch (e) { console.log(`failed: ${e.message}`); }
};
step('flushing plugins',  () => plugins.shutdown());
step('stopping activity', () => activity.stop());
step('persisting sessions', () => sessions.shutdown(getConfig()));
console.log('[clideck] goodbye.');
process.exit(0);
```

This way each step prints its label, then `done (Xms)` or `failed: …` on
the same line.

### 3. Heartbeat for slow shutdowns + hard timeout watchdog

Some steps (notably `sessions.shutdown` which may kill many PTYs) can take
longer than expected. Add:

- A **heartbeat interval** (every 3 seconds while shutdown is in
  progress): `"[clideck] still shutting down… (current step: persisting
  sessions, elapsed: 8s)"`.
- A **hard-timeout watchdog**: if total shutdown exceeds e.g. 10 seconds,
  log `"[clideck] shutdown is taking too long — forcing exit"` and call
  `process.exit(0)` regardless. The user should NEVER have to close the
  terminal window because clideck hung.

Implementation note: heartbeats run on a real-timer, but `process.exit()`
inside a synchronous handler will interrupt them. So either:
- Make `onShutdown` async (await each step, allows event-loop interleaving
  for the heartbeat timer to fire), OR
- Keep it synchronous but add the timeout via `setImmediate` + `setTimeout`
  before each step.

The async refactor is cleaner. Each step would return a Promise that
resolves when its work is done.

## Acceptance

1. Pressing Ctrl+C in the terminal where clideck was launched immediately
   prints `[clideck] Ctrl+C received — shutting down…` within ~50ms.
2. Each shutdown step prints its label and completion time (or failure).
3. If total shutdown elapsed exceeds 3 seconds, a heartbeat log fires every
   3 seconds: `[clideck] still shutting down… (current step: X, elapsed: Ys)`.
4. If total shutdown exceeds a hard cap (e.g. 10s), the server force-exits
   with a `[clideck] shutdown took too long — forcing exit` log.
5. Final line before exit: `[clideck] goodbye.` (or similar).
6. The user no longer needs to close the terminal window to recover from
   a hung shutdown.
7. SIGTERM (e.g. from `taskkill /PID <pid>` without `/F`) behaves the same
   as SIGINT.
8. On Windows specifically, Ctrl+C must actually reach the server process
   — verify via the `bin/clideck.js` wrapper (if any) that SIGINT is
   propagated, not swallowed. If a wrapper is involved, the wrapper itself
   should also log "[clideck] forwarding Ctrl+C to server…" so signal
   path is debuggable.

## ⚠ Footgun warning

This is **lifecycle work** — exactly the category of change that
[[../../../memory/feedback_clideck-meta-work.md]] (Don't iterate on
clideck inside clideck) warns about. Don't iterate on this from inside the
host clideck session — work in an external terminal (PowerShell or Windows
Terminal), boot the candidate build manually, and exercise Ctrl+C there.
Throwaway-:4099 verification is also appropriate per
[[../../../memory/feedback_verify-clideck-ui-altport-playwright.md]].

## Relation to shipped work

The current `onShutdown` shape dates from the 2026-05-18 "stranded PID
12980 on port 4000" incident — comments at server.js:380-383 explain the
isolated-try/catch design. That defensive shape must be **preserved**;
this todo only adds logging and a hard-timeout watchdog around it. The
isolation rationale (one stuck step must not prevent `process.exit`) still
applies and gets reinforced by the watchdog.

The broken in-UI server restart was removed from main on 2026-05-27 (see
[[../../../memory/project_restart-button-broken.md]]). Restart-from-the-UI
is parked as Phase 4. This todo doesn't revive in-UI restart; it just
makes the manual `Ctrl+C → relaunch clideck` flow tolerable in the
interim.
