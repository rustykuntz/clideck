import { closeThemeMenu } from './settings.js';

const PANELS = ['chats', 'projects', 'prompts'];
const ACTIVE = ['text-slate-200', 'bg-slate-800'];
const INACTIVE = ['text-slate-500', 'hover:text-slate-300', 'hover:bg-slate-800/50'];

function setRailActive(id) {
  document.querySelectorAll('#nav-rail .rail-btn').forEach(btn => {
    const match = (btn.dataset.panel === id) || (btn.id === 'rail-settings' && id === 'settings');
    ACTIVE.forEach(c => btn.classList.toggle(c, match));
    INACTIVE.forEach(c => btn.classList.toggle(c, !match));
  });
}

function showSettings() {
  PANELS.forEach(id => {
    const el = document.getElementById(`panel-${id}`);
    if (el) { el.classList.add('hidden'); el.classList.remove('flex'); }
  });
  document.getElementById('settings-overlay').classList.remove('hidden');
  document.getElementById('settings-overlay').classList.add('flex');
  document.getElementById('btn-new').classList.add('opacity-30', 'pointer-events-none');
  setRailActive('settings');
}

function hideSettings() {
  closeThemeMenu();
  document.getElementById('settings-overlay').classList.add('hidden');
  document.getElementById('settings-overlay').classList.remove('flex');
  document.getElementById('btn-new').classList.remove('opacity-30', 'pointer-events-none');
}

export function switchPanel(panelId) {
  hideSettings();
  PANELS.forEach(id => {
    const el = document.getElementById(`panel-${id}`);
    if (!el) return;
    el.classList.toggle('hidden', id !== panelId);
    el.classList.toggle('flex', id === panelId);
  });
  setRailActive(panelId);
}

document.getElementById('nav-rail').addEventListener('click', (e) => {
  const btn = e.target.closest('.rail-btn');
  if (!btn) return;
  if (btn.id === 'rail-settings') showSettings();
  else if (btn.dataset.panel) switchPanel(btn.dataset.panel);
});
