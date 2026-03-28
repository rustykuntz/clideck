// Autopilot client — toggle state, notifications, token display

let api = null;
const activeProjects = new Set();

export function init(pluginApi) {
  api = pluginApi;

  api.onMessage('started', (msg) => {
    activeProjects.add(msg.projectId);
    updateToggle(msg.projectId, true);
    api.toast('Autopilot started');
  });

  api.onMessage('stopped', (msg) => {
    activeProjects.delete(msg.projectId);
    updateToggle(msg.projectId, false);
    api.toast('Autopilot stopped');
  });

  api.onMessage('error', (msg) => api.toast(msg.msg || 'Autopilot error', { type: 'error' }));
  api.onMessage('routed', (msg) => api.toast(`→ ${msg.to}`, { type: 'info' }));
  api.onMessage('notify', (msg) => api.toast(msg.reason, { type: 'warn', duration: 0, markdown: true, title: `Autopilot \u2014 ${msg.projectName || 'Project'}` }));
  api.onMessage('paused', (msg) => api.toast(`Autopilot: ${msg.question}`, { type: 'warn' }));
  api.onMessage('resumed', () => api.toast('Autopilot resumed'));

  api.onMessage('tokens', (msg) => {
    const btn = toggleBtn(msg.projectId);
    if (btn && activeProjects.has(msg.projectId)) {
      const total = (msg.input || 0) + (msg.output || 0);
      btn.title = `Autopilot ON — ${total.toLocaleString()} tokens`;
    }
  });

  api.onMessage('status', (msg) => {
    if (msg.active) activeProjects.add(msg.projectId);
    else activeProjects.delete(msg.projectId);
    updateToggle(msg.projectId, msg.active);
  });

  // Re-apply toggle state when sidebar re-renders
  const list = document.getElementById('session-list');
  if (list) {
    new MutationObserver(() => {
      for (const pid of activeProjects) updateToggle(pid, true);
    }).observe(list, { childList: true, subtree: true });
  }

  activeProjects.clear();
  api.send('sync');
}

function toggleBtn(pid) {
  return document.querySelector(`.project-plugin-action[data-action-id="autopilot-toggle"][data-project-id="${pid}"]`);
}

function updateToggle(pid, active) {
  const btn = toggleBtn(pid);
  if (!btn) return;
  btn.classList.toggle('autopilot-active', active);
  btn.title = active ? 'Autopilot ON — click to stop' : 'Autopilot — click to start';
}

const style = document.createElement('style');
style.textContent = `
  @keyframes autopilot-pulse {
    0%, 100% { opacity: 1; filter: drop-shadow(0 0 2px #818cf8); }
    50% { opacity: 0.6; filter: drop-shadow(0 0 6px #818cf8); }
  }
  @keyframes clock-spin {
    from { transform: rotate(0deg); }
    to { transform: rotate(360deg); }
  }
  .autopilot-active {
    color: #818cf8 !important;
    opacity: 1 !important;
    animation: autopilot-pulse 2s ease-in-out infinite;
  }
  .autopilot-active svg path {
    transform-origin: 12px 12px;
    animation: clock-spin 2s linear infinite;
  }
`;
document.head.appendChild(style);
