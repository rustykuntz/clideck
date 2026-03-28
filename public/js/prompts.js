// Prompt Library — manage saved prompts and // trigger autocomplete
import { state, send } from './state.js';
import { esc } from './utils.js';

// --- Panel rendering ---

const panel = document.getElementById('panel-prompts');

function getPrompts() { return state.cfg.prompts || []; }

function save() {
  send({ type: 'config.update', config: state.cfg });
}

export function renderPrompts() {
  const prompts = getPrompts();
  panel.innerHTML = `
    <div class="flex items-center justify-between px-3 pt-3 pb-2">
      <span class="text-sm font-bold text-slate-200 tracking-tight" style="font-family:'JetBrains Mono',monospace">Prompts</span>
      <button id="btn-add-prompt" class="icon-btn w-7 h-7 flex items-center justify-center rounded-md border border-slate-600 text-slate-400 hover:bg-slate-700 hover:text-slate-200 transition-colors text-sm" title="New prompt">+</button>
    </div>
    <div class="px-3 pb-2.5">
      <div id="prompts-hint" class="flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg bg-slate-800/40 text-slate-600 text-[11px] cursor-text">
        <kbd class="prompts-hint-kbd px-1.5 py-0.5 rounded bg-slate-700/60 text-slate-400 font-mono text-[10px]">//</kbd>
        <span class="prompts-hint-label flex-1">Type in terminal to search &amp; paste</span>
        <input id="prompts-search" type="text" placeholder="Filter prompts…" class="hidden flex-1 bg-transparent text-slate-300 text-[11px] outline-none placeholder-slate-600">
      </div>
    </div>
    <div id="prompts-list" class="tmx-scroll flex-1 overflow-y-auto border-t border-slate-700/50"></div>`;

  const hint = panel.querySelector('#prompts-hint');
  const searchInput = panel.querySelector('#prompts-search');
  const hintKbd = panel.querySelector('.prompts-hint-kbd');
  const hintLabel = panel.querySelector('.prompts-hint-label');

  hint.addEventListener('click', () => {
    hintKbd.classList.add('hidden');
    hintLabel.classList.add('hidden');
    searchInput.classList.remove('hidden');
    searchInput.focus();
  });

  searchInput.addEventListener('blur', () => {
    if (!searchInput.value) {
      searchInput.classList.add('hidden');
      hintKbd.classList.remove('hidden');
      hintLabel.classList.remove('hidden');
    }
  });

  searchInput.addEventListener('input', () => {
    renderPromptList(prompts, searchInput.value);
  });

  searchInput.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
      searchInput.value = '';
      searchInput.blur();
      renderPromptList(prompts, '');
    }
  });

  panel.querySelector('#btn-add-prompt').addEventListener('click', () => openEditor());

  const list = panel.querySelector('#prompts-list');

  // Delegate clicks on the list once — survives innerHTML replacements from filtering
  list.addEventListener('click', (e) => {
    if (e.target.closest('.prompt-edit')) {
      const idx = +e.target.closest('.prompt-row').dataset.idx;
      openEditor(idx);
      return;
    }
    if (e.target.closest('.prompt-del')) {
      const idx = +e.target.closest('.prompt-row').dataset.idx;
      state.cfg.prompts.splice(idx, 1);
      save();
      renderPrompts();
      return;
    }
    const row = e.target.closest('.prompt-row');
    if (row) {
      const idx = +row.dataset.idx;
      pastePrompt(prompts[idx].text);
    }
  });

  renderPromptList(prompts, '');
}

function renderPromptList(prompts, filter) {
  const list = panel.querySelector('#prompts-list');
  const q = (filter || '').toLowerCase().trim();
  const filtered = q ? prompts.filter(p => p.name.toLowerCase().includes(q) || p.text.toLowerCase().includes(q)) : prompts;
  if (!prompts.length) {
    list.innerHTML = `<div class="flex flex-col items-center justify-center h-full px-6 text-center">
      <p class="text-sm text-slate-400 mb-1">No prompts saved</p>
      <p class="text-xs text-slate-600 leading-relaxed">Add prompts and paste them into any terminal<br>by typing <kbd class="px-1 py-0.5 rounded bg-slate-800 text-slate-400 text-[11px] font-mono">//</kbd> followed by a few letters.</p>
    </div>`;
  } else if (!filtered.length) {
    list.innerHTML = `<div class="flex items-center justify-center py-6 px-6 text-center">
      <p class="text-xs text-slate-600">No prompts matching "${esc(q)}"</p>
    </div>`;
  } else {
    list.innerHTML = filtered.map((p, i) => {
      const idx = prompts.indexOf(p);
      return `
      <div class="prompt-row group flex items-start gap-2 px-3 py-2.5 cursor-pointer hover:bg-slate-800/40 transition-colors ${i > 0 ? 'border-t border-slate-700/30' : ''}" data-idx="${idx}">
        <div class="flex-1 min-w-0">
          <div class="text-[13px] font-medium text-slate-200 truncate">${esc(p.name)}</div>
          <div class="text-[11px] text-slate-500 mt-0.5 line-clamp-2 leading-relaxed">${esc(p.text)}</div>
        </div>
        <div class="flex items-center gap-0.5 opacity-0 group-hover:opacity-100 transition-opacity flex-shrink-0 mt-0.5">
          <button class="prompt-edit w-6 h-6 flex items-center justify-center rounded text-slate-500 hover:text-slate-300 hover:bg-slate-700/60 transition-colors" title="Edit">
            <svg class="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="1.5"><path d="M17 3a2.85 2.85 0 1 1 4 4L7.5 20.5 2 22l1.5-5.5Z"/></svg>
          </button>
          <button class="prompt-del w-6 h-6 flex items-center justify-center rounded text-slate-500 hover:text-red-400 hover:bg-slate-700/60 transition-colors" title="Delete">
            <svg class="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="1.5"><path d="M18 6L6 18M6 6l12 12"/></svg>
          </button>
        </div>
      </div>`;
    }).join('');
  }
}

function closeEditor() {
  document.getElementById('prompt-editor')?.remove();
}

function openEditor(idx) {
  // Toggle off if already open
  if (document.getElementById('prompt-editor')) { closeEditor(); if (idx == null) return; }
  const existing = idx != null ? getPrompts()[idx] : null;

  const card = document.createElement('div');
  card.id = 'prompt-editor';
  card.className = 'p-3 border-b border-slate-700/50 bg-slate-800/30';
  card.innerHTML = `
    <input id="pe-name" type="text" maxlength="60" placeholder="Prompt name" value="${esc(existing?.name || '')}"
      class="w-full px-3 py-2 text-sm bg-slate-900 border border-slate-700 rounded-md text-slate-200 placeholder-slate-500 outline-none focus:border-blue-500 transition-colors mb-2">
    <textarea id="pe-text" rows="4" placeholder="Prompt text to paste into terminal"
      class="w-full max-w-full px-3 py-1.5 text-xs bg-slate-900 border border-slate-700 rounded-md text-slate-200 placeholder-slate-600 outline-none focus:border-blue-500 transition-colors resize-y leading-relaxed font-mono mb-2" style="min-height:5lh">${esc(existing?.text || '')}</textarea>
    <div class="flex items-center gap-2">
      <button id="pe-save" class="px-4 py-1.5 text-xs font-medium bg-blue-600 hover:bg-blue-500 text-white rounded-md transition-colors">${existing ? 'Save' : 'Add'}</button>
      <button id="pe-cancel" class="px-3 py-1.5 text-xs text-slate-500 hover:text-slate-300 transition-colors">Cancel</button>
    </div>`;

  const list = panel.querySelector('#prompts-list');
  list.parentElement.insertBefore(card, list);

  const nameInput = card.querySelector('#pe-name');
  const textInput = card.querySelector('#pe-text');
  nameInput.focus();

  const doSave = () => {
    const name = nameInput.value.trim();
    const text = textInput.value.trim();
    if (!name || !text) return;
    if (!state.cfg.prompts) state.cfg.prompts = [];
    if (existing) {
      state.cfg.prompts[idx] = { ...existing, name, text };
    } else {
      state.cfg.prompts.push({ id: crypto.randomUUID(), name, text });
    }
    save();
    closeEditor();
    renderPrompts();
  };

  card.querySelector('#pe-save').addEventListener('click', doSave);
  card.querySelector('#pe-cancel').addEventListener('click', closeEditor);
  nameInput.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') closeEditor();
  });
  textInput.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') closeEditor();
    if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) doSave();
  });
}

// --- Paste prompt into active terminal ---

function pastePrompt(text) {
  if (!state.active) return;
  send({ type: 'input', id: state.active, data: text });
  // Refocus the terminal after pasting
  const entry = state.terms.get(state.active);
  if (entry) entry.term.focus();
}

// --- // Autocomplete trigger ---

let buffer = '';    // chars typed after //
let active = false; // autocomplete is open
let dropdown = null;
let selectedIdx = 0;

function getMatches() {
  const q = buffer.toLowerCase();
  return getPrompts().filter(p =>
    p.name.toLowerCase().includes(q) || p.text.toLowerCase().includes(q)
  );
}

function showDropdown() {
  closeDropdown();
  const matches = getMatches();

  dropdown = document.createElement('div');
  dropdown.className = 'prompt-autocomplete';
  renderDropdownContent(matches);

  // Position: append hidden, measure, bottom-anchor to viewport
  const sidebar = document.getElementById('sidebar');
  const sidebarRect = sidebar ? sidebar.getBoundingClientRect() : { right: 60 };
  const gap = 8;
  dropdown.style.visibility = 'hidden';
  document.body.appendChild(dropdown);
  const h = dropdown.offsetHeight;
  let left = sidebarRect.right + 32;
  let top = window.innerHeight - h - gap;
  if (left + 340 > window.innerWidth - gap) left = window.innerWidth - 340 - gap;
  if (left < gap) left = gap;
  if (top < gap) top = gap;
  dropdown.style.left = left + 'px';
  dropdown.style.top = top + 'px';
  dropdown.style.visibility = '';

  // Only activate input capture after dropdown is successfully mounted
  active = true;
}

function renderDropdownContent(matches) {
  if (!dropdown) return;
  const q = buffer.toLowerCase();

  if (!matches.length) {
    dropdown.innerHTML = `
      <div class="pa-empty">No matching prompts</div>
      <div class="pa-hint">Type <kbd>//</kbd> to search your prompt library</div>`;
    return;
  }

  dropdown.innerHTML = `
    <div class="pa-header">
      <span class="pa-label">Prompts</span>
      <span class="pa-query">//${esc(buffer)}</span>
    </div>
    <div class="pa-list">${matches.map((p, i) => `
      <div class="pa-item${i === selectedIdx ? ' pa-selected' : ''}" data-idx="${i}">
        <div class="pa-name">${highlight(p.name, q)}</div>
        <div class="pa-text">${highlight(truncate(p.text, 80), q)}</div>
      </div>`).join('')}
    </div>
    <div class="pa-footer">
      <span><kbd>↑↓</kbd> navigate</span>
      <span><kbd>Enter</kbd> paste</span>
      <span><kbd>Esc</kbd> cancel</span>
    </div>`;

  // Click to select
  dropdown.querySelectorAll('.pa-item').forEach(el => {
    el.addEventListener('mousedown', (e) => {
      e.preventDefault();
      const match = matches[+el.dataset.idx];
      if (match) { closeDropdown(); pastePrompt(match.text); }
    });
  });
}

function updateDropdown() {
  if (!dropdown) return;
  const matches = getMatches();
  selectedIdx = Math.min(selectedIdx, Math.max(0, matches.length - 1));
  renderDropdownContent(matches);
}

export function closeDropdown() {
  active = false;
  buffer = '';
  selectedIdx = 0;
  if (dropdown) { dropdown.remove(); dropdown = null; }
}

function highlight(text, q) {
  if (!q) return esc(text);
  const i = text.toLowerCase().indexOf(q);
  if (i < 0) return esc(text);
  return esc(text.slice(0, i)) + '<mark>' + esc(text.slice(i, i + q.length)) + '</mark>' + esc(text.slice(i + q.length));
}

function truncate(s, n) {
  return s.length > n ? s.slice(0, n) + '…' : s;
}

// --- Key interception (called from hotkeys.js attachToTerminal) ---

// Trigger detection: let the first / go to the terminal immediately (no lag).
// If a second / arrives within 300ms, erase the first / with backspace and open autocomplete.
let lastSlashTime = 0;
let lastKeyWasPrintable = false;

export function handleTerminalKey(e) {
  if (e.type !== 'keydown') return true;

  // If autocomplete is open, consume ALL keys — nothing should leak to hotkeys
  if (active) {
    const matches = getMatches();
    if (e.key === 'Escape') {
      e.preventDefault();
      closeDropdown();
      return false;
    }
    if (e.key === 'ArrowUp') {
      e.preventDefault();
      selectedIdx = Math.max(0, selectedIdx - 1);
      updateDropdown();
      return false;
    }
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      selectedIdx = Math.min(matches.length - 1, selectedIdx + 1);
      updateDropdown();
      return false;
    }
    if (e.key === 'Enter' || e.key === 'Tab') {
      e.preventDefault();
      const match = matches[selectedIdx];
      closeDropdown();
      if (match) pastePrompt(match.text);
      return false;
    }
    if (e.key === 'Backspace') {
      e.preventDefault();
      if (buffer.length > 0) {
        buffer = buffer.slice(0, -1);
        updateDropdown();
      } else {
        closeDropdown();
      }
      return false;
    }
    // Printable character — append to buffer
    if (e.key.length === 1 && !e.ctrlKey && !e.metaKey && !e.altKey) {
      e.preventDefault();
      buffer += e.key;
      updateDropdown();
      return false;
    }
    // Block everything else (modifiers, function keys) while autocomplete is open
    e.preventDefault();
    return false;
  }

  // Detect // trigger — first / goes through normally, second / within 300ms activates.
  // Suppress if a non-whitespace character was typed just before the first / (e.g. s//, ://).
  // This is a key-history heuristic, not a true terminal-state check.
  if (e.key === '/' && !e.ctrlKey && !e.metaKey && !e.altKey && getPrompts().length > 0) {
    const now = Date.now();
    if (now - lastSlashTime < 300) {
      // Second / — erase the first / from terminal, open autocomplete
      lastSlashTime = 0;
      lastKeyWasPrintable = false;
      e.preventDefault();
      if (state.active) send({ type: 'input', id: state.active, data: '\x7f' }); // backspace to remove first /
      showDropdown();
      return false;
    }
    // First / — only start timer if previous key wasn't a non-whitespace character
    if (!lastKeyWasPrintable) {
      lastSlashTime = now;
    }
    // / is itself a non-whitespace char — keep the flag hot so s/// doesn't trigger on 3rd slash
    lastKeyWasPrintable = true;
    return true;
  }

  // Any other key resets the slash timer
  lastSlashTime = 0;
  // Track non-whitespace printable keys; whitespace (space, tab) should not block standalone //
  lastKeyWasPrintable = e.key.length === 1 && e.key.trim() !== '' && !e.ctrlKey && !e.metaKey && !e.altKey;
  return true;
}
