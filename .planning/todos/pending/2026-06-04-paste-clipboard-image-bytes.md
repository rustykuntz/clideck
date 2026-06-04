---
created: 2026-06-04
title: Paste raw clipboard image bytes (SnagIt / snipping-tool screenshots) into the terminal
area: ui
files:
  - public/js/terminals.js
  - server.js
  - sessions.js
---

## Problem

Pasting image **bytes from the clipboard** into the terminal (e.g. a SnagIt
screenshot, Windows Snipping Tool, "Copy image" from a web page, screen capture
into clipboard) doesn't deliver the image to the session. The user sees nothing
happen, or possibly an empty `readText()` result that gets swallowed.

What DOES work today (so the gap is specific to clipboard-resident image bytes):
- Dragging an image FILE from File Explorer onto the terminal → uploads and
  pastes the path. ✅
- Saving a screenshot to a `.png`/`.gif` first, then dragging that file in → works. ✅
- Ctrl+V text → routed to PTY. ✅
- Ctrl+V a file COPIED in File Explorer → was supposed to route to the binary
  branch, but the binary branch may have the same gap as clipboard image bytes.

The blocking workflow today is the user's most common case: SnagIt captures
a region of the screen and puts the image directly on the clipboard with no
file artifact, and that flow currently produces zero terminal output.

## Existing infrastructure (shipped Phase 8 — paste-blobs, v1.31.7)

The plumbing exists. `pasteIntoTerminal()` at `public/js/terminals.js:265-304`
already has a binary-aware branch:

```
const binaryType = item.types.find(t => !t.startsWith('text/'));
if (binaryType) {
  const blob = await item.getType(binaryType);
  await uploadBlobToSession(sessionId, blob, binaryType);
  ...
}
```

It uploads to `/sessions/:id/paste-blob` then the server writes the resulting
relative path into the PTY (so the agent sees the path, not the bytes).

So why isn't SnagIt working? Two leading hypotheses:

### Hypothesis 1 — `item.types` doesn't include `image/*` for SnagIt's clipboard payload

On Windows, SnagIt typically puts a `CF_DIB` / `CF_BITMAP` on the clipboard.
The browser's async Clipboard API only re-exposes that as `image/png` for
certain sources (Snipping Tool, "Copy image" from Chromium, etc.) — not
universally. Test:
- Snipping Tool screenshot → does Ctrl+V work? (If yes, gap is SnagIt-specific.)
- "Copy image" from a Chromium web page → does Ctrl+V work?

Diagnostic to add inline (devtools console):
```
navigator.clipboard.read().then(items => items.forEach(i => console.log(i.types)))
```
Run with each tool's clipboard payload, see which surface `image/png` and
which don't.

If SnagIt surfaces nothing on `item.types` that matches `image/*`, the fix
is upstream of clideck — but the **diagnostic UX** can still be improved:
when `clipboard.read()` returns items but none have a matching binary or
text type, show a toast ("Clipboard contains data clideck can't read — save
as a file and drag it in").

### Hypothesis 2 — upload path missing a filename

The binary branch calls `uploadBlobToSession(sessionId, blob, binaryType)` —
three args. The drag-and-drop path (around `terminals.js:830`+) calls the
same helper with `(sessionId, file, file.type, file.name)` — **four args
including the filename**. Clipboard image blobs have NO filename. If
`uploadBlobToSession` or the server endpoint requires `filename` and
rejects/no-ops when missing, that explains the silent failure.

Diagnostic to verify:
- Set a clipboard image (via Snipping Tool to exclude SnagIt's quirks).
- Open devtools Network tab.
- Ctrl+V.
- Look for a POST to `/sessions/:id/paste-blob` — does it fire? What does
  the server respond?
- If the request never fires: Hypothesis 1.
- If it fires with no filename header and gets rejected: Hypothesis 2 — fix
  is to synthesize a name like `paste-${Date.now()}.png` (mime-derived
  extension) at the call site, exactly the same way drag-drop hands the
  server `file.name`.
- If it fires with success but PTY shows nothing: bug is in the server's
  PTY-write-after-upload path.

## Solution sketch

Once the hypothesis is pinned:

- **If H1**: This is a clipboard-API limitation, not a clideck bug. Improve
  the toast UX to tell the user what to do (save-then-drag fallback). Maybe
  log `item.types` to a diagnostic toast for the user to report.
- **If H2** (the more likely / actionable one): Synthesize a filename at the
  clipboard binary path:
  ```
  const ext = (binaryType.split('/')[1] || 'bin').replace(/[^a-z0-9]+/gi, '');
  const filename = `paste-${Date.now()}.${ext}`;
  await uploadBlobToSession(sessionId, blob, binaryType, filename);
  ```
  Then verify the server's `/sessions/:id/paste-blob` handler in
  `server.js` writes the path into the PTY the same way the drag-drop
  upload does.

Probably both: fix H2 if applicable, AND improve the toast for genuinely
unreadable clipboard payloads (H1).

## Acceptance

1. SnagIt screenshot → Ctrl+V in an active terminal → image lands in
   `.clideck/paste/` with a synthesized name (e.g. `paste-1717488000.png`)
   and the path is typed into the PTY.
2. Windows Snipping Tool screenshot → same.
3. "Copy image" from a web page (Chromium right-click → Copy image) → same.
4. If the clipboard payload genuinely can't be read (no matching MIME type),
   a toast tells the user with a clear next step (save as file + drag).
5. Existing Ctrl+V text paste behaviour is unchanged.
6. Existing drag-drop file path is unchanged.
7. All vitest + Playwright suites still pass; ideally add a small unit test
   that mocks `navigator.clipboard.read()` returning an image blob and
   asserts the upload call shape (sessionId, blob, binaryType, filename).

## Relation to shipped work

- Phase 8 (`2026-05-20-paste-blobs`, v1.31.7) shipped the binary-aware
  Ctrl+V path and the drag-drop file flow. This is a follow-up gap-closure
  on the clipboard half — the drag-drop side works because it passes
  `file.name`; the clipboard side passes no filename.
- Phase 11 (`2026-05-27-terminal-focus`, v1.31.14) added
  `refocusActiveTerm(sessionId)` calls on both binary and text branches of
  `pasteIntoTerminal`, so once this gap closes the post-paste Enter-submit
  behaviour will work for clipboard images too.
