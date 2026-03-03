import { state, send } from './state.js';
import { esc } from './utils.js';

const launcher = document.getElementById('launcher');

export function openLauncher() {
  const enabled = state.cfg.commands.filter(c => c.enabled);
  if (enabled.length === 0) return;
  if (enabled.length === 1) {
    send({ type: 'create', commandId: enabled[0].id });
    return;
  }
  launcher.innerHTML = enabled.map(c =>
    `<div class="launcher-item flex items-center gap-2 px-3 py-2 cursor-pointer hover:bg-slate-700 transition-colors text-sm" data-cmd="${c.id}">
      <span class="flex-1 text-slate-200">${esc(c.label)}</span>
      <span class="text-xs text-slate-500">${esc(c.command)}</span>
    </div>`
  ).join('');
  const btnRect = document.getElementById('btn-new').getBoundingClientRect();
  const mainRect = document.getElementById('main').getBoundingClientRect();
  launcher.style.top = (btnRect.bottom - mainRect.top + 4) + 'px';
  launcher.style.left = Math.max(0, btnRect.left - mainRect.left - 200 + btnRect.width) + 'px';
  launcher.classList.remove('hidden');
}

export function closeLauncher() {
  launcher.classList.add('hidden');
}

launcher.addEventListener('click', (e) => {
  const item = e.target.closest('.launcher-item');
  if (item) {
    send({ type: 'create', commandId: item.dataset.cmd });
    closeLauncher();
  }
});

document.addEventListener('click', (e) => {
  if (!launcher.contains(e.target) && e.target.id !== 'btn-new') closeLauncher();
});
