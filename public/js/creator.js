import { state, send } from './state.js';
import { esc, agentIcon } from './utils.js';
import { openFolderPicker } from './folder-picker.js';
import { estimateSize } from './terminals.js';

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

function sortedPresets() {
  const all = [...state.presets];
  const shell = all.filter(p => !p.isAgent);
  const agents = all.filter(p => p.isAgent);
  const lastId = localStorage.getItem(MRU_KEY);
  if (lastId) {
    const idx = agents.findIndex(p => p.presetId === lastId);
    if (idx > 0) agents.unshift(...agents.splice(idx, 1));
  }
  return [...agents, ...shell];
}

function createFromPreset(preset, sessionName, cwd, projectId) {
  // Find existing command matching this preset
  let cmd = state.cfg.commands.find(c =>
    c.command.split('/').pop().split(' ')[0] === preset.command
  );
  // Auto-create the command if it doesn't exist yet
  if (!cmd) {
    cmd = {
      id: crypto.randomUUID(),
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
    };
    state.cfg.commands.push(cmd);
    send({ type: 'config.update', config: state.cfg });
  }
  send({ type: 'create', commandId: cmd.id, name: sessionName, cwd, projectId: projectId || undefined, ...estimateSize() });
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
      <span id="creator-project-label">No project</span>
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
    <div class="space-y-0.5">
      ${presets.map(p => `
        <button class="preset-btn w-full flex items-center gap-2.5 px-3 py-2 rounded-md hover:bg-slate-700/70 text-sm text-slate-300 transition-colors text-left" data-preset="${p.presetId}">
          ${agentIcon(p.icon, 24)}
          <span>${esc(p.name)}</span>
        </button>`).join('')}
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
        <div class="proj-option px-3 py-1.5 cursor-pointer hover:bg-slate-700 transition-colors text-xs text-slate-400 ${!hidden.value ? 'bg-slate-700/50' : ''}" data-value="">No project</div>
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
        label.textContent = proj ? proj.name : 'No project';
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

  card.addEventListener('click', (e) => {
    const btn = e.target.closest('.preset-btn');
    if (!btn) return;
    const preset = state.presets.find(p => p.presetId === btn.dataset.preset);
    if (!preset) return;
    const name = nameInput.value.trim() || fallbackName;
    const cwd = cwdInput.value.trim() || undefined;
    const projectSelect = card.querySelector('#creator-project');
    const projectId = projectSelect?.value || undefined;
    createFromPreset(preset, name, cwd, projectId);
    closeCreator();
  });
}

export function closeCreator() {
  document.getElementById('session-creator')?.remove();
}
