// Roles panel — manage worker role definitions (core feature, not plugin-specific)
import { state, send } from './state.js';
import { esc } from './utils.js';

const panel = document.getElementById('panel-roles');

function getRoles() { return state.cfg.roles || []; }

function save() { send({ type: 'config.update', config: state.cfg }); }

export function renderRoles() {
  const roles = getRoles();
  panel.innerHTML = `
    <div class="flex items-center justify-between px-3 pt-3 pb-2">
      <span class="text-sm font-bold text-slate-200 tracking-tight" style="font-family:'JetBrains Mono',monospace">Roles</span>
      <button id="btn-add-role" class="icon-btn w-7 h-7 flex items-center justify-center rounded-md border border-slate-600 text-slate-400 hover:bg-slate-700 hover:text-slate-200 transition-colors text-sm" title="New role">+</button>
    </div>
    <div id="roles-list" class="tmx-scroll flex-1 overflow-y-auto border-t border-slate-700/50"></div>`;

  panel.querySelector('#btn-add-role').addEventListener('click', () => openEditor());

  const list = panel.querySelector('#roles-list');
  list.addEventListener('click', (e) => {
    if (e.target.closest('.role-edit')) {
      const idx = +e.target.closest('.role-row').dataset.idx;
      openEditor(idx);
      return;
    }
    if (e.target.closest('.role-del')) {
      const idx = +e.target.closest('.role-row').dataset.idx;
      state.cfg.roles.splice(idx, 1);
      save();
      renderRoles();
      return;
    }
  });

  renderRoleList(roles);
}

function renderRoleList(roles) {
  const list = panel.querySelector('#roles-list');
  if (!roles.length) {
    list.innerHTML = `<div class="flex flex-col items-center justify-center h-full px-6 text-center">
      <p class="text-sm text-slate-400 mb-1">No roles defined</p>
      <p class="text-xs text-slate-600 leading-relaxed">Define agent identities with a name and instructions.<br>Roles are sent to the agent when a session starts<br>and can be used by plugins like Autopilot.</p>
    </div>`;
    return;
  }
  list.innerHTML = roles.map((r, idx) => `
    <div class="role-row group flex items-start gap-2 px-3 py-2.5 cursor-default hover:bg-slate-800/40 transition-colors ${idx > 0 ? 'border-t border-slate-700/30' : ''}" data-idx="${idx}">
      <div class="flex-1 min-w-0">
        <div class="text-[13px] font-medium text-slate-200 truncate">${esc(r.name)}</div>
        <div class="text-[11px] text-slate-500 mt-0.5 line-clamp-2 leading-relaxed">${esc(r.instructions)}</div>
      </div>
      <div class="flex items-center gap-0.5 opacity-0 group-hover:opacity-100 transition-opacity flex-shrink-0 mt-0.5">
        <button class="role-edit w-6 h-6 flex items-center justify-center rounded text-slate-500 hover:text-slate-300 hover:bg-slate-700/60 transition-colors" title="Edit">
          <svg class="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="1.5"><path d="M17 3a2.85 2.85 0 1 1 4 4L7.5 20.5 2 22l1.5-5.5Z"/></svg>
        </button>
        <button class="role-del w-6 h-6 flex items-center justify-center rounded text-slate-500 hover:text-red-400 hover:bg-slate-700/60 transition-colors" title="Delete">
          <svg class="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="1.5"><path d="M18 6L6 18M6 6l12 12"/></svg>
        </button>
      </div>
    </div>
  `).join('');
}

function closeEditor() { document.getElementById('role-editor')?.remove(); }

function openEditor(idx) {
  if (document.getElementById('role-editor')) { closeEditor(); if (idx == null) return; }
  const existing = idx != null ? getRoles()[idx] : null;

  const card = document.createElement('div');
  card.id = 'role-editor';
  card.className = 'p-3 border-b border-slate-700/50 bg-slate-800/30';
  card.innerHTML = `
    <input id="re-name" type="text" maxlength="40" placeholder="Role name" value="${esc(existing?.name || '')}"
      class="w-full px-3 py-2 text-sm bg-slate-900 border border-slate-700 rounded-md text-slate-200 placeholder-slate-500 outline-none focus:border-blue-500 transition-colors mb-2">
    <textarea id="re-instructions" rows="4" placeholder="Who am I? e.g. You are a senior software architect. You break down goals into clear, actionable tasks with acceptance criteria."
      class="w-full max-w-full px-3 py-1.5 text-xs bg-slate-900 border border-slate-700 rounded-md text-slate-200 placeholder-slate-600 outline-none focus:border-blue-500 transition-colors resize-y leading-relaxed font-mono mb-2" style="min-height:5lh">${esc(existing?.instructions || '')}</textarea>
    <div class="flex items-center gap-2">
      <button id="re-save" class="px-4 py-1.5 text-xs font-medium bg-blue-600 hover:bg-blue-500 text-white rounded-md transition-colors">${existing ? 'Save' : 'Add'}</button>
      <button id="re-cancel" class="px-3 py-1.5 text-xs text-slate-500 hover:text-slate-300 transition-colors">Cancel</button>
    </div>`;

  const list = panel.querySelector('#roles-list');
  list.parentElement.insertBefore(card, list);

  const nameEl = card.querySelector('#re-name');
  const instrEl = card.querySelector('#re-instructions');
  nameEl.focus();

  const doSave = () => {
    const name = nameEl.value.trim();
    const instructions = instrEl.value.trim();
    if (!name || !instructions) return;
    if (!state.cfg.roles) state.cfg.roles = [];
    if (idx != null) {
      state.cfg.roles[idx] = { ...state.cfg.roles[idx], name, instructions };
    } else {
      state.cfg.roles.push({ id: crypto.randomUUID(), name, instructions });
    }
    save();
    closeEditor();
    renderRoles();
  };

  card.querySelector('#re-save').addEventListener('click', doSave);
  card.querySelector('#re-cancel').addEventListener('click', closeEditor);
  nameEl.addEventListener('keydown', (e) => { if (e.key === 'Escape') closeEditor(); });
}
