import { state, send } from './state.js';
import { esc } from './utils.js';

function isRoot(p) { return p === '/' || /^[A-Za-z]:\\$/.test(p); }
function parentOf(p) {
  const up = p.replace(/[\\/][^\\/]+[\\/]?$/, '');
  if (!up) {
    const drive = p.match(/^([A-Za-z]:)/);
    return drive ? drive[1] + '\\' : '/';
  }
  return /^[A-Za-z]:$/.test(up) ? up + '\\' : up;
}
function joinChild(base, name) {
  const sep = base.includes('\\') ? '\\' : '/';
  return base.endsWith(sep) ? base + name : base + sep + name;
}

const overlay = document.getElementById('folder-picker');
const pathBar = document.getElementById('fp-path');
const listing = document.getElementById('fp-listing');
const selectBtn = document.getElementById('fp-select');
const hiddenBtn = document.getElementById('fp-toggle-hidden');
const newFolderBtn = document.getElementById('fp-new-folder');
let currentPath = '';
let pendingPath = '';
let onSelect = null;
let showHidden = false;

export function openFolderPicker(startPath, callback) {
  currentPath = '';
  onSelect = callback;
  overlay.classList.remove('hidden');
  overlay.classList.add('flex');
  navigate(startPath || state.cfg.defaultPath || '/');
}

export function closeFolderPicker() {
  overlay.classList.add('hidden');
  overlay.classList.remove('flex');
  onSelect = null;
  closeNewFolderInput();
}

function navigate(path) {
  pendingPath = path;
  pathBar.textContent = path;
  listing.innerHTML = '<div class="p-4 text-center text-slate-500 text-sm">Loading...</div>';
  selectBtn.disabled = true;
  closeNewFolderInput();
  send({ type: 'dirs.list', path, showHidden });
}

export function handleDirsResponse(msg) {
  if (overlay.classList.contains('hidden')) return;
  if (msg.path !== pendingPath) return;
  if (msg.error) {
    listing.innerHTML = `<div class="p-4 text-center text-red-400 text-sm">${esc(msg.error)}</div>`;
    return;
  }
  currentPath = msg.path;
  selectBtn.disabled = false;
  let html = '';
  if (!isRoot(currentPath)) {
    const parent = parentOf(currentPath);
    html += `<div class="fp-item px-4 py-1.5 cursor-pointer hover:bg-slate-700 text-sm text-slate-400 transition-colors" data-path="${esc(parent)}">..</div>`;
  }
  if (msg.entries.length === 0 && !html) {
    html = '<div class="p-4 text-center text-slate-500 text-sm">Empty directory</div>';
  }
  html += msg.entries.map(name => {
    const dimClass = name.startsWith('.') ? ' text-slate-500' : ' text-slate-200';
    return `<div class="fp-item px-4 py-1.5 cursor-pointer hover:bg-slate-700 text-sm${dimClass} transition-colors" data-path="${esc(joinChild(currentPath, name))}">${esc(name)}</div>`;
  }).join('');
  listing.innerHTML = html;
}

// --- Hidden files toggle ---

function updateHiddenBtn() {
  hiddenBtn.classList.toggle('text-slate-200', showHidden);
  hiddenBtn.classList.toggle('text-slate-500', !showHidden);
  hiddenBtn.title = showHidden ? 'Hide hidden files' : 'Show hidden files';
}

hiddenBtn.addEventListener('click', () => {
  showHidden = !showHidden;
  updateHiddenBtn();
  if (currentPath) navigate(currentPath);
});

// --- New folder inline input ---

let newFolderActive = false;

function closeNewFolderInput() {
  if (!newFolderActive) return;
  newFolderActive = false;
  const row = listing.querySelector('.fp-new-folder-row');
  if (row) row.remove();
}

function openNewFolderInput() {
  if (newFolderActive || !currentPath) return;
  newFolderActive = true;
  const row = document.createElement('div');
  row.className = 'fp-new-folder-row flex items-center gap-2 px-4 py-1.5';
  row.innerHTML = `
    <svg class="flex-shrink-0 text-slate-400" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M22 19a2 2 0 01-2 2H4a2 2 0 01-2-2V5a2 2 0 012-2h5l2 3h9a2 2 0 012 2z"/></svg>
    <input type="text" class="fp-new-folder-input flex-1 bg-slate-700 border border-slate-600 rounded px-2 py-0.5 text-sm text-slate-200 placeholder-slate-500 outline-none focus:border-blue-500 transition-colors" placeholder="Folder name" spellcheck="false" />
    <button class="fp-new-folder-ok p-0.5 rounded hover:bg-slate-700 text-emerald-400 hover:text-emerald-300 transition-colors" title="Create">
      <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"/></svg>
    </button>
    <button class="fp-new-folder-no p-0.5 rounded hover:bg-slate-700 text-slate-400 hover:text-slate-300 transition-colors" title="Cancel">
      <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>
    </button>`;
  listing.prepend(row);
  const input = row.querySelector('.fp-new-folder-input');
  input.focus();

  function submit() {
    const name = input.value.trim();
    if (!name) { closeNewFolderInput(); return; }
    input.disabled = true;
    send({ type: 'dirs.mkdir', parent: currentPath, name });
  }

  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') { e.preventDefault(); submit(); }
    if (e.key === 'Escape') { e.preventDefault(); closeNewFolderInput(); }
  });
  row.querySelector('.fp-new-folder-ok').addEventListener('click', submit);
  row.querySelector('.fp-new-folder-no').addEventListener('click', closeNewFolderInput);
}

newFolderBtn.addEventListener('click', openNewFolderInput);

export function handleMkdirResponse(msg) {
  if (!newFolderActive) return;
  closeNewFolderInput();
  if (msg.success) {
    navigate(msg.path);
  } else {
    // Show error inline briefly
    const err = document.createElement('div');
    err.className = 'px-4 py-1.5 text-xs text-red-400';
    err.textContent = msg.error || 'Failed to create folder';
    listing.prepend(err);
    setTimeout(() => err.remove(), 3000);
  }
}

// --- Navigation and select ---

listing.addEventListener('click', (e) => {
  const item = e.target.closest('.fp-item');
  if (item) navigate(item.dataset.path);
});

document.getElementById('fp-select').addEventListener('click', () => {
  if (onSelect && currentPath) onSelect(currentPath);
  closeFolderPicker();
});

document.getElementById('fp-cancel').addEventListener('click', closeFolderPicker);
