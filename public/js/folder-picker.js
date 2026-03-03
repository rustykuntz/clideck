import { state, send } from './state.js';
import { esc } from './utils.js';

const overlay = document.getElementById('folder-picker');
const pathBar = document.getElementById('fp-path');
const listing = document.getElementById('fp-listing');
const selectBtn = document.getElementById('fp-select');
let currentPath = '';
let pendingPath = '';
let onSelect = null;

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
}

function navigate(path) {
  pendingPath = path;
  pathBar.textContent = path;
  listing.innerHTML = '<div class="p-4 text-center text-slate-500 text-sm">Loading...</div>';
  selectBtn.disabled = true;
  send({ type: 'dirs.list', path });
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
  if (currentPath !== '/') {
    const parent = currentPath.replace(/\/[^/]+\/?$/, '') || '/';
    html += `<div class="fp-item px-4 py-1.5 cursor-pointer hover:bg-slate-700 text-sm text-slate-400 transition-colors" data-path="${esc(parent)}">..</div>`;
  }
  if (msg.entries.length === 0 && !html) {
    html = '<div class="p-4 text-center text-slate-500 text-sm">Empty directory</div>';
  }
  html += msg.entries.map(name =>
    `<div class="fp-item px-4 py-1.5 cursor-pointer hover:bg-slate-700 text-sm text-slate-200 transition-colors" data-path="${esc(currentPath === '/' ? '/' + name : currentPath + '/' + name)}">${esc(name)}</div>`
  ).join('');
  listing.innerHTML = html;
}

listing.addEventListener('click', (e) => {
  const item = e.target.closest('.fp-item');
  if (item) navigate(item.dataset.path);
});

document.getElementById('fp-select').addEventListener('click', () => {
  if (onSelect && currentPath) onSelect(currentPath);
  closeFolderPicker();
});

document.getElementById('fp-cancel').addEventListener('click', closeFolderPicker);
