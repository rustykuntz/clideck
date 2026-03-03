import { closeThemeMenu } from './settings.js';

const ALL_PANELS = ['chats', 'projects', 'prompts', 'settings'];
const ACTIVE = ['text-slate-200', 'bg-slate-800'];
const INACTIVE = ['text-slate-500', 'hover:text-slate-300', 'hover:bg-slate-800/50'];

function setRailActive(id) {
  document.querySelectorAll('#nav-rail .rail-btn').forEach(btn => {
    const match = (btn.dataset.panel === id) || (btn.id === 'rail-settings' && id === 'settings');
    ACTIVE.forEach(c => btn.classList.toggle(c, match));
    INACTIVE.forEach(c => btn.classList.toggle(c, !match));
  });
}

function hideAllPanels() {
  ALL_PANELS.forEach(id => {
    const el = document.getElementById(`panel-${id}`);
    if (el) { el.classList.add('hidden'); el.classList.remove('flex'); }
  });
}

function showSettings() {
  hideAllPanels();
  document.getElementById('panel-settings').classList.remove('hidden');
  document.getElementById('panel-settings').classList.add('flex');
  document.getElementById('settings-overlay').classList.remove('hidden');
  document.getElementById('btn-new').classList.add('opacity-30', 'pointer-events-none');
  setRailActive('settings');
}

function hideSettings() {
  closeThemeMenu();
  document.getElementById('settings-overlay').classList.add('hidden');
  document.getElementById('btn-new').classList.remove('opacity-30', 'pointer-events-none');
}

export function switchPanel(panelId) {
  hideSettings();
  hideAllPanels();
  document.getElementById('session-creator')?.remove();
  const el = document.getElementById(`panel-${panelId}`);
  if (el) { el.classList.remove('hidden'); el.classList.add('flex'); }
  setRailActive(panelId);
}

document.getElementById('nav-rail').addEventListener('click', (e) => {
  const btn = e.target.closest('.rail-btn');
  if (!btn) return;
  if (btn.id === 'rail-settings') showSettings();
  else if (btn.dataset.panel) switchPanel(btn.dataset.panel);
});
