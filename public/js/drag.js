import { state, send } from './state.js';
import { setSessionProject, regroupSessions } from './terminals.js';

let dragState = null;

const DRAG_THRESHOLD = 5;

export function initDrag() {
  const list = document.getElementById('session-list');

  list.addEventListener('pointerdown', (e) => {
    if (e.button !== 0) return;
    const row = e.target.closest('.group[data-id]');
    if (!row || e.target.closest('.menu-btn') || e.target.closest('button')) return;

    const id = row.dataset.id;
    const rect = row.getBoundingClientRect();
    dragState = {
      id,
      startX: e.clientX,
      startY: e.clientY,
      offsetY: e.clientY - rect.top,
      row,
      ghost: null,
      active: false,
      dropTarget: null,
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

    // Move ghost
    dragState.ghost.style.top = (e.clientY - dragState.offsetY) + 'px';

    // Find drop target
    updateDropTarget(e.clientY);
  });

  list.addEventListener('pointerup', (e) => {
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

  // Create ghost
  const ghost = ds.row.cloneNode(true);
  ghost.className = ds.row.className + ' fixed z-[500] pointer-events-none shadow-xl shadow-black/50 bg-slate-800 border border-slate-600 rounded-lg w-[320px]';
  ghost.style.top = (ds.startY - ds.offsetY) + 'px';
  ghost.style.left = ds.row.getBoundingClientRect().left + 'px';
  ghost.style.width = ds.row.offsetWidth + 'px';
  ghost.style.transition = 'none';
  document.body.appendChild(ghost);
  ds.ghost = ghost;

  // Add drop indicators
  document.querySelectorAll('.project-header').forEach(h => {
    h.classList.add('drop-zone');
  });
}

function updateDropTarget(clientY) {
  // Clear previous
  document.querySelectorAll('.drop-highlight').forEach(el => el.classList.remove('drop-highlight'));
  dragState.dropTarget = null;

  // Check if hovering over a project header
  for (const header of document.querySelectorAll('.project-header')) {
    const rect = header.getBoundingClientRect();
    if (clientY >= rect.top && clientY <= rect.bottom) {
      header.classList.add('drop-highlight');
      dragState.dropTarget = { type: 'project', projectId: header.dataset.projectId };
      return;
    }
  }

  // Check if above all project groups (= ungrouped area)
  const firstGroup = document.querySelector('.project-group');
  if (firstGroup) {
    const rect = firstGroup.getBoundingClientRect();
    if (clientY < rect.top) {
      dragState.dropTarget = { type: 'ungrouped' };
    }
  }
}

function endDrag() {
  const ds = dragState;
  ds.row.style.opacity = '';
  ds.ghost?.remove();
  document.querySelectorAll('.drop-highlight, .drop-zone').forEach(el => {
    el.classList.remove('drop-highlight', 'drop-zone');
  });

  if (ds.dropTarget) {
    const entry = state.terms.get(ds.id);
    if (!entry) return;

    if (ds.dropTarget.type === 'project' && entry.projectId !== ds.dropTarget.projectId) {
      setSessionProject(ds.id, ds.dropTarget.projectId);
    } else if (ds.dropTarget.type === 'ungrouped' && entry.projectId) {
      setSessionProject(ds.id, null);
    }
  }
}

function cancelDrag() {
  if (dragState) {
    dragState.row.style.opacity = '';
    dragState.ghost?.remove();
    document.querySelectorAll('.drop-highlight, .drop-zone').forEach(el => {
      el.classList.remove('drop-highlight', 'drop-zone');
    });
  }
}
