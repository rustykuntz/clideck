const overlay = document.getElementById('confirm-close');
const messageEl = document.getElementById('cc-message');
const confirmBtn = document.getElementById('cc-confirm');
const cancelBtn = document.getElementById('cc-cancel');
let pendingResolve = null;

const DEFAULT_MSG = 'Close this session? The terminal process will be killed.';

// confirmClose(message, confirmLabel, opts = {})
//
// 2-button mode (legacy, default):  await confirmClose('Open another?', 'Open another')
//                                   resolves true on confirm-click, false on cancel-click.
//
// 1-button (acknowledge-only) mode: await confirmClose('That's a file', '', { hideConfirm:true, cancelLabel:'OK' })
//                                   hides #cc-confirm, renames #cc-cancel to opts.cancelLabel.
//                                   Resolves false on cancel-click (or backdrop click). The
//                                   caller of an info-only modal ignores the resolution
//                                   value — what matters is the await returns.
//
// Both modes reset the DOM on every entry so state from a prior hideConfirm:true
// call cannot leak into a subsequent legacy-form call (Phase 10 R1 mitigation).
export function confirmClose(message, confirmLabel, opts = {}) {
  return new Promise((resolve) => {
    pendingResolve = resolve;
    messageEl.textContent = message || DEFAULT_MSG;
    confirmBtn.textContent = confirmLabel || 'Delete';
    cancelBtn.textContent = opts.cancelLabel || 'Cancel';
    if (opts.hideConfirm === true) confirmBtn.classList.add('hidden');
    else confirmBtn.classList.remove('hidden');
    overlay.classList.remove('hidden');
    overlay.classList.add('flex');
  });
}

function close(result) {
  overlay.classList.add('hidden');
  overlay.classList.remove('flex');
  if (pendingResolve) { pendingResolve(result); pendingResolve = null; }
  // AC 6 — modal dismiss must leave focus on the active terminal. The
  // confirm/cancel button was the activeElement until we hid the
  // overlay; once hidden the browser drops focus to <body> and the
  // user's next Enter would be lost. Defer to terminals.js's helper
  // (registered on window to avoid a circular import). The rAF inside
  // refocusActiveTerm also re-checks `.confirm-overlay:not(.hidden)`
  // so a subsequent open() during the same tick won't be undone.
  window.__refocusActiveTerm?.();
}

confirmBtn.addEventListener('click', () => close(true));
cancelBtn.addEventListener('click', () => close(false));
overlay.addEventListener('click', (e) => { if (e.target === overlay) close(false); });
