import { state, send } from './state.js';
import { esc, debounce, agentIcon, binName } from './utils.js';
import { openFolderPicker } from './folder-picker.js';

// ── Category navigation ──

function switchCategory(catId) {
  document.querySelectorAll('.settings-cat').forEach(btn => {
    const match = btn.dataset.cat === catId;
    btn.classList.toggle('text-slate-200', match);
    btn.classList.toggle('bg-slate-800/60', match);
    btn.classList.toggle('active-cat', match);
    btn.classList.toggle('text-slate-500', !match);
    btn.classList.toggle('hover:text-slate-300', !match);
    btn.classList.toggle('hover:bg-slate-800/30', !match);
  });
  document.querySelectorAll('.settings-panel').forEach(p => p.classList.add('hidden'));
  const panel = document.getElementById(`settings-${catId}`);
  if (panel) panel.classList.remove('hidden');
}

document.getElementById('settings-nav').addEventListener('click', (e) => {
  const btn = e.target.closest('.settings-cat');
  if (btn) switchCategory(btn.dataset.cat);
});

// ── Render all ──

export function renderSettings() {
  document.getElementById('cfg-default-path').value = state.cfg.defaultPath || '';
  document.getElementById('cfg-confirm-close').checked = state.cfg.confirmClose !== false;
  renderAgentList();
  renderThemeSection();
  renderNotifications();
}

// ── CLI Agents ──

// ── Icon picker ──

let iconPickerCleanup = null;

function closeIconPicker() {
  if (iconPickerCleanup) iconPickerCleanup();
}

function getAllIcons() {
  const icons = [{ value: 'terminal', label: 'Terminal' }];
  for (const p of (state.presets || [])) {
    if (p.icon && p.icon !== 'terminal' && !icons.find(i => i.value === p.icon)) {
      icons.push({ value: p.icon, label: p.name });
    }
  }
  return icons;
}

function openIconPicker(triggerEl, cardIdx) {
  closeIconPicker();
  const rect = triggerEl.getBoundingClientRect();
  const menu = document.createElement('div');
  menu.className = 'fixed z-[500] bg-slate-800 border border-slate-600 rounded-lg shadow-xl shadow-black/40 p-2 flex gap-2';
  menu.style.top = (rect.bottom + 4) + 'px';
  menu.style.left = rect.left + 'px';

  const icons = getAllIcons();
  menu.innerHTML = icons.map(ic =>
    `<div class="icon-pick cursor-pointer rounded-lg p-1.5 hover:bg-slate-700 transition-colors" data-icon="${esc(ic.value)}" title="${esc(ic.label)}">
      ${agentIcon(ic.value)}
    </div>`
  ).join('');

  document.body.appendChild(menu);

  const onClick = (e) => {
    const item = e.target.closest('.icon-pick');
    if (item) {
      state.cfg.commands[cardIdx].icon = item.dataset.icon;
      renderAgentList();
      saveConfig();
    }
    closeIconPicker();
  };
  const onOutside = (e) => {
    if (!menu.contains(e.target) && !triggerEl.contains(e.target)) closeIconPicker();
  };
  menu.addEventListener('click', onClick);
  requestAnimationFrame(() => document.addEventListener('click', onOutside));

  iconPickerCleanup = () => {
    menu.removeEventListener('click', onClick);
    document.removeEventListener('click', onOutside);
    menu.remove();
    iconPickerCleanup = null;
  };
}

function telemetryPreset(cmd) {
  const bin = binName(cmd.command);
  return (state.presets || []).find(p => binName(p.command) === bin);
}

function telemetrySection(c) {
  const preset = telemetryPreset(c);
  if (!preset?.telemetryEnv) return '';
  const isClaude = preset.presetId === 'claude-code';
  const enabled = isClaude || !!c.telemetryEnabled;
  const disabled = isClaude ? 'disabled' : '';
  const dimmed = !enabled ? 'opacity-40' : '';
  const configPath = preset.telemetryConfigPath || '';
  const status = c.telemetryStatus;
  let statusHtml;
  if (!enabled || !status) {
    statusHtml = '<span class="text-slate-500">Not configured</span>';
  } else if (status.ok) {
    statusHtml = '<span class="text-emerald-400">Successful &#10003;</span>';
  } else {
    statusHtml = `<span class="text-red-400">Failed: ${esc(status.error || 'unknown')}</span>`;
  }

  return `
    <div class="mt-3 pt-3 border-t border-slate-700/50">
      <label class="flex items-center gap-2 text-sm text-slate-300 ${isClaude ? '' : 'cursor-pointer'} select-none">
        <input type="checkbox" ${enabled ? 'checked' : ''} ${disabled} class="agent-telemetry-toggle accent-blue-500" data-preset="${esc(preset.presetId)}">
        Add telemetry support
        ${isClaude ? '<span class="text-xs text-slate-500">(built-in)</span>' : ''}
      </label>
      <div class="mt-2 space-y-1 text-xs ${dimmed}">
        <div class="flex items-center gap-2">
          <span class="text-slate-500">Config file:</span>
          <span class="text-slate-400 font-mono">${esc(configPath)}</span>
        </div>
        <div class="flex items-center gap-2">
          <span class="text-slate-500">Status:</span>
          ${statusHtml}
        </div>
      </div>
    </div>`;
}

function renderAgentList() {
  document.getElementById('agent-list').innerHTML = state.cfg.commands.map((c, i) => {
    const isBuiltIn = !!telemetryPreset(c);
    return `
    <div class="agent-card p-4 bg-slate-800/50 border border-slate-700/50 rounded-lg" data-idx="${i}">
      <div class="flex items-center gap-3 mb-3">
        <div class="agent-icon-btn cursor-pointer rounded-lg hover:ring-2 hover:ring-slate-500 transition-shadow" title="Change icon">
          ${agentIcon(c.icon)}
        </div>
        <input type="text" value="${esc(c.label)}" class="agent-name flex-1 px-2 py-1.5 text-sm bg-slate-900 border border-slate-700 rounded text-slate-200 placeholder-slate-500 outline-none focus:border-blue-500 transition-colors" placeholder="Agent name">
        <label class="flex items-center gap-1.5 text-xs text-slate-400 cursor-pointer select-none" title="Enabled">
          <input type="checkbox" ${c.enabled ? 'checked' : ''} class="agent-enabled accent-blue-500">
          On
        </label>
        ${isBuiltIn ? '' : '<button class="agent-del text-slate-500 hover:text-red-400 px-1 text-lg transition-colors" title="Remove">&times;</button>'}
      </div>
      <div class="mb-3">
        <label class="block text-xs text-slate-500 mb-1">Command</label>
        <input type="text" value="${esc(c.command)}" class="agent-command w-full px-2 py-1.5 text-sm bg-slate-900 border border-slate-700 rounded text-slate-200 placeholder-slate-500 outline-none focus:border-blue-500 transition-colors font-mono" placeholder="e.g. claude, codex, gemini">
      </div>
      <div class="mb-3">
        <label class="flex items-center gap-2 text-sm text-slate-300 cursor-pointer select-none">
          <input type="checkbox" ${c.isAgent ? 'checked' : ''} class="agent-is-agent accent-blue-500">
          AI Agent
          <span class="text-xs text-slate-500">(enables resume support)</span>
        </label>
      </div>
      <div class="agent-resume-section ${c.isAgent ? '' : 'hidden'} pl-4 border-l-2 border-slate-700 space-y-3">
        <label class="flex items-center gap-2 text-sm text-slate-300 cursor-pointer select-none">
          <input type="checkbox" ${c.canResume ? 'checked' : ''} class="agent-can-resume accent-blue-500">
          Supports session resume
        </label>
        <div class="agent-resume-fields ${c.canResume ? '' : 'hidden'} space-y-2">
          <div>
            <label class="block text-xs text-slate-500 mb-1">Resume command <span class="text-slate-600">— use {{sessionId}} as placeholder</span></label>
            <input type="text" value="${esc(c.resumeCommand || '')}" class="agent-resume-cmd w-full px-2 py-1.5 text-sm bg-slate-900 border border-slate-700 rounded text-slate-200 placeholder-slate-500 outline-none focus:border-blue-500 transition-colors font-mono" placeholder="e.g. claude --resume {{sessionId}}">
          </div>
        </div>
        ${telemetrySection(c)}
      </div>
    </div>`;
  }).join('');
}

// ── Add Agent (preset picker) ──

let presetMenuCleanup = null;

function closePresetMenu() {
  if (presetMenuCleanup) presetMenuCleanup();
}

function openPresetMenu(anchorEl) {
  closePresetMenu();
  const rect = anchorEl.getBoundingClientRect();
  const menu = document.createElement('div');
  menu.className = 'fixed z-[500] min-w-[220px] bg-slate-800 border border-slate-600 rounded-lg shadow-xl shadow-black/40 py-1';
  menu.style.top = (rect.bottom + 4) + 'px';
  menu.style.right = (window.innerWidth - rect.right) + 'px';

  const presets = state.presets || [];
  menu.innerHTML = presets.map(p => `
    <div class="preset-item flex items-center gap-2.5 px-3 py-2 cursor-pointer hover:bg-slate-700 transition-colors text-sm" data-preset="${p.presetId}">
      ${agentIcon(p.icon)}
      <span class="text-slate-200">${esc(p.name)}</span>
    </div>
  `).join('') + `
    <div class="border-t border-slate-700 my-1"></div>
    <div class="preset-item flex items-center gap-2.5 px-3 py-2 cursor-pointer hover:bg-slate-700 transition-colors text-sm" data-preset="custom">
      <div class="w-8 h-8 rounded bg-slate-700 flex items-center justify-center text-slate-400 text-lg">+</div>
      <span class="text-slate-200">Custom</span>
    </div>
  `;

  document.body.appendChild(menu);

  const onClick = (e) => {
    const item = e.target.closest('.preset-item');
    if (!item) return;
    const presetId = item.dataset.preset;
    if (presetId === 'custom') {
      state.cfg.commands.push({
        id: crypto.randomUUID(), label: '', icon: 'terminal', command: '',
        enabled: true, defaultPath: '', isAgent: false, canResume: false,
        resumeCommand: null, sessionIdPattern: null,
      });
    } else {
      const p = presets.find(x => x.presetId === presetId);
      if (p) state.cfg.commands.push({
        id: crypto.randomUUID(), label: p.name, icon: p.icon, command: p.command,
        enabled: true, defaultPath: '', isAgent: p.isAgent, canResume: p.canResume,
        resumeCommand: p.resumeCommand, sessionIdPattern: p.sessionIdPattern,
      });
    }
    renderAgentList();
    saveConfig();
    closePresetMenu();
  };
  const onOutside = (e) => {
    if (!menu.contains(e.target) && !anchorEl.contains(e.target)) closePresetMenu();
  };
  menu.addEventListener('click', onClick);
  requestAnimationFrame(() => document.addEventListener('click', onOutside));

  presetMenuCleanup = () => {
    menu.removeEventListener('click', onClick);
    document.removeEventListener('click', onOutside);
    menu.remove();
    presetMenuCleanup = null;
  };
}

document.getElementById('btn-add-agent').addEventListener('click', (e) => openPresetMenu(e.currentTarget));

// ── Agent list events ──

const agentList = document.getElementById('agent-list');

agentList.addEventListener('click', (e) => {
  const iconBtn = e.target.closest('.agent-icon-btn');
  if (iconBtn) {
    const idx = +iconBtn.closest('.agent-card').dataset.idx;
    openIconPicker(iconBtn, idx);
    return;
  }
  if (e.target.classList.contains('agent-del')) {
    const idx = +e.target.closest('.agent-card').dataset.idx;
    state.cfg.commands.splice(idx, 1);
    renderAgentList();
    saveConfig();
  }
});

agentList.addEventListener('change', (e) => {
  if (e.target.classList.contains('agent-is-agent')) {
    const card = e.target.closest('.agent-card');
    card.querySelector('.agent-resume-section').classList.toggle('hidden', !e.target.checked);
  }
  if (e.target.classList.contains('agent-can-resume')) {
    const card = e.target.closest('.agent-card');
    card.querySelector('.agent-resume-fields').classList.toggle('hidden', !e.target.checked);
  }
  if (e.target.classList.contains('agent-telemetry-toggle')) {
    const presetId = e.target.dataset.preset;
    send({ type: 'telemetry.configure', presetId, enable: e.target.checked });
    return; // config broadcast from server will re-render
  }
  saveConfig();
});

agentList.addEventListener('input', debounce(saveConfig, 500));

// ── Appearance (theme picker) ──

function themePreviewHTML(themeId) {
  const t = state.themes.find(th => th.id === themeId)?.theme;
  if (!t) return '';
  const s = (color, text) => `<span style="color:${color}">${esc(text)}</span>`;
  const lines = [
    `${s(t.green, '~')} ${s(t.blue, 'project')} ${s(t.foreground, '$ ')}${s(t.foreground, 'claude')}`,
    `${s(t.brightBlack, '● Editing src/app.ts')}`,
    `${s(t.cyan, 'function')} ${s(t.yellow, 'greet')}${s(t.foreground, '(name: ')}${s(t.green, 'string')}${s(t.foreground, ') {')}`,
    `${s(t.foreground, '  return ')}${s(t.green, '"Hello, ${name}"')}`,
    `${s(t.foreground, '}')}`,
    `${s(t.green, '~')} ${s(t.blue, 'project')} ${s(t.foreground, '$ ')}${s(t.brightBlack, '▊')}`,
  ];
  return `<div style="background:${t.background};padding:6px 8px">${lines.join('\n')}</div>`;
}

let themeMenuCleanup = null;

export function closeThemeMenu() {
  if (themeMenuCleanup) themeMenuCleanup();
}

function openThemeMenu(triggerEl) {
  closeThemeMenu();
  const hidden = document.getElementById('cfg-default-theme');

  const rect = triggerEl.getBoundingClientRect();
  const maxH = 400, gap = 4;
  const spaceBelow = window.innerHeight - rect.bottom - gap;
  const spaceAbove = rect.top - gap;
  const openAbove = spaceBelow < maxH && spaceAbove > spaceBelow;
  const menuH = Math.min(maxH, openAbove ? spaceAbove : spaceBelow);

  const menu = document.createElement('div');
  menu.className = 'fixed z-[500] min-w-[260px] bg-slate-800 border border-slate-600 rounded-lg shadow-xl shadow-black/40 py-1 overflow-y-auto';
  menu.style.maxHeight = menuH + 'px';
  menu.style.left = rect.left + 'px';
  if (openAbove) menu.style.bottom = (window.innerHeight - rect.top + gap) + 'px';
  else menu.style.top = (rect.bottom + gap) + 'px';

  menu.innerHTML = state.themes.map(t => {
    return `<div class="theme-option px-3 py-2 cursor-pointer hover:bg-slate-700 transition-colors ${t.id === hidden.value ? 'bg-blue-500/15 border-l-2 border-blue-400' : ''}" data-value="${t.id}">
      <div class="text-sm text-slate-200 mb-1">${esc(t.name)}</div>
      <div class="text-[10px] font-mono leading-[1.4] whitespace-pre rounded overflow-hidden" style="background:${t.theme.background};padding:4px 6px"><span style="color:${t.theme.green}">~</span> <span style="color:${t.theme.blue}">src</span> <span style="color:${t.theme.foreground}">$ ls</span>\n<span style="color:${t.theme.yellow}">app.ts</span>  <span style="color:${t.theme.cyan}">utils.ts</span>  <span style="color:${t.theme.brightBlack}">README</span></div>
    </div>`;
  }).join('');

  document.body.appendChild(menu);

  const onClick = (e) => {
    const item = e.target.closest('.theme-option');
    if (item) {
      hidden.value = item.dataset.value;
      triggerEl.querySelector('.theme-label').textContent = state.themes.find(t => t.id === item.dataset.value)?.name || 'Default';
      document.getElementById('default-theme-preview').innerHTML = themePreviewHTML(item.dataset.value);
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

function renderThemeSection() {
  const themeId = state.cfg.defaultTheme || 'default';
  const selected = state.themes.find(t => t.id === themeId);
  const label = selected ? esc(selected.name) : 'Default';
  document.getElementById('cfg-default-theme').value = themeId;
  document.getElementById('default-theme-label').textContent = label;
  document.getElementById('default-theme-preview').innerHTML = themePreviewHTML(themeId);
}

// ── Notifications ──

function renderNotifications() {
  const enabled = !!state.cfg.notifyIdle;
  document.getElementById('cfg-notify-idle').checked = enabled;
  document.getElementById('cfg-notify-min-work').value = state.cfg.notifyMinWork || 10;

  const permRow = document.getElementById('notify-permission-row');
  const permStatus = document.getElementById('notify-permission-status');
  permRow.classList.toggle('hidden', !enabled);

  if (enabled && 'Notification' in window) {
    const perm = Notification.permission;
    if (perm === 'granted') {
      permStatus.textContent = 'Notifications are enabled';
      permStatus.className = 'text-xs text-emerald-500 mt-1.5';
    } else if (perm === 'denied') {
      permStatus.textContent = 'Notifications blocked — check browser settings';
      permStatus.className = 'text-xs text-red-400 mt-1.5';
    } else {
      permStatus.textContent = '';
    }
  }

  const soundEnabled = state.cfg.notifySoundEnabled !== false;
  document.getElementById('cfg-notify-sound').checked = soundEnabled;
  document.getElementById('notify-sound-row').classList.toggle('hidden', !soundEnabled);
  document.getElementById('cfg-notify-sound-pick').value = state.cfg.notifySound || 'default-beep';
}

document.getElementById('cfg-notify-idle').addEventListener('change', (e) => {
  const enabled = e.target.checked;
  document.getElementById('notify-permission-row').classList.toggle('hidden', !enabled);
  if (enabled && 'Notification' in window && Notification.permission === 'default') {
    Notification.requestPermission().then(() => renderNotifications());
  }
  saveConfig();
});

document.getElementById('cfg-notify-min-work').addEventListener('change', saveConfig);

document.getElementById('btn-notify-permission').addEventListener('click', () => {
  if ('Notification' in window) {
    Notification.requestPermission().then(() => renderNotifications());
  }
});

document.getElementById('cfg-notify-sound').addEventListener('change', (e) => {
  document.getElementById('notify-sound-row').classList.toggle('hidden', !e.target.checked);
  saveConfig();
});

document.getElementById('cfg-notify-sound-pick').addEventListener('change', saveConfig);

document.getElementById('btn-sound-preview').addEventListener('click', () => {
  const sound = document.getElementById('cfg-notify-sound-pick').value;
  new Audio(`/fx/${sound}.mp3`).play().catch(() => {});
});

// ── Save ──

function saveConfig() {
  // Agents
  const agentCards = document.querySelectorAll('.agent-card');
  state.cfg.commands = [...agentCards].map((card, i) => {
    const existing = state.cfg.commands[i] || {};
    return {
      id: existing.id || crypto.randomUUID(),
      label: card.querySelector('.agent-name').value.trim() || 'Untitled',
      icon: existing.icon || 'terminal',
      command: card.querySelector('.agent-command').value.trim() || state.cfg.defaultShell || '/bin/zsh',
      enabled: card.querySelector('.agent-enabled').checked,
      defaultPath: existing.defaultPath || '',
      isAgent: card.querySelector('.agent-is-agent').checked,
      canResume: card.querySelector('.agent-can-resume').checked,
      resumeCommand: card.querySelector('.agent-resume-cmd')?.value.trim() || null,
      sessionIdPattern: existing.sessionIdPattern || null,
      outputMarker: existing.outputMarker || null,
      telemetryEnabled: existing.telemetryEnabled || false,
      telemetryStatus: existing.telemetryStatus || null,
      bridge: existing.bridge,
    };
  });

  state.cfg.defaultTheme = document.getElementById('cfg-default-theme').value;
  state.cfg.defaultPath = document.getElementById('cfg-default-path').value.trim();
  state.cfg.confirmClose = document.getElementById('cfg-confirm-close').checked;
  state.cfg.notifyIdle = document.getElementById('cfg-notify-idle').checked;
  state.cfg.notifyMinWork = parseInt(document.getElementById('cfg-notify-min-work').value, 10) || 10;
  state.cfg.notifySoundEnabled = document.getElementById('cfg-notify-sound').checked;
  state.cfg.notifySound = document.getElementById('cfg-notify-sound-pick').value;
  // Preserve fields not managed by this form
  // (projects, prompts, etc. live on state.cfg and must not be dropped)
  send({ type: 'config.update', config: state.cfg });
}

// ── Events: General ──
document.getElementById('cfg-default-path').addEventListener('input', debounce(saveConfig, 500));
document.getElementById('cfg-confirm-close').addEventListener('change', saveConfig);
// ── Events: Appearance ──
document.getElementById('default-theme-trigger').addEventListener('click', (e) => {
  openThemeMenu(e.currentTarget);
});

// ── Browse ──
document.getElementById('btn-browse-path').addEventListener('click', () => {
  const current = document.getElementById('cfg-default-path').value.trim();
  openFolderPicker(current, (path) => {
    document.getElementById('cfg-default-path').value = path;
    saveConfig();
  });
});
