import { state, send } from './state.js';
import { esc, debounce } from './utils.js';
import { openFolderPicker } from './folder-picker.js';
import { themePreviewColors } from './profiles.js';

export function renderSettings() {
  document.getElementById('cfg-default-path').value = state.cfg.defaultPath || '';
  document.getElementById('cfg-confirm-close').checked = state.cfg.confirmClose !== false;
  renderCommandList();
  renderProfileSection();
}

// --- Commands ---

function renderCommandList() {
  document.getElementById('cmd-list').innerHTML = state.cfg.commands.map((c, i) =>
    `<div class="cmd-row flex items-center gap-2 p-2.5 bg-slate-800/50 border border-slate-700/50 rounded-lg" data-idx="${i}">
      <input type="checkbox" ${c.enabled ? 'checked' : ''} class="cmd-enabled accent-blue-500" title="Enabled">
      <input type="text" value="${esc(c.label)}" class="cmd-label-input flex-1 px-2 py-1 text-sm bg-slate-900 border border-slate-700 rounded text-slate-200 placeholder-slate-500 outline-none focus:border-blue-500 transition-colors" placeholder="Label">
      <input type="text" value="${esc(c.command)}" class="cmd-command-input flex-1 px-2 py-1 text-sm bg-slate-900 border border-slate-700 rounded text-slate-200 placeholder-slate-500 outline-none focus:border-blue-500 transition-colors font-mono" placeholder="Command">
      <button class="cmd-del text-slate-500 hover:text-red-400 px-1 transition-colors" title="Remove">&times;</button>
    </div>`
  ).join('');
}

// --- Profiles ---

function stripHTML(themeId) {
  const colors = themePreviewColors(themeId);
  if (!colors.length) return '';
  return colors.map(c => `<span class="flex-1 h-3" style="background:${c}"></span>`).join('');
}

function themeSelectHTML(themeId) {
  const selected = state.themes.find(t => t.id === themeId);
  const label = selected ? esc(selected.name) : 'Default';
  return `<input type="hidden" class="prof-theme" value="${themeId}">
    <button type="button" class="theme-trigger w-full px-2 py-1.5 text-sm bg-slate-900 border border-slate-700 rounded text-slate-200 text-left flex items-center justify-between outline-none hover:border-slate-500 transition-colors cursor-pointer">
      <span class="theme-label truncate">${label}</span>
      <span class="text-slate-500 text-xs ml-2">&#9662;</span>
    </button>
    <div class="theme-strip flex mt-1.5 rounded overflow-hidden">${stripHTML(themeId)}</div>`;
}

let themeMenuCleanup = null;

export function closeThemeMenu() {
  if (themeMenuCleanup) themeMenuCleanup();
}

function openThemeMenu(triggerEl) {
  closeThemeMenu();
  const row = triggerEl.closest('.profile-row');
  const hidden = row.querySelector('.prof-theme');

  const rect = triggerEl.getBoundingClientRect();
  const maxH = 280;
  const gap = 4;
  const spaceBelow = window.innerHeight - rect.bottom - gap;
  const spaceAbove = rect.top - gap;
  const openAbove = spaceBelow < maxH && spaceAbove > spaceBelow;
  const menuH = Math.min(maxH, openAbove ? spaceAbove : spaceBelow);

  const menu = document.createElement('div');
  menu.className = 'fixed z-[500] min-w-[260px] bg-slate-800 border border-slate-600 rounded-lg shadow-xl shadow-black/40 py-1 overflow-y-auto';
  menu.style.maxHeight = menuH + 'px';
  menu.style.left = rect.left + 'px';
  if (openAbove) {
    menu.style.bottom = (window.innerHeight - rect.top + gap) + 'px';
  } else {
    menu.style.top = (rect.bottom + gap) + 'px';
  }

  menu.innerHTML = state.themes.map(t => {
    const colors = themePreviewColors(t.id);
    const strip = colors.length
      ? `<div class="flex mt-1 rounded overflow-hidden">${colors.map(c => `<span class="flex-1 h-2" style="background:${c}"></span>`).join('')}</div>`
      : '';
    return `<div class="theme-option px-3 py-2 cursor-pointer hover:bg-slate-700 transition-colors ${t.id === hidden.value ? 'bg-slate-700/50' : ''}" data-value="${t.id}">
      <div class="text-sm text-slate-200">${esc(t.name)}</div>
      ${strip}
    </div>`;
  }).join('');

  document.body.appendChild(menu);

  const onClick = (e) => {
    const item = e.target.closest('.theme-option');
    if (item) {
      hidden.value = item.dataset.value;
      triggerEl.querySelector('.theme-label').textContent =
        state.themes.find(t => t.id === item.dataset.value)?.name || 'Default';
      const strip = row.querySelector('.theme-strip');
      if (strip) strip.innerHTML = stripHTML(item.dataset.value);
      saveConfig();
    }
    closeThemeMenu();
  };
  const onOutside = (e) => {
    if (!menu.contains(e.target) && !triggerEl.contains(e.target)) closeThemeMenu();
  };
  menu.addEventListener('click', onClick);
  requestAnimationFrame(() => document.addEventListener('click', onOutside));

  themeMenuCleanup = () => {
    menu.removeEventListener('click', onClick);
    document.removeEventListener('click', onOutside);
    menu.remove();
    themeMenuCleanup = null;
  };
}

function renderProfileSection() {
  const single = state.cfg.profiles.length <= 1;
  document.getElementById('appearance-title').textContent = single ? 'Appearance' : 'Terminal Styles';
  document.getElementById('btn-add-profile').textContent = single ? '+ Add another style' : '+ Add style';

  const defaultId = state.cfg.defaultProfile || 'default';

  if (single) {
    const p = state.cfg.profiles[0] || { id: 'default', name: 'Default', themeId: 'default', accentColor: '#3b82f6' };
    document.getElementById('profile-list').innerHTML =
      `<div class="profile-row p-3 bg-slate-800/50 border border-slate-700/50 rounded-lg" data-idx="0">
        <div class="flex items-end gap-3">
          <div class="flex-1">
            <label class="text-xs text-slate-500 mb-1 block">Theme</label>
            ${themeSelectHTML(p.themeId)}
          </div>
          <div>
            <label class="text-xs text-slate-500 mb-1 block">Accent</label>
            <input type="color" value="${p.accentColor || '#3b82f6'}" class="prof-accent w-8 h-8 rounded border border-slate-700 bg-slate-900 cursor-pointer" title="Accent color">
          </div>
        </div>
      </div>`;
  } else {
    document.getElementById('profile-list').innerHTML = state.cfg.profiles.map((p, i) => {
      const isDefault = p.id === defaultId;
      return `<div class="profile-row p-3 bg-slate-800/50 border ${isDefault ? 'border-blue-500/50' : 'border-slate-700/50'} rounded-lg" data-idx="${i}">
        <div class="flex items-center gap-2 mb-2">
          <button class="prof-default text-sm ${isDefault ? 'text-yellow-400' : 'text-slate-600 hover:text-yellow-400'} transition-colors" title="${isDefault ? 'Default style' : 'Set as default'}">&#9733;</button>
          <input type="text" value="${esc(p.name)}" class="prof-name flex-1 px-2 py-1 text-sm bg-slate-900 border border-slate-700 rounded text-slate-200 placeholder-slate-500 outline-none focus:border-blue-500 transition-colors" placeholder="Style name">
          <button class="prof-del text-slate-500 hover:text-red-400 px-1 transition-colors" title="Remove">&times;</button>
        </div>
        <div class="flex items-end gap-3">
          <div class="flex-1">
            <label class="text-xs text-slate-500 mb-1 block">Theme</label>
            ${themeSelectHTML(p.themeId)}
          </div>
          <div>
            <label class="text-xs text-slate-500 mb-1 block">Accent</label>
            <input type="color" value="${p.accentColor || '#3b82f6'}" class="prof-accent w-8 h-8 rounded border border-slate-700 bg-slate-900 cursor-pointer" title="Accent color">
          </div>
        </div>
      </div>`;
    }).join('');
  }
}

// --- Save ---

function saveConfig() {
  // Commands
  const cmdRows = document.querySelectorAll('.cmd-row');
  state.cfg.commands = [...cmdRows].map((row, i) => ({
    id: state.cfg.commands[i]?.id || crypto.randomUUID(),
    label: row.querySelector('.cmd-label-input').value.trim() || 'Untitled',
    command: row.querySelector('.cmd-command-input').value.trim() || '/bin/zsh',
    enabled: row.querySelector('.cmd-enabled').checked,
    defaultPath: state.cfg.commands[i]?.defaultPath || '',
  }));

  // Profiles
  const profRows = document.querySelectorAll('.profile-row');
  state.cfg.profiles = [...profRows].map((row, i) => ({
    id: state.cfg.profiles[i]?.id || crypto.randomUUID(),
    name: row.querySelector('.prof-name')?.value.trim() || state.cfg.profiles[i]?.name || 'Default',
    themeId: row.querySelector('.prof-theme').value,
    accentColor: row.querySelector('.prof-accent').value,
  }));

  state.cfg.defaultPath = document.getElementById('cfg-default-path').value.trim();
  state.cfg.confirmClose = document.getElementById('cfg-confirm-close').checked;
  send({ type: 'config.update', config: state.cfg });
}

// --- Events: Commands ---
document.getElementById('cmd-list').addEventListener('change', saveConfig);
document.getElementById('cmd-list').addEventListener('input', debounce(saveConfig, 500));
document.getElementById('cfg-default-path').addEventListener('input', debounce(saveConfig, 500));
document.getElementById('cfg-confirm-close').addEventListener('change', saveConfig);

document.getElementById('btn-add-cmd').addEventListener('click', () => {
  state.cfg.commands.push({ id: crypto.randomUUID(), label: '', command: '', enabled: true, defaultPath: '' });
  renderCommandList();
  saveConfig();
});

document.getElementById('cmd-list').addEventListener('click', (e) => {
  if (e.target.classList.contains('cmd-del')) {
    const idx = +e.target.closest('.cmd-row').dataset.idx;
    state.cfg.commands.splice(idx, 1);
    renderCommandList();
    saveConfig();
  }
});

// --- Events: Profiles ---
document.getElementById('profile-list').addEventListener('change', saveConfig);
document.getElementById('profile-list').addEventListener('input', debounce(saveConfig, 500));

document.getElementById('btn-add-profile').addEventListener('click', () => {
  const base = state.cfg.profiles.find(p => p.id === state.cfg.defaultProfile) || state.cfg.profiles[0];
  state.cfg.profiles.push({
    id: crypto.randomUUID(),
    name: base ? `${base.name} copy` : 'New Style',
    themeId: base?.themeId || 'default',
    accentColor: base?.accentColor || '#3b82f6',
  });
  renderProfileSection();
  saveConfig();
});

document.getElementById('profile-list').addEventListener('click', (e) => {
  const trigger = e.target.closest('.theme-trigger');
  if (trigger) {
    openThemeMenu(trigger);
    return;
  }
  if (e.target.classList.contains('prof-default')) {
    saveConfig(); // persist any pending edits first
    const idx = +e.target.closest('.profile-row').dataset.idx;
    state.cfg.defaultProfile = state.cfg.profiles[idx].id;
    renderProfileSection();
    saveConfig();
  }
  if (e.target.classList.contains('prof-del')) {
    const idx = +e.target.closest('.profile-row').dataset.idx;
    state.cfg.profiles.splice(idx, 1);
    if (!state.cfg.profiles.find(p => p.id === state.cfg.defaultProfile) && state.cfg.profiles.length) {
      state.cfg.defaultProfile = state.cfg.profiles[0].id;
    }
    renderProfileSection();
    saveConfig();
  }
});

// --- Browse ---
document.getElementById('btn-browse-path').addEventListener('click', () => {
  const current = document.getElementById('cfg-default-path').value.trim();
  openFolderPicker(current, (path) => {
    document.getElementById('cfg-default-path').value = path;
    saveConfig();
  });
});
