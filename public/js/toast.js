const ICONS = {
  info:    '<path stroke-linecap="round" stroke-linejoin="round" d="M11.25 11.25l.041-.02a.75.75 0 011.063.852l-.708 2.836a.75.75 0 001.063.853l.041-.021M21 12a9 9 0 11-18 0 9 9 0 0118 0zm-9-3.75h.008v.008H12V8.25z"/>',
  success: '<path stroke-linecap="round" stroke-linejoin="round" d="M9 12.75L11.25 15 15 9.75M21 12a9 9 0 11-18 0 9 9 0 0118 0z"/>',
  warn:    '<path stroke-linecap="round" stroke-linejoin="round" d="M12 9v3.75m-9.303 3.376c-.866 1.5.217 3.374 1.948 3.374h14.71c1.73 0 2.813-1.874 1.948-3.374L13.949 3.378c-.866-1.5-3.032-1.5-3.898 0L2.697 16.126ZM12 15.75h.007v.008H12v-.008Z"/>',
  error:   '<path stroke-linecap="round" stroke-linejoin="round" d="M12 9v3.75m9-.75a9 9 0 11-18 0 9 9 0 0118 0zm-9 3.75h.008v.008H12v-.008z"/>',
};

const ICON_COLORS = {
  info: 'text-blue-400', success: 'text-emerald-400', warn: 'text-amber-400', error: 'text-red-400',
};

function getContainer() {
  let c = document.getElementById('tmx-toasts');
  if (c) return c;
  c = document.createElement('div');
  c.id = 'tmx-toasts';
  c.className = 'fixed bottom-5 right-5 z-[500] flex flex-col gap-2.5';
  document.body.appendChild(c);
  return c;
}

/**
 * @param {string} message  — plain text or HTML (if html option is true)
 * @param {{ type?: string, duration?: number, id?: string, html?: boolean }} opts
 * @returns {{ dismiss(): void }}
 */
export function showToast(message, opts = {}) {
  const { type = 'info', duration = 3000, id, html = false } = opts;

  if (id) document.getElementById(`tmx-toast-${id}`)?.remove();

  const el = document.createElement('div');
  if (id) el.id = `tmx-toast-${id}`;
  el.className = 'w-[360px] bg-slate-800/95 backdrop-blur-sm border border-slate-700/60 rounded-xl tmx-toast';
  el.style.cssText = 'opacity:0;transform:translateY(12px);transition:opacity 0.3s ease,transform 0.3s ease';
  el.innerHTML = `
    <div class="flex items-start gap-2.5 px-4 py-3.5">
      <svg class="w-5 h-5 flex-shrink-0 ${ICON_COLORS[type] || ICON_COLORS.info} mt-0.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="2">${ICONS[type] || ICONS.info}</svg>
      <p class="flex-1 text-xs text-slate-300 leading-relaxed">${html ? message : esc(message)}</p>
      <button class="flex-shrink-0 w-6 h-6 flex items-center justify-center rounded-md text-slate-500 hover:text-slate-300 hover:bg-slate-700/50 transition-colors">
        <svg class="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="2"><path d="M18 6L6 18M6 6l12 12"/></svg>
      </button>
    </div>`;

  const dismiss = () => {
    el.style.opacity = '0';
    el.style.transform = 'translateY(12px)';
    setTimeout(() => el.remove(), 300);
  };

  el.querySelector('button').onclick = dismiss;
  getContainer().appendChild(el);
  requestAnimationFrame(() => { el.style.opacity = '1'; el.style.transform = 'translateY(0)'; });
  if (duration > 0) setTimeout(dismiss, duration);
  return { dismiss };
}

function esc(s) {
  const d = document.createElement('div');
  d.textContent = s;
  return d.innerHTML;
}
