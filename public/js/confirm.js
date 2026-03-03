const overlay = document.getElementById('confirm-close');
const confirmBtn = document.getElementById('cc-confirm');
const cancelBtn = document.getElementById('cc-cancel');
let pendingResolve = null;

export function confirmClose() {
  return new Promise((resolve) => {
    pendingResolve = resolve;
    overlay.classList.remove('hidden');
    overlay.classList.add('flex');
  });
}

function close(result) {
  overlay.classList.add('hidden');
  overlay.classList.remove('flex');
  if (pendingResolve) { pendingResolve(result); pendingResolve = null; }
}

confirmBtn.addEventListener('click', () => close(true));
cancelBtn.addEventListener('click', () => close(false));
overlay.addEventListener('click', (e) => { if (e.target === overlay) close(false); });
