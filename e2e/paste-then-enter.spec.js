// Paste-then-Enter — Phase 11's regression test for the
// "Enter is a no-op after Ctrl+V" bug.
//
// Mirrors e2e/ctrl-v-paste.spec.js but adds one critical step: after the
// Ctrl+V lands, we press Enter WITHOUT clicking the terminal first. With
// Phase 11's refocusActiveTerm() shipped, the post-paste term has focus
// and Enter routes to the PTY. Without the fix, focus is on <body> and
// the Enter is swallowed — the second input frame never arrives and the
// test times out asserting `length === 2`.
//
// Assertions:
//   1. The first input frame matches the pasted text.
//   2. The second input frame is '\r' — xterm emits CR for plain Enter
//      (verified against attachToTerminal in public/js/hotkeys.js:118-139
//      which only special-cases Shift+Enter for the claude-code preset).
//
// Note: do NOT add a click() between Ctrl+V and Enter. The whole point
// of this spec is to assert focus survived without one.

const { test, expect } = require('@playwright/test');

async function installWsRecorder(page) {
  await page.addInitScript(() => {
    /** @type {any} */ const w = window;
    w.__rxTypes = new Set();
    w.__rxMessages = [];
    w.__sentMessages = [];
    const OrigWS = w.WebSocket;
    function PatchedWS(...args) {
      const ws = new OrigWS(...args);
      const origSend = ws.send.bind(ws);
      ws.send = function (data) {
        try { w.__sentMessages.push(JSON.parse(data)); }
        catch { w.__sentMessages.push(String(data)); }
        return origSend(data);
      };
      ws.addEventListener('message', (ev) => {
        try {
          const msg = JSON.parse(ev.data);
          w.__rxTypes.add(msg.type);
          w.__rxMessages.push(msg);
        } catch {}
      });
      w.__ws = ws;
      return ws;
    }
    PatchedWS.prototype = OrigWS.prototype;
    PatchedWS.CONNECTING = OrigWS.CONNECTING;
    PatchedWS.OPEN = OrigWS.OPEN;
    PatchedWS.CLOSING = OrigWS.CLOSING;
    PatchedWS.CLOSED = OrigWS.CLOSED;
    w.WebSocket = PatchedWS;
  });
}

async function waitForAppReady(page) {
  await expect.poll(
    async () => page.evaluate(() => Array.from(/** @type {any} */ (window).__rxTypes || [])),
    { timeout: 10_000, intervals: [100, 200, 500] }
  ).toEqual(expect.arrayContaining(['config', 'sessions', 'presets']));
}

test.describe('Paste-then-Enter — focus survives Ctrl+V', () => {
  test('Ctrl+V followed by Enter (no click in between) sends BOTH frames to the PTY', async ({ page, context }) => {
    await context.grantPermissions(['clipboard-read', 'clipboard-write'], {
      origin: 'http://localhost:4099',
    });

    await installWsRecorder(page);
    await page.goto('/');
    await waitForAppReady(page);

    await page.evaluate(() => {
      /** @type {any} */ const w = window;
      w.__ws.send(JSON.stringify({ type: 'create', cols: 80, rows: 24 }));
    });

    const sessionId = await page.evaluate(async () => {
      /** @type {any} */ const w = window;
      const deadline = Date.now() + 10_000;
      while (Date.now() < deadline) {
        const created = w.__rxMessages.find((m) => m.type === 'created');
        if (created) return created.id;
        await new Promise((r) => setTimeout(r, 50));
      }
      return null;
    });
    expect(sessionId, 'server should have broadcast a created message').toBeTruthy();

    // Address the xterm inside the ACTIVE term-wrap. Sister tests in the
    // suite may have spawned earlier sessions that left their .term-wrap
    // in the DOM but without the .active class — their .xterm is hidden.
    // `.first()` would resolve to whichever is alphabetically first in
    // the DOM order, which can be the hidden one. Scoping to .active
    // makes this stable regardless of suite ordering.
    const xterm = page.locator('.term-wrap.active .xterm').first();
    await expect(xterm).toBeVisible({ timeout: 5_000 });

    const PASTE_TEXT = 'echo phase11 paste then enter';

    await page.evaluate(async (text) => {
      await navigator.clipboard.writeText(text);
    }, PASTE_TEXT);

    await xterm.click();
    await page.keyboard.press('Control+V');

    // Wait for the paste frame to land first — gates the Enter so we
    // don't accidentally race it ahead of the paste's input event.
    await expect.poll(
      async () => page.evaluate((id) => {
        /** @type {any} */ const w = window;
        return w.__sentMessages.filter(
          (m) => m && m.type === 'input' && m.id === id
        ).length;
      }, sessionId),
      { timeout: 5_000, intervals: [50, 100, 250] }
    ).toBe(1);

    // The critical step. NO click() here — that would re-focus the term
    // and defeat the regression test. The whole point is that
    // refocusActiveTerm() inside pasteIntoTerminal already restored
    // focus to the xterm helper-textarea, so Enter routes through.
    await page.keyboard.press('Enter');

    // Two input frames total: the paste text, then '\r' for Enter.
    await expect.poll(
      async () => page.evaluate((id) => {
        /** @type {any} */ const w = window;
        return w.__sentMessages.filter(
          (m) => m && m.type === 'input' && m.id === id
        );
      }, sessionId),
      { timeout: 5_000, intervals: [50, 100, 250] }
    ).toEqual([
      { type: 'input', id: sessionId, data: PASTE_TEXT },
      { type: 'input', id: sessionId, data: '\r' },
    ]);
  });
});
