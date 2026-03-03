export function esc(s) {
  return s.replace(/[&<>"']/g, c => ({ '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;' }[c]));
}

export function debounce(fn, ms) {
  let t;
  return (...a) => { clearTimeout(t); t = setTimeout(() => fn(...a), ms); };
}

const TERMINAL_SVG = `<svg class="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="4 17 10 11 4 5"/><line x1="12" y1="19" x2="20" y2="19"/></svg>`;

export function agentIcon(icon, px = 32) {
  const s = `width:${px}px;height:${px}px`;
  if (icon && icon.startsWith('/')) {
    return `<img src="${esc(icon)}" style="${s}" class="rounded object-cover flex-shrink-0" alt="">`;
  }
  if (icon === 'terminal') {
    return `<div style="${s}" class="rounded bg-slate-700 flex items-center justify-center text-slate-400 flex-shrink-0">${TERMINAL_SVG}</div>`;
  }
  return `<div style="${s}" class="rounded bg-slate-700 flex items-center justify-center text-lg flex-shrink-0">${icon || '?'}</div>`;
}
