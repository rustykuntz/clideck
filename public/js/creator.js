import { state, send } from './state.js';
import { esc, agentIcon, binName } from './utils.js';
import { openFolderPicker } from './folder-picker.js';
import { estimateSize } from './terminals.js';
import { showToast } from './toast.js';

const ADJECTIVES = [
  'Blue', 'Red', 'Green', 'Purple', 'Golden', 'Silver', 'Coral', 'Amber',
  'Mint', 'Crimson', 'Teal', 'Rose', 'Jade', 'Copper', 'Ivory', 'Rusty',
];
const ANIMALS = [
  'Panda', 'Falcon', 'Fox', 'Wolf', 'Owl', 'Tiger', 'Bear', 'Eagle',
  'Dolphin', 'Lynx', 'Hawk', 'Raven', 'Otter', 'Panther', 'Crane', 'Bison',
];
const MRU_KEY = 'termui-last-preset';
const FOLDER_SVG = `<svg class="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z"/></svg>`;

function randomName() {
  const a = ADJECTIVES[Math.random() * ADJECTIVES.length | 0];
  const b = ANIMALS[Math.random() * ANIMALS.length | 0];
  return `${a} ${b}`;
}

function findCommandForPreset(p) {
  return state.cfg.commands.find(c => c.presetId === p.presetId)
    || state.cfg.commands.find(c => binName(c.command) === binName(p.command));
}

// True if preset binary is missing and the configured command is unchanged from the preset default
function isPresetMissing(p) {
  if (p.available !== false) return false;
  const cmd = findCommandForPreset(p);
  if (!cmd || cmd.enabled === false) return true;
  // User changed the command from the preset default — trust it
  return cmd.command === p.command;
}

function renderPresetButtons() {
  return sortedPresets().map(p => {
    const missing = isPresetMissing(p);
    if (missing) {
      return `
      <div class="w-full flex items-center gap-2.5 px-3 py-2 rounded-md text-sm text-left text-slate-500">
        <span class="opacity-40">${agentIcon(p.icon, 24)}</span>
        <span class="flex-1 min-w-0">
          <span>${esc(p.name)}</span>
        </span>
        <button class="install-btn px-2.5 py-1 text-[11px] font-medium text-blue-400 hover:text-blue-300 bg-blue-500/10 hover:bg-blue-500/20 rounded-md transition-colors" data-preset="${p.presetId}">Add</button>
      </div>`;
    }
    return `
      <button class="preset-btn w-full flex items-center gap-2.5 px-3 py-2 rounded-md hover:bg-slate-700/70 text-sm transition-colors text-left text-slate-300" data-preset="${p.presetId}">
        <span>${agentIcon(p.icon, 24)}</span>
        <span class="flex-1 min-w-0">
          <span>${esc(p.name)}</span>
        </span>
      </button>`;
  }).join('');
}

function sortedPresets() {
  const all = [...state.presets].filter(p => {
    if (isPresetMissing(p)) return true;
    const cmd = findCommandForPreset(p);
    return !cmd || cmd.enabled !== false;
  });
  const shell = all.filter(p => !p.isAgent);
  const agents = all.filter(p => p.isAgent);
  const lastId = localStorage.getItem(MRU_KEY);
  if (lastId) {
    const idx = agents.findIndex(p => p.presetId === lastId);
    if (idx > 0) agents.unshift(...agents.splice(idx, 1));
  }
  return [...agents, ...shell];
}

function createFromPreset(preset, sessionName, cwd, projectId, roleId) {
  // Find existing command matching this preset
  let cmd = findCommandForPreset(preset);
  // Auto-create the command if it doesn't exist yet
  if (!cmd) {
    cmd = {
      id: crypto.randomUUID(),
      presetId: preset.presetId,
      label: preset.name,
      icon: preset.icon,
      command: preset.command,
      enabled: true,
      defaultPath: '',
      isAgent: preset.isAgent,
      canResume: preset.canResume,
      resumeCommand: preset.resumeCommand,
      sessionIdPattern: preset.sessionIdPattern,
      outputMarker: preset.outputMarker || null,
      telemetryEnabled: preset.presetId === 'claude-code',
      telemetryStatus: preset.presetId === 'claude-code' ? { ok: true } : null,
      bridge: preset.bridge,
    };
    state.cfg.commands.push(cmd);
    send({ type: 'config.update', config: state.cfg });
  }
  send({ type: 'create', commandId: cmd.id, name: sessionName, cwd, projectId: projectId || undefined, roleId: roleId || undefined, ...estimateSize() });
  localStorage.setItem(MRU_KEY, preset.presetId);
}

export function openCreator() {
  // Toggle off if already open
  if (document.getElementById('session-creator')) {
    closeCreator();
    return;
  }
  // Close project creator if open
  document.getElementById('project-creator')?.remove();
  if (!state.presets.length) return;

  const fallbackName = randomName();
  const presets = sortedPresets();
  const defaultPath = state.cfg.defaultPath || '';

  const card = document.createElement('div');
  card.id = 'session-creator';
  card.className = 'p-3 border-b border-slate-700/50 bg-slate-800/30';
  card.innerHTML = `
    ${(state.cfg.projects?.length) ? `
    <input type="hidden" id="creator-project" value="">
    <button type="button" id="creator-project-trigger" class="w-full px-3 py-1.5 text-xs bg-slate-900 border border-slate-700 rounded-md text-slate-400 text-left flex items-center justify-between outline-none hover:border-slate-500 transition-colors cursor-pointer mb-2">
      <span id="creator-project-label">Select project <span class="opacity-40">- optional</span></span>
      <span class="text-slate-600 ml-2">&#9662;</span>
    </button>` : ''}
    ${(state.cfg.roles?.length) ? `
    <input type="hidden" id="creator-role" value="">
    <button type="button" id="creator-role-trigger" class="w-full px-3 py-1.5 text-xs bg-slate-900 border border-slate-700 rounded-md text-slate-400 text-left flex items-center justify-between outline-none hover:border-slate-500 transition-colors cursor-pointer mb-2">
      <span id="creator-role-label">Select role <span class="opacity-40">- optional</span></span>
      <span class="text-slate-600 ml-2">&#9662;</span>
    </button>` : ''}
    <input id="creator-name" type="text" maxlength="35" placeholder="Session / Agent name"
      class="w-full px-3 py-2 text-sm bg-slate-900 border border-slate-700 rounded-md text-slate-200 placeholder-slate-500 outline-none focus:border-blue-500 transition-colors mb-2">
    <div class="flex items-center gap-1.5 mb-2">
      <input id="creator-cwd" type="text" value="${esc(defaultPath)}" placeholder="Working directory"
        class="flex-1 px-3 py-1.5 text-xs bg-slate-900 border border-slate-700 rounded-md text-slate-400 placeholder-slate-600 outline-none focus:border-blue-500 transition-colors font-mono">
      <button id="creator-browse" class="flex-shrink-0 w-7 h-7 flex items-center justify-center rounded-md border border-slate-700 text-slate-500 hover:text-slate-300 hover:bg-slate-700 transition-colors" title="Browse">
        ${FOLDER_SVG}
      </button>
    </div>
    <div id="creator-presets" class="space-y-0.5">
      ${renderPresetButtons()}
    </div>`;

  const list = document.getElementById('session-list');
  list.parentElement.insertBefore(card, list);

  const nameInput = card.querySelector('#creator-name');
  const cwdInput = card.querySelector('#creator-cwd');
  nameInput.focus();

  nameInput.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') closeCreator();
  });
  cwdInput.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') closeCreator();
  });

  card.querySelector('#creator-browse').addEventListener('click', () => {
    openFolderPicker(cwdInput.value.trim() || defaultPath, (path) => {
      cwdInput.value = path;
    });
  });

  // Project picker dropdown
  const projTrigger = card.querySelector('#creator-project-trigger');
  if (projTrigger) {
    let projMenuCleanup = null;
    projTrigger.addEventListener('click', () => {
      if (projMenuCleanup) { projMenuCleanup(); return; }
      const rect = projTrigger.getBoundingClientRect();
      const hidden = card.querySelector('#creator-project');
      const label = card.querySelector('#creator-project-label');
      const projects = state.cfg.projects || [];

      const menu = document.createElement('div');
      menu.className = 'fixed z-[500] bg-slate-800 border border-slate-600 rounded-lg shadow-xl shadow-black/40 py-1 overflow-y-auto';
      menu.style.maxHeight = '200px';
      menu.style.left = rect.left + 'px';
      menu.style.top = (rect.bottom + 4) + 'px';
      menu.style.width = rect.width + 'px';

      menu.innerHTML = `
        <div class="proj-option px-3 py-1.5 cursor-pointer hover:bg-slate-700 transition-colors text-xs text-slate-400 ${!hidden.value ? 'bg-slate-700/50' : ''}" data-value="">None</div>
        ${projects.map(p => `
          <div class="proj-option flex items-center gap-2 px-3 py-1.5 cursor-pointer hover:bg-slate-700 transition-colors text-xs text-slate-300 ${hidden.value === p.id ? 'bg-slate-700/50' : ''}" data-value="${p.id}">
            <span class="w-2 h-2 rounded-full flex-shrink-0" style="background:${p.color || '#3b82f6'}"></span>
            ${esc(p.name)}
          </div>`).join('')}`;

      document.body.appendChild(menu);

      const onClick = (e) => {
        const item = e.target.closest('.proj-option');
        if (!item) return;
        hidden.value = item.dataset.value;
        const proj = projects.find(p => p.id === item.dataset.value);
        label.innerHTML = proj ? esc(proj.name) : 'Select project <span class="opacity-40">- optional</span>';
        // Auto-set working directory from project path
        if (proj?.path) cwdInput.value = proj.path;
        else cwdInput.value = defaultPath;
        projMenuCleanup();
      };
      const onOutside = (e) => {
        if (!menu.contains(e.target) && !projTrigger.contains(e.target)) projMenuCleanup();
      };
      menu.addEventListener('click', onClick);
      requestAnimationFrame(() => document.addEventListener('click', onOutside));

      projMenuCleanup = () => {
        menu.removeEventListener('click', onClick);
        document.removeEventListener('click', onOutside);
        menu.remove();
        projMenuCleanup = null;
      };
    });
  }

  // Role picker dropdown
  const roleTrigger = card.querySelector('#creator-role-trigger');
  if (roleTrigger) {
    let roleMenuCleanup = null;
    roleTrigger.addEventListener('click', () => {
      if (roleMenuCleanup) { roleMenuCleanup(); return; }
      const rect = roleTrigger.getBoundingClientRect();
      const hidden = card.querySelector('#creator-role');
      const label = card.querySelector('#creator-role-label');
      const roles = state.cfg.roles || [];

      const menu = document.createElement('div');
      menu.className = 'fixed z-[500] bg-slate-800 border border-slate-600 rounded-lg shadow-xl shadow-black/40 py-1 overflow-y-auto';
      menu.style.maxHeight = '200px';
      menu.style.left = rect.left + 'px';
      menu.style.top = (rect.bottom + 4) + 'px';
      menu.style.width = rect.width + 'px';

      menu.innerHTML = `
        <div class="role-option px-3 py-1.5 cursor-pointer hover:bg-slate-700 transition-colors text-xs text-slate-400 ${!hidden.value ? 'bg-slate-700/50' : ''}" data-value="" data-name="">None</div>
        ${roles.map(r => `
          <div class="role-option px-3 py-1.5 cursor-pointer hover:bg-slate-700 transition-colors text-xs text-slate-300 ${hidden.value === r.id ? 'bg-slate-700/50' : ''}" data-value="${r.id}" data-name="${esc(r.name)}">
            ${esc(r.name)}
          </div>`).join('')}`;

      document.body.appendChild(menu);

      const onClick = (e) => {
        const item = e.target.closest('.role-option');
        if (!item) return;
        hidden.value = item.dataset.value;
        const roleName = item.dataset.name;
        label.innerHTML = roleName ? esc(roleName) : 'Select role <span class="opacity-40">- optional</span>';
        // Auto-fill session name from role name (only if user hasn't typed a custom name)
        if (roleName && (!nameInput.value.trim() || nameInput.dataset.autoFilled === '1')) {
          nameInput.value = roleName;
          nameInput.dataset.autoFilled = '1';
        }
        if (!item.dataset.value) nameInput.dataset.autoFilled = '';
        roleMenuCleanup();
      };
      const onOutside = (e) => {
        if (!menu.contains(e.target) && !roleTrigger.contains(e.target)) roleMenuCleanup();
      };
      menu.addEventListener('click', onClick);
      requestAnimationFrame(() => document.addEventListener('click', onOutside));

      roleMenuCleanup = () => {
        menu.removeEventListener('click', onClick);
        document.removeEventListener('click', onOutside);
        menu.remove();
        roleMenuCleanup = null;
      };
    });
    // Clear auto-fill flag when user manually types
    nameInput.addEventListener('input', () => { nameInput.dataset.autoFilled = ''; });
  }

  // "Add" button for missing agents — opens install toaster
  card.addEventListener('click', (e) => {
    const installBtn = e.target.closest('.install-btn');
    if (installBtn) {
      const preset = state.presets.find(p => p.presetId === installBtn.dataset.preset);
      if (preset?.installCmd) showInstallToast(preset);
      return;
    }
    const btn = e.target.closest('.preset-btn');
    if (!btn) return;
    const preset = state.presets.find(p => p.presetId === btn.dataset.preset);
    if (!preset) return;
    const name = nameInput.value.trim() || fallbackName;
    const cwd = cwdInput.value.trim() || undefined;
    const projectSelect = card.querySelector('#creator-project');
    const projectId = projectSelect?.value || undefined;
    const roleSelect = card.querySelector('#creator-role');
    const roleId = roleSelect?.value || undefined;
    createFromPreset(preset, name, cwd, projectId, roleId);
    closeCreator();
  });
}

export function refreshCreator() {
  const container = document.getElementById('creator-presets');
  if (container) container.innerHTML = renderPresetButtons();
}

export function closeCreator() {
  document.getElementById('session-creator')?.remove();
}

function showInstallToast(preset) {
  // Remove existing install toast
  document.getElementById('install-toast')?.remove();

  const toast = document.createElement('div');
  toast.id = 'install-toast';
  toast.className = 'fixed bottom-5 right-5 z-[500] w-[360px] bg-slate-800/95 backdrop-blur-sm border border-slate-700/60 rounded-xl shadow-2xl shadow-black/60';
  toast.style.cssText = 'opacity:0;transform:translateY(12px);transition:opacity 0.3s ease,transform 0.3s ease';

  toast.innerHTML = `
    <div class="flex items-center gap-2.5 px-4 pt-3.5 pb-1">
      ${agentIcon(preset.icon, 20)}
      <span class="text-[13px] font-semibold text-slate-200">Add ${esc(preset.name)}</span>
      <button class="dismiss-btn ml-auto w-6 h-6 flex items-center justify-center rounded-md text-slate-500 hover:text-slate-300 hover:bg-slate-700/50 transition-colors">
        <svg class="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="2"><path d="M18 6L6 18M6 6l12 12"/></svg>
      </button>
    </div>
    <p class="px-4 pt-1 pb-2.5 text-xs text-slate-400 leading-relaxed">This will install ${esc(preset.name)} on your machine using:</p>
    <div class="mx-4 mb-3 px-3 py-2.5 bg-slate-900/70 rounded-lg border border-slate-700/40">
      <pre class="text-[11px] text-emerald-400/80 font-mono leading-relaxed whitespace-pre-wrap">${esc(preset.installCmd)}</pre>
    </div>
    <div class="px-4 pb-3.5 flex items-center gap-2">
      <button class="add-btn flex-1 px-3 py-2 text-xs font-medium bg-blue-600 hover:bg-blue-500 text-white rounded-lg transition-colors">Add Agent</button>
      <button class="dismiss-btn px-3 py-2 text-xs text-slate-500 hover:text-slate-300 transition-colors">Cancel</button>
    </div>`;

  const dismiss = () => {
    toast.style.opacity = '0';
    toast.style.transform = 'translateY(12px)';
    setTimeout(() => toast.remove(), 300);
  };

  toast.querySelectorAll('.dismiss-btn').forEach(b => b.onclick = dismiss);

  toast.querySelector('.add-btn').onclick = () => {
    dismiss();
    closeCreator();
    // Find or create the shell command, then spawn a session running the install
    const shellCmd = state.cfg.commands.find(c => c.presetId === 'shell' || (!c.isAgent && !c.presetId));
    if (!shellCmd) return;
    const installId = crypto.randomUUID();
    send({ type: 'create', commandId: shellCmd.id, name: `Installing ${preset.name}`, installId, ...estimateSize() });
    const handler = (e) => {
      const msg = JSON.parse(e.data);
      if (msg.type !== 'created' || msg.installId !== installId) return;
      cleanup();
      setTimeout(() => send({ type: 'input', id: msg.id, data: preset.installCmd + '\r' }), 300);
    };
    const cleanup = () => { state.ws.removeEventListener('message', handler); clearTimeout(timer); };
    const timer = setTimeout(cleanup, 10000);
    state.ws.addEventListener('message', handler);
  };

  document.body.appendChild(toast);
  requestAnimationFrame(() => { toast.style.opacity = '1'; toast.style.transform = 'translateY(0)'; });
}
