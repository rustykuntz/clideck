import { state, send } from './state.js';
import { esc, agentIcon } from './utils.js';

const ADJECTIVES = [
  'Blue', 'Red', 'Green', 'Purple', 'Golden', 'Silver', 'Coral', 'Amber',
  'Mint', 'Crimson', 'Teal', 'Rose', 'Jade', 'Copper', 'Ivory', 'Rusty',
];
const ANIMALS = [
  'Panda', 'Falcon', 'Fox', 'Wolf', 'Owl', 'Tiger', 'Bear', 'Eagle',
  'Dolphin', 'Lynx', 'Hawk', 'Raven', 'Otter', 'Panther', 'Crane', 'Bison',
];
const MRU_KEY = 'termui-last-preset';

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

function createFromPreset(preset, sessionName) {
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
  send({ type: 'create', commandId: cmd.id, name: sessionName });
  localStorage.setItem(MRU_KEY, preset.presetId);
}

export function openCreator() {
  // Toggle off if already open
  if (document.getElementById('session-creator')) {
    closeCreator();
    return;
  }
  if (!state.presets.length) return;

  const fallbackName = randomName();
  const presets = sortedPresets();

  const card = document.createElement('div');
  card.id = 'session-creator';
  card.className = 'p-3 border-b border-slate-700/50 bg-slate-800/30';
  card.innerHTML = `
    <input id="creator-name" type="text" maxlength="35" placeholder="Session / Agent name"
      class="w-full px-3 py-2 text-sm bg-slate-900 border border-slate-700 rounded-md text-slate-200 placeholder-slate-500 outline-none focus:border-blue-500 transition-colors mb-2">
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
  nameInput.focus();

  nameInput.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') closeCreator();
  });

  card.addEventListener('click', (e) => {
    const btn = e.target.closest('.preset-btn');
    if (!btn) return;
    const preset = state.presets.find(p => p.presetId === btn.dataset.preset);
    if (!preset) return;
    const name = nameInput.value.trim() || fallbackName;
    createFromPreset(preset, name);
    closeCreator();
  });
}

export function closeCreator() {
  document.getElementById('session-creator')?.remove();
}
