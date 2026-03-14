import { state, send } from './state.js';
import { setSessionProject, regroupSessions } from './terminals.js';

let dragState = null;
let suppressClick = false;

export function wasDragging() {
  if (suppressClick) { suppressClick = false; return true; }
  return false;
}

const DRAG_THRESHOLD = 5;

export function initDrag() {
  const list = document.getElementById('session-list');

  list.addEventListener('pointerdown', (e) => {
    if (e.button !== 0) return;
    if (e.target.closest('.menu-btn') || e.target.closest('button')) return;

    // Project drag — grab by the header
    const projHeader = e.target.closest('.project-header');
    if (projHeader) {
      const group = projHeader.closest('.project-group');
      const rect = group.getBoundingClientRect();
      dragState = {
        mode: 'project',
        projectId: projHeader.dataset.projectId,
        row: group,
        startX: e.clientX, startY: e.clientY,
        offsetY: e.clientY - rect.top,
        ghost: null, active: false, dropTarget: null,
        pointerId: e.pointerId,
      };
      return;
    }

    // Session drag
    const row = e.target.closest('.group[data-id]');
    if (!row) return;
    const rect = row.getBoundingClientRect();
    dragState = {
      mode: 'session',
      id: row.dataset.id,
      row,
      startX: e.clientX, startY: e.clientY,
      offsetY: e.clientY - rect.top,
      ghost: null, active: false, dropTarget: null,
      pointerId: e.pointerId,
    };
  });

  list.addEventListener('pointermove', (e) => {
    if (!dragState) return;

    if (!dragState.active) {
      const dx = Math.abs(e.clientX - dragState.startX);
      const dy = Math.abs(e.clientY - dragState.startY);
      if (dx < DRAG_THRESHOLD && dy < DRAG_THRESHOLD) return;
      dragState.row.setPointerCapture(dragState.pointerId);
      startDrag(dragState);
    }

    dragState.ghost.style.top = (e.clientY - dragState.offsetY) + 'px';

    if (dragState.mode === 'project') updateProjectDropTarget(e.clientY);
    else updateDropTarget(e.clientY);
  });

  list.addEventListener('pointerup', () => {
    if (!dragState) return;
    if (dragState.active) endDrag();
    dragState = null;
  });

  list.addEventListener('pointercancel', () => {
    if (dragState?.active) cancelDrag();
    dragState = null;
  });
}

function startDrag(ds) {
  ds.active = true;
  ds.row.style.opacity = '0.3';

  const ghost = ds.row.cloneNode(true);
  ghost.style.position = 'fixed';
  ghost.style.zIndex = '500';
  ghost.style.pointerEvents = 'none';
  ghost.style.boxShadow = '0 25px 50px -12px rgba(0,0,0,0.5)';
  ghost.style.top = (ds.startY - ds.offsetY) + 'px';
  ghost.style.left = ds.row.getBoundingClientRect().left + 'px';
  ghost.style.width = ds.row.offsetWidth + 'px';
  ghost.style.transition = 'none';
  ghost.style.opacity = '0.9';
  document.body.appendChild(ghost);
  ds.ghost = ghost;

  if (ds.mode === 'session') {
    document.querySelectorAll('.project-header').forEach(h => h.classList.add('drop-zone'));
  }
}

// --- Session drop target ---

function updateDropTarget(clientY) {
  document.querySelectorAll('.drop-highlight').forEach(el => el.classList.remove('drop-highlight'));
  dragState.dropTarget = null;

  for (const header of document.querySelectorAll('.project-header')) {
    const rect = header.getBoundingClientRect();
    if (clientY >= rect.top && clientY <= rect.bottom) {
      header.classList.add('drop-highlight');
      dragState.dropTarget = { type: 'project', projectId: header.dataset.projectId };
      return;
    }
  }

  const firstGroup = document.querySelector('.project-group');
  if (firstGroup) {
    const rect = firstGroup.getBoundingClientRect();
    if (clientY < rect.top) {
      dragState.dropTarget = { type: 'ungrouped' };
    }
  }
}

// --- Project drop target ---

function updateProjectDropTarget(clientY) {
  document.querySelectorAll('.project-drop-line').forEach(el => el.remove());
  dragState.dropTarget = null;

  const groups = [...document.querySelectorAll('.project-group')];
  const dragIdx = groups.indexOf(dragState.row);

  for (let i = 0; i <= groups.length; i++) {
    // Midpoint between adjacent groups — above first, between pairs, below last
    let edgeY;
    if (i === 0) {
      edgeY = groups[0].getBoundingClientRect().top;
    } else if (i === groups.length) {
      edgeY = groups[groups.length - 1].getBoundingClientRect().bottom;
    } else {
      const above = groups[i - 1].getBoundingClientRect().bottom;
      const below = groups[i].getBoundingClientRect().top;
      edgeY = (above + below) / 2;
    }

    // Find the closest edge
    const next = i < groups.length ? groups[i].getBoundingClientRect().top : Infinity;
    const prev = i > 0 ? groups[i - 1].getBoundingClientRect().bottom : -Infinity;

    if (clientY >= prev && clientY < next) {
      // Skip if dropping in the same position (before or after self)
      if (i === dragIdx || i === dragIdx + 1) return;

      dragState.dropTarget = { type: 'reorder', insertBefore: i };

      // Show insertion line
      const line = document.createElement('div');
      line.className = 'project-drop-line';
      const ref = i < groups.length ? groups[i] : null;
      const list = document.getElementById('session-list');
      if (ref) list.insertBefore(line, ref);
      else list.appendChild(line);
      return;
    }
  }
}

// --- End drag ---

function endDrag() {
  const ds = dragState;
  if (ds.mode === 'project') suppressClick = true;
  ds.row.style.opacity = '';
  ds.ghost?.remove();
  document.querySelectorAll('.drop-highlight, .drop-zone').forEach(el => {
    el.classList.remove('drop-highlight', 'drop-zone');
  });
  document.querySelectorAll('.project-drop-line').forEach(el => el.remove());

  if (!ds.dropTarget) return;

  if (ds.mode === 'session') {
    const entry = state.terms.get(ds.id);
    if (!entry) return;
    if (ds.dropTarget.type === 'project' && entry.projectId !== ds.dropTarget.projectId) {
      setSessionProject(ds.id, ds.dropTarget.projectId);
    } else if (ds.dropTarget.type === 'ungrouped' && entry.projectId) {
      setSessionProject(ds.id, null);
    }
  } else if (ds.mode === 'project' && ds.dropTarget.type === 'reorder') {
    const projects = state.cfg.projects || [];
    const fromIdx = projects.findIndex(p => p.id === ds.projectId);
    if (fromIdx < 0) return;
    const [moved] = projects.splice(fromIdx, 1);
    // Adjust insertion index after removal
    let toIdx = ds.dropTarget.insertBefore;
    if (toIdx > fromIdx) toIdx--;
    projects.splice(toIdx, 0, moved);
    send({ type: 'config.update', config: state.cfg });
    regroupSessions();
  }
}

function cancelDrag() {
  if (dragState) {
    dragState.row.style.opacity = '';
    dragState.ghost?.remove();
    document.querySelectorAll('.drop-highlight, .drop-zone').forEach(el => {
      el.classList.remove('drop-highlight', 'drop-zone');
    });
    document.querySelectorAll('.project-drop-line').forEach(el => el.remove());
  }
}
