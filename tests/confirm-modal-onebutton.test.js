// @vitest-environment happy-dom
//
// Phase 10 Task 3 — confirm.js hideConfirm / oneButton mode.
//
// The existing 2-button modal at #confirm-close (#cc-cancel + #cc-confirm)
// is extended with an optional opts object on confirmClose. opts.hideConfirm
// hides the #cc-confirm button so info-only modals (file-at-path, EACCES,
// mkdir-failed) render as acknowledge-only one-button overlays. opts.cancelLabel
// rewrites the visible cancel-button text so the one-button can read "OK".
//
// confirm.js reads DOM nodes at module-load time (lines 1-4 grab elements via
// getElementById). The test must populate document.documentElement.innerHTML
// BEFORE dynamic import, otherwise the import throws.

import { describe, it, expect, vi } from 'vitest';

// Minimal index.html slice — just the #confirm-close overlay + its children.
// Keeping this string in-test (rather than reading from index.html) is more
// brittle to UI changes but isolates the test from unrelated markup churn.
const CONFIRM_HTML = `
  <div id="confirm-close" class="absolute inset-0 z-[250] bg-black/60 backdrop-blur-sm hidden items-center justify-center">
    <div>
      <div id="cc-message" class="px-5 py-4 text-sm">Close this session? The terminal process will be killed.</div>
      <div>
        <button id="cc-cancel" class="px-3 py-1.5 text-xs rounded-md border border-slate-600 text-slate-300 hover:bg-slate-700 transition-colors">Cancel</button>
        <button id="cc-confirm" class="px-3 py-1.5 text-xs rounded-md bg-red-600 text-white hover:bg-red-500 transition-colors">Delete</button>
      </div>
    </div>
  </div>
`;

async function loadFreshConfirm() {
  vi.resetModules();
  document.documentElement.innerHTML = `<body>${CONFIRM_HTML}</body>`;
  // Dynamic import — module-load reads the just-populated #cc-* nodes.
  const mod = await import('../public/js/confirm.js');
  return mod;
}

describe('confirm.js hideConfirm / oneButton', () => {
  it('the legacy 2-arg form still resolves true on confirm click', async () => {
    const { confirmClose } = await loadFreshConfirm();
    const p = confirmClose('hi', 'OK');
    document.getElementById('cc-confirm').click();
    await expect(p).resolves.toBe(true);
  });

  it('hideConfirm:true adds the hidden class to #cc-confirm; cancel click resolves false', async () => {
    const { confirmClose } = await loadFreshConfirm();
    const p = confirmClose('info', 'unused', { hideConfirm: true, cancelLabel: 'OK' });
    const confirmBtn = document.getElementById('cc-confirm');
    const cancelBtn = document.getElementById('cc-cancel');
    expect(confirmBtn.classList.contains('hidden')).toBe(true);
    expect(cancelBtn.textContent).toBe('OK');
    // Dismissal via the visible cancel button — for an acknowledge-only
    // modal this is the equivalent of "user saw the message". Promise
    // resolves false; the caller of an info-only modal ignores the value.
    cancelBtn.click();
    await expect(p).resolves.toBe(false);
  });

  it('state resets between calls: a subsequent 2-arg call shows #cc-confirm again', async () => {
    const { confirmClose } = await loadFreshConfirm();
    // First, a hideConfirm:true call.
    const p1 = confirmClose('info', 'unused', { hideConfirm: true, cancelLabel: 'OK' });
    expect(document.getElementById('cc-confirm').classList.contains('hidden')).toBe(true);
    document.getElementById('cc-cancel').click();
    await p1;
    // Then a normal 2-arg call — must reset state.
    const p2 = confirmClose('proceed?', 'Go');
    expect(document.getElementById('cc-confirm').classList.contains('hidden')).toBe(false);
    expect(document.getElementById('cc-cancel').textContent).toBe('Cancel');
    expect(document.getElementById('cc-confirm').textContent).toBe('Go');
    document.getElementById('cc-confirm').click();
    await expect(p2).resolves.toBe(true);
  });

  it('cancelLabel overrides the visible cancel-button text', async () => {
    const { confirmClose } = await loadFreshConfirm();
    const p = confirmClose('info', '', { hideConfirm: true, cancelLabel: 'Got it' });
    expect(document.getElementById('cc-cancel').textContent).toBe('Got it');
    document.getElementById('cc-cancel').click();
    await p;
  });
});
