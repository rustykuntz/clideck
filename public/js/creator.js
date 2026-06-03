import { state, send } from './state.js';
import { esc, agentIcon, binName } from './utils.js';
import { openFolderPicker } from './folder-picker.js';
import { estimateSize } from './terminals.js';
import { showToast } from './toast.js';
import { confirmClose } from './confirm.js';
import { sessionsInCwd } from './session-collisions.js';

const ADJECTIVES = [
  'Blue', 'Red', 'Green', 'Purple', 'Golden', 'Silver', 'Coral', 'Amber',
  'Mint', 'Crimson', 'Teal', 'Rose', 'Jade', 'Copper', 'Ivory', 'Rusty',
];
const ANIMALS = [
  'Panda', 'Falcon', 'Fox', 'Wolf', 'Owl', 'Tiger', 'Bear', 'Eagle',
  'Dolphin', 'Lynx', 'Hawk', 'Raven', 'Otter', 'Panther', 'Crane', 'Bison',
];
const MRU_KEY = 'termui-last-preset';
const NO_PROJECT_VALUE = '__none__';
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

function telemetryEnabledForPreset(preset, existing) {
  if (preset?.telemetryEnabled === true) return true;
  return !!existing?.telemetryEnabled;
}

// True if preset binary is missing and the configured command is unchanged from the preset default
function isPresetMissing(p) {
  if (p.available !== false) return false;
  const cmd = findCommandForPreset(p);
  if (!cmd || cmd.enabled === false) return true;
  // User changed the command from the preset default — trust it
  return cmd.command === p.command;
}

function isPresetOutdated(p) {
  return p.available !== false && p.versionOk === false;
}

// True if preset binary exists but telemetry/hooks are not configured yet
function isPresetUnpatched(p) {
  if (p.available === false || p.versionOk === false || !p.telemetryAutoSetup) return false;
  const cmd = findCommandForPreset(p);
  return !cmd || !cmd.telemetryStatus?.ok;
}

function renderPresetButtons() {
  return sortedPresets().map(p => {
    if (isPresetMissing(p)) {
      return `
      <div class="w-full flex items-center gap-2.5 px-3 py-2 rounded-md text-sm text-left text-slate-500">
        <span class="opacity-40">${agentIcon(p.icon, 24)}</span>
        <span class="flex-1 min-w-0">${esc(p.name)}</span>
        <button class="install-btn px-2.5 py-1 text-[11px] font-medium text-blue-400 hover:text-blue-300 bg-blue-500/10 hover:bg-blue-500/20 rounded-md transition-colors" data-preset="${p.presetId}">Add</button>
      </div>`;
    }
    if (isPresetOutdated(p)) {
      return `
      <div class="w-full flex items-center gap-2.5 px-3 py-2 rounded-md text-sm text-left text-slate-500">
        <span class="opacity-40">${agentIcon(p.icon, 24)}</span>
        <span class="flex-1 min-w-0">${esc(p.name)}</span>
        <button class="install-btn px-2.5 py-1 text-[11px] font-medium text-rose-400 hover:text-rose-300 bg-rose-500/10 hover:bg-rose-500/20 rounded-md transition-colors" data-preset="${p.presetId}">Update</button>
      </div>`;
    }
    if (isPresetUnpatched(p)) {
      return `
      <div class="w-full flex items-center gap-2.5 px-3 py-2 rounded-md text-sm text-left text-slate-500">
        <span class="opacity-40">${agentIcon(p.icon, 24)}</span>
        <span class="flex-1 min-w-0">${esc(p.name)}</span>
        <button class="setup-btn px-2.5 py-1 text-[11px] font-medium text-amber-400 hover:text-amber-300 bg-amber-500/10 hover:bg-amber-500/20 rounded-md transition-colors" data-preset="${p.presetId}">Setup</button>
      </div>`;
    }
    return `
      <button class="preset-btn w-full flex items-center gap-2.5 px-3 py-2 rounded-md hover:bg-slate-700/70 text-sm transition-colors text-left text-slate-300" data-preset="${p.presetId}">
        <span>${agentIcon(p.icon, 24)}</span>
        <span class="flex-1 min-w-0">${esc(p.name)}</span>
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

async function createFromPreset(preset, sessionName, cwd, projectId) {
  // Warn if a session (active or dormant) is already in this cwd. The
  // user can still proceed — clideck supports multiple terminals per
  // folder — but the prompt makes it deliberate instead of accidental.
  const collisions = cwd ? sessionsInCwd(cwd) : [];
  if (collisions.length) {
    const active = collisions.filter(c => c.kind === 'active').length;
    const dormant = collisions.length - active;
    const bits = [];
    if (active) bits.push(`${active} active`);
    if (dormant) bits.push(`${dormant} previous`);
    const ok = await confirmClose(
      `There ${collisions.length > 1 ? 'are' : 'is'} already ${bits.join(' + ')} session${collisions.length > 1 ? 's' : ''} in this folder. Open another one anyway?`,
      'Open another',
    );
    if (!ok) return false;
  }
  const cmd = ensureCommandForPreset(preset);
  send({ type: 'create', commandId: cmd.id, name: sessionName, cwd, projectId: projectId || undefined, ...estimateSize() });
  localStorage.setItem(MRU_KEY, preset.presetId);
  return true;
}

function ensureCommandForPreset(preset) {
  let cmd = findCommandForPreset(preset);
  if (cmd) return cmd;
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
    telemetryEnabled: telemetryEnabledForPreset(preset),
    telemetryStatus: null,
    bridge: preset.bridge,
  };
  state.cfg.commands.push(cmd);
  send({ type: 'config.update', config: state.cfg });
  return cmd;
}

function ensureShellCommand() {
  const shellPreset = state.presets.find(p => p.presetId === 'shell');
  const command = shellPreset?.command || state.cfg.defaultShell;
  let cmd = state.cfg.commands.find(c => c.presetId === 'shell' || (!c.isAgent && !c.presetId && String(c.label || '').toLowerCase() === 'shell'));
  if (cmd) {
    if (!cmd.command || (cmd.command === '/bin/zsh' && command && command !== '/bin/zsh')) {
      cmd.presetId = 'shell';
      cmd.command = command;
      send({ type: 'config.update', config: state.cfg });
    }
    return cmd;
  }
  if (!command) return null;
  cmd = {
    id: crypto.randomUUID(),
    presetId: 'shell',
    label: 'Shell',
    icon: shellPreset?.icon || 'terminal',
    command,
    enabled: true,
    defaultPath: '',
    isAgent: false,
    canResume: false,
    resumeCommand: null,
    sessionIdPattern: null,
    outputMarker: null,
    telemetryEnabled: false,
    telemetryStatus: null,
  };
  state.cfg.commands.push(cmd);
  send({ type: 'config.update', config: state.cfg });
  return cmd;
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
    <div class="text-[10px] font-semibold uppercase tracking-wider text-slate-500 mb-1.5">Select project</div>
    <input type="hidden" id="creator-project" value="">
    <button type="button" id="creator-project-trigger" class="w-full px-3 py-1.5 text-xs bg-slate-900 border border-slate-700 rounded-md text-slate-400 text-left flex items-center justify-between outline-none hover:border-slate-500 transition-colors cursor-pointer mb-2">
      <span id="creator-project-label">Select project</span>
      <span class="text-slate-600 ml-2">&#9662;</span>
    </button>` : ''}
    <div class="text-[10px] font-semibold uppercase tracking-wider text-slate-500 mb-1.5">Session name</div>
    <input id="creator-name" type="text" maxlength="35" placeholder="Session name"
      class="w-full px-3 py-2 text-sm bg-slate-900 border border-slate-700 rounded-md text-slate-200 placeholder-slate-500 outline-none focus:border-blue-500 transition-colors mb-2">
    <div id="creator-cwd-wrap" class="flex items-center gap-1.5 mb-2 ${(state.cfg.projects?.length) ? 'hidden' : ''}">
      <input id="creator-cwd" type="text" value="${esc(defaultPath)}" placeholder="Working directory"
        class="flex-1 px-3 py-1.5 text-xs bg-slate-900 border border-slate-700 rounded-md text-slate-400 placeholder-slate-600 outline-none focus:border-blue-500 transition-colors font-mono">
      <button id="creator-browse" class="flex-shrink-0 w-7 h-7 flex items-center justify-center rounded-md border border-slate-700 text-slate-500 hover:text-slate-300 hover:bg-slate-700 transition-colors" title="Browse">
        ${FOLDER_SVG}
      </button>
    </div>
    <div class="text-[10px] font-semibold uppercase tracking-wider text-slate-500 mb-1.5">Choose agent provider</div>
    <div id="creator-presets" class="space-y-0.5">
      ${renderPresetButtons()}
    </div>`;

  const list = document.getElementById('session-list');
  list.parentElement.insertBefore(card, list);

  const nameInput = card.querySelector('#creator-name');
  const cwdInput = card.querySelector('#creator-cwd');
  const cwdWrap = card.querySelector('#creator-cwd-wrap');
  const projHidden = card.querySelector('#creator-project');
  const projTrigger = card.querySelector('#creator-project-trigger');
  // Phase 10 Task 5: focus the name input always. Project trigger no longer
  // needs first-touch because the default is None — submitting straight
  // away is the common case.
  nameInput.focus();

  // Phase 10: pre-flight cwd check. Folder-picker selections (and any future
  // drag-folder events) already gave us a path the OS proved exists, so we
  // skip the round-trip in those cases. User-typed paths flip the flag
  // back off via the 'input' listener below so a re-typed override is
  // validated again.
  let cwdCheckedViaPicker = false;
  cwdInput.addEventListener('input', () => { cwdCheckedViaPicker = false; });

  nameInput.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') closeCreator();
  });
  cwdInput.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') closeCreator();
  });

  card.querySelector('#creator-browse').addEventListener('click', () => {
    openFolderPicker(cwdInput.value.trim() || defaultPath, (path) => {
      cwdInput.value = path;
      cwdCheckedViaPicker = true;
    });
  });

  // Helper: one-shot WS response listener with a soft timeout. Mirrors the
  // install-toast handler pattern at creator.js's showInstallToast helper.
  // Returns null on timeout so callers can decide between "block" vs
  // "soft-fall-through". For the pre-flight check we soft-fall-through to
  // 'proceed' because blocking forever on a slow server is worse than
  // letting the existing resolveValidDir silent-fallback handle it.
  function waitForResult(predicate, timeoutMs) {
    return new Promise((resolve) => {
      const onMsg = (e) => {
        try {
          const m = JSON.parse(e.data);
          if (predicate(m)) {
            state.ws.removeEventListener('message', onMsg);
            clearTimeout(t);
            resolve(m);
          }
        } catch { /* ignore non-JSON frames */ }
      };
      const t = setTimeout(() => {
        state.ws.removeEventListener('message', onMsg);
        resolve(null);
      }, timeoutMs);
      state.ws.addEventListener('message', onMsg);
    });
  }

  // The pre-flight check. Returns 'proceed' (continue with createFromPreset)
  // or 'cancel' (abort; modal-induced focus already wired). Encapsulates
  // SPEC AC 1-7.
  async function ensureCwdExistsOrConfirm(cwd) {
    if (!cwd || !cwd.trim()) return 'proceed';                   // AC 7
    if (cwdCheckedViaPicker) return 'proceed';                   // AC 6
    const focusCwd = () => {
      cwdInput.focus();
      cwdInput.setSelectionRange(0, cwdInput.value.length);
    };
    send({ type: 'check-cwd', path: cwd });
    const r = await waitForResult(
      (m) => m.type === 'check-cwd-result' && m.path === cwd,
      5000,
    );
    if (!r) return 'proceed';                                    // soft timeout
    if (r.exists && r.isDirectory) return 'proceed';
    if (r.exists && !r.isDirectory) {                            // AC 4
      await confirmClose(
        "A file already exists at that path — pick a different folder.",
        '',
        { hideConfirm: true, cancelLabel: 'OK' },
      );
      focusCwd();
      return 'cancel';
    }
    if (r.error === 'EACCES' || r.error === 'EPERM') {           // AC 5
      await confirmClose(
        'Permission denied for that path. Try a different folder.',
        '',
        { hideConfirm: true, cancelLabel: 'OK' },
      );
      focusCwd();
      return 'cancel';
    }
    // Not-exists branch (AC 1 + 2 + 3).
    const ok = await confirmClose(
      "That folder doesn't exist yet. Create it and open the session there?",
      'Create and open',
    );
    if (!ok) {                                                    // AC 3
      focusCwd();
      return 'cancel';
    }
    send({ type: 'mkdir-cwd', path: cwd });
    const m = await waitForResult(
      (msg) => msg.type === 'mkdir-cwd-result' && msg.path === cwd,
      5000,
    );
    if (m && m.ok) return 'proceed';                              // AC 2
    // R2: mkdir failed — surface a second one-button error modal and
    // explicitly do NOT call createFromPreset.
    await confirmClose(
      "Couldn't create that folder: " + ((m && m.error) || 'unknown error'),
      '',
      { hideConfirm: true, cancelLabel: 'OK' },
    );
    focusCwd();
    return 'cancel';
  }

  // Project picker dropdown
  if (projTrigger) {
    const projects = [...(state.cfg.projects || [])].sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: 'base' }));
    const projLabel = card.querySelector('#creator-project-label');
    const setProjectSelection = (value) => {
      projHidden.value = value;
      const proj = projects.find(p => p.id === value);
      if (proj) {
        projLabel.textContent = proj.name;
        cwdWrap.classList.add('hidden');
        cwdInput.value = proj.path || defaultPath;
        return;
      }
      if (value === NO_PROJECT_VALUE) {
        projLabel.textContent = 'None (outside project hierarchy)';
        cwdWrap.classList.remove('hidden');
        cwdInput.value = cwdInput.value.trim() || defaultPath;
        return;
      }
      projLabel.textContent = 'Select project';
      cwdWrap.classList.add('hidden');
      cwdInput.value = defaultPath;
    };

    // Phase 10 Task 5 (AC 9, 10): pre-seed projHidden.value to None at
    // creator-card open so submitting without touching the dropdown
    // creates an ungrouped session. setProjectSelection(NO_PROJECT_VALUE)
    // also runs cwdWrap.classList.remove('hidden') so the cwd input is
    // visible at first render. The user can still switch to a real
    // project via the dropdown — and switch back to None — at will.
    setProjectSelection(NO_PROJECT_VALUE);

    let projMenuCleanup = null;
    projTrigger.addEventListener('click', () => {
      if (projMenuCleanup) { projMenuCleanup(); return; }
      const rect = projTrigger.getBoundingClientRect();

      const menu = document.createElement('div');
      menu.className = 'fixed z-[500] bg-slate-800 border border-slate-600 rounded-lg shadow-xl shadow-black/40 py-1 overflow-y-auto';
      menu.style.maxHeight = '200px';
      menu.style.left = rect.left + 'px';
      menu.style.top = (rect.bottom + 4) + 'px';
      menu.style.width = rect.width + 'px';

      menu.innerHTML = `
        <div class="proj-option px-3 py-1.5 cursor-pointer hover:bg-slate-700 transition-colors text-xs text-slate-400 ${projHidden.value === NO_PROJECT_VALUE ? 'bg-slate-700/50' : ''}" data-value="${NO_PROJECT_VALUE}">None (outside project hierarchy)</div>
        ${projects.map(p => `
          <div class="proj-option flex items-center gap-2 px-3 py-1.5 cursor-pointer hover:bg-slate-700 transition-colors text-xs text-slate-300 ${projHidden.value === p.id ? 'bg-slate-700/50' : ''}" data-value="${p.id}">
            <span class="w-2 h-2 rounded-full flex-shrink-0" style="background:${p.color || '#3b82f6'}"></span>
            ${esc(p.name)}
          </div>`).join('')}`;

      document.body.appendChild(menu);

      const onClick = (e) => {
        const item = e.target.closest('.proj-option');
        if (!item) return;
        setProjectSelection(item.dataset.value);
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

  // "Add" button for missing agents — opens install toaster
  card.addEventListener('click', async (e) => {
    const installBtn = e.target.closest('.install-btn');
    if (installBtn) {
      const preset = state.presets.find(p => p.presetId === installBtn.dataset.preset);
      if (preset?.installCmd) showInstallToast(preset);
      return;
    }
    const setupBtn = e.target.closest('.setup-btn');
    if (setupBtn) {
      const preset = state.presets.find(p => p.presetId === setupBtn.dataset.preset);
      if (!preset) return;
      const cmd = ensureCommandForPreset(preset);
      document.dispatchEvent(new CustomEvent('clideck:setup', { detail: { commandId: cmd.id } }));
      return;
    }
    const btn = e.target.closest('.preset-btn');
    if (!btn) return;
    const preset = state.presets.find(p => p.presetId === btn.dataset.preset);
    if (!preset) return;
    // Phase 10 Task 5: the old `if (projTrigger && !projHidden.value)` toast
    // guard is now dead code — projHidden is pre-seeded to NO_PROJECT_VALUE
    // when the picker is rendered, so the !projHidden.value branch can
    // never fire (AC 10). The dropdown still lets users pick a real project
    // and switch back to None via setProjectSelection.
    const name = nameInput.value.trim() || fallbackName;
    const cwd = cwdInput.value.trim() || undefined;
    const projectId = projHidden?.value && projHidden.value !== NO_PROJECT_VALUE ? projHidden.value : undefined;
    const decision = await ensureCwdExistsOrConfirm(cwd);
    if (decision !== 'proceed') return;
    const ok = await createFromPreset(preset, name, cwd, projectId);
    if (ok) closeCreator();
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
    ensureCommandForPreset(preset);
    if (preset.telemetryAutoSetup) {
      setTimeout(() => send({ type: 'telemetry.autosetup', presetId: preset.presetId }), 1000);
    }
    // Find or create the shell command, then spawn a session running the install
    const shellCmd = ensureShellCommand();
    if (!shellCmd) {
      showToast('Could not find a shell command to run the installer.', { type: 'error', title: 'Install Failed' });
      return;
    }
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
