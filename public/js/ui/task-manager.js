import { h } from "../util.js";

const REFRESH_MS = 5000;
const bytes = value => value >= 1024 ** 3 ? `${(value / 1024 ** 3).toFixed(1)} GB` : `${Math.round(value / 1024 ** 2)} MB`;
const text = (tag, cls, value) => { const node = h(tag, cls); node.textContent = value; return node; };
const svg = path => `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${path}</svg>`;
const CLOSE = svg('<path d="m6 6 12 12M18 6 6 18"/>');
const REFRESH = svg('<path d="M20 11a8 8 0 1 0-2.3 5.7"/><path d="M20 4v7h-7"/>');
const CHEVRON = '<svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m9 6 6 6-6 6"/></svg>';
// Plain-text cell; heavy CPU reads warm, near-idle values recede so busy jobs stand out.
const metricCell = (value, level) => text('td', `tasks-number${level ? ' ' + level : ''}`, value);
const cpuLevel = cpu => cpu >= 50 ? 'hot' : cpu < 1 ? 'quiet' : '';
const byName = (a, b) => a.localeCompare(b, undefined, { numeric: true, sensitivity: 'base' });
const ARROW = '<svg width="9" height="9" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 5v14M6 13l6 6 6-6"/></svg>';
// Sortable columns. Numbers start high-to-low (what is heavy, what has run longest); names and PIDs start A→Z / low.
const COLUMNS = [
  { key: 'name', label: 'Process', dir: 'asc' }, { key: 'cpu', label: 'CPU', dir: 'desc' }, { key: 'memory', label: 'RAM', dir: 'desc' },
  { key: 'elapsed', label: 'Running', dir: 'desc' }, { key: 'pid', label: 'PID', dir: 'asc' },
];
const SORT_KEY = 'clideck.tasks.sort';
function savedSort() {
  try { const v = JSON.parse(localStorage.getItem(SORT_KEY) || 'null'); if (COLUMNS.some(c => c.key === v?.key) && (v.dir === 'asc' || v.dir === 'desc')) return v; } catch {}
  return { key: 'name', dir: 'asc' };   // calm default: agents in a stable A→Z order, not a CPU race
}
// ps etime: [[dd-]hh:]mm:ss → seconds.
export function elapsedSeconds(value) {
  const m = /^(?:(\d+)-)?(?:(\d+):)?(\d+):(\d+)$/.exec(String(value || '').trim());
  return m ? ((+m[1] || 0) * 86400) + ((+m[2] || 0) * 3600) + (+m[3] * 60) + +m[4] : 0;
}

// A raw command line as people read it: the program's name, then its arguments with long paths cut to their
// last part. macOS bundles are named by their bundle; agent shells ("zsh -c <setup> && eval '<command>'")
// show the command they run. The full line stays in the tooltip and the stop confirmation.
export function describe(command) {
  const raw = String(command || '').trim(), bundle = raw.startsWith('/') ? raw.indexOf('/Contents/MacOS/') : -1;
  let name, rest;
  if (bundle > 0) {
    name = raw.slice(raw.lastIndexOf('/', bundle - 1) + 1, bundle).replace(/\.(?:app|xpc|appex)$/, '');
    const after = raw.slice(bundle + 16);
    rest = after.startsWith(name) ? after.slice(name.length) : after.replace(/^\S+/, '');
  } else {
    const first = raw.split(/\s/, 1)[0];
    name = first.slice(first.lastIndexOf('/') + 1) || first; rest = raw.slice(first.length);
  }
  if (/^(?:ba|z|da|k)?sh$/.test(name)) { const run = rest.match(/\beval '([\s\S]*?)'?$/); if (run) rest = run[1].replace(/'"'"'/g, "'"); }
  rest = rest.replace(/\\012/g, ' ').replace(/(^|[\s=:"'(])\/(?:[^\s/"']+\/)+/g, '$1…/');
  return { name, detail: rest.replace(/\s+/g, ' ').trim() };
}

// Opened from the sidebar footer's app menu (openTaskManager); an old #task-manager button still works.
let trigger = null;
export function openTaskManager() { trigger?.onclick?.(); }
export function initTaskManager() {
  trigger = document.getElementById("task-manager") || {};
  let opened = false;
  trigger.onclick = () => {
    if (opened) return;
    opened = true;
    let closed = false;
    const returnFocus = document.activeElement;
    let timer = null, pending = null, busy = false, snapshot = null, selected = null;
    let expanded = new Map(), filterProject = '', filterSession = '', page = 0, mode = 'agents';
    const overlay = h("div", "tasks-overlay");
    const dialog = h("section", "tasks-dialog"); dialog.setAttribute("role", "dialog");
    dialog.setAttribute("aria-modal", "true"); dialog.setAttribute("aria-label", "Task Manager");
    const head = h("header", "tasks-head");
    const titles = h("div", "tasks-titles"); titles.append(text("h2", "", "Task Manager"), text("p", "tasks-muted", "See what your agents—and this computer—are running."));
    const updated = text("span", "tasks-updated", "");
    const refresh = h("button", "tasks-refresh", `${REFRESH}<span>Refresh</span>`); refresh.type = "button"; refresh.title = "Refresh now"; refresh.setAttribute("aria-label", "Refresh");
    const close = h("button", "tasks-close", CLOSE); close.type = "button"; close.setAttribute("aria-label", "Close Task Manager");
    const actions = h("div", "tasks-head-actions"); actions.append(updated, refresh, close);
    head.append(titles, actions);
    const toolbar = h("div", "tasks-toolbar");
    const select = (label, options) => {
      const el = h("select", "tasks-select"); el.setAttribute("aria-label", label);
      for (const [value, name] of options) { const option = text("option", "", name); option.value = value; el.append(option); }
      return el;
    };
    const view = h("div", "tasks-seg"); view.setAttribute("role", "group"); view.setAttribute("aria-label", "Processes to show");
    for (const [value, name] of [['agents', 'CliDeck agents'], ['other', 'Other processes'], ['all', 'All']]) {
      const option = text("button", "tasks-seg-b", name); option.type = "button"; option.dataset.value = value;
      option.onclick = () => { if (mode !== value) { mode = value; changed(); } }; view.append(option);
    }
    const project = select("Project filter", [['', 'All projects']]);
    const agent = select("Agent filter", [['', 'All agents']]);
    toolbar.append(view, project, agent);
    let sort = savedSort();
    const summary = h("div", "tasks-summary");
    const stat = (label) => { const box = h("div", "tasks-stat"), value = text("strong", "", "–"), sub = text("span", "", label); box.append(value, sub); summary.append(box); return [value, sub]; };
    const [countValue, countLabel] = stat("processes"), [cpuValue, cpuLabel] = stat("CPU"), [memoryValue] = stat("RAM");
    const notice = h("div", "tasks-notice"); notice.hidden = true; notice.setAttribute("role", "status");
    const confirmation = h("div", "tasks-confirm"); confirmation.hidden = true; confirmation.setAttribute("role", "alertdialog"); confirmation.setAttribute("aria-label", "Confirm stop");
    const scroll = h("div", "tasks-scroll");
    const table = h("table", "tasks-table");
    const thead = h("thead"), tr = h("tr");
    // The headers ARE the sort control: click to sort by a column, click again to reverse it.
    const headers = COLUMNS.map((column, i) => {
      const th = h("th", i ? "tasks-num" : ""), button = h("button", "tasks-sort"); th.dataset.first = column.dir;
      button.type = "button"; button.append(text("span", "", column.label), h("span", "tasks-sort-arrow", ARROW));
      button.onclick = () => {
        sort = sort.key === column.key ? { key: column.key, dir: sort.dir === 'asc' ? 'desc' : 'asc' } : { key: column.key, dir: column.dir };
        try { localStorage.setItem(SORT_KEY, JSON.stringify(sort)); } catch {}
        paintSort(); page = 0; render();
      };
      th.append(button); tr.append(th); return { column, th, button };
    });
    tr.append(h("th"));
    headers[2].button.title = 'Can include memory shared with other apps';
    function paintSort() {
      for (const { column, th, button } of headers) {
        const on = column.key === sort.key;
        th.classList.toggle('sorted', on); th.classList.toggle('asc', on && sort.dir === 'asc');
        th.setAttribute('aria-sort', on ? (sort.dir === 'asc' ? 'ascending' : 'descending') : 'none');
        button.setAttribute('aria-label', `Sort by ${column.label}${on ? (sort.dir === 'asc' ? ', ascending' : ', descending') : ''}`);
      }
    }
    paintSort();
    thead.append(tr); const tbody = h("tbody"); table.append(thead, tbody);
    const state = h("div", "tasks-state"); state.setAttribute("role", "status");
    scroll.append(table, state);
    const foot = h("footer", "tasks-foot");
    foot.append(text("p", "", "Updates every 5 seconds. 100% CPU is one full core. Jobs CliDeck can't link to an agent are under Other processes."));
    const pager = h('div', 'tasks-pager');
    const prevPage = text('button', 'tasks-btn', 'Previous'), nextPage = text('button', 'tasks-btn', 'Next');
    prevPage.type = nextPage.type = 'button';
    const pageLabel = text('span', 'tasks-muted', ''); pager.append(prevPage, pageLabel, nextPage); pager.hidden = true;
    prevPage.onclick = () => { page--; render(); }; nextPage.onclick = () => { page++; render(); };
    foot.append(pager);
    dialog.append(head, toolbar, summary, notice, confirmation, scroll, foot); overlay.append(dialog); document.body.append(overlay);

    const message = (value, error = false) => { notice.textContent = value; notice.hidden = !value; notice.classList.toggle('error', error); };
    // One place for loading / error / empty: the table hides and a centred note takes its space.
    const showState = (value, retry = false) => {
      state.replaceChildren(); state.hidden = !value; table.hidden = !!value; dialog.classList.toggle('tasks-blank', !snapshot);
      if (!value) return;
      state.append(text('p', '', value));
      if (retry) { const again = text('button', 'tasks-btn', 'Try again'); again.type = 'button'; again.onclick = load; state.append(again); }
    };
    function dismiss() {
      clearTimeout(timer); pending?.abort(); pending = null;
      document.removeEventListener('visibilitychange', visibility);
      document.removeEventListener('keydown', keydown, true);
      overlay.remove(); closed = true; opened = false; returnFocus?.focus?.();
    }
    function schedule() { clearTimeout(timer); if (!closed && !document.hidden) timer = setTimeout(load, REFRESH_MS); }
    async function load() {
      clearTimeout(timer);
      if (closed || document.hidden || pending || busy) return;
      const controller = new AbortController(); pending = controller; refresh.disabled = true; dialog.setAttribute('aria-busy', 'true');
      const deadline = setTimeout(() => controller.abort(), 8000);
      try {
        const response = await fetch('/api/tasks', { signal: controller.signal, cache: 'no-store' });
        if (response.status === 404) throw new Error('Restart the CliDeck engine when you are ready to enable Task Manager. Your sessions have not been changed.');
        const data = await response.json(); if (!response.ok) throw new Error(data.error || 'Could not load processes.');
        if (closed || pending !== controller) return;
        snapshot = data;
        const tokens = new Set(data.processes.map(p => p.token));
        for (const token of expanded.keys()) if (!tokens.has(token)) expanded.delete(token);
        updateFilters(); render();
      } catch (error) {
        if (!closed && pending === controller && !document.hidden) {
          snapshot = null; tbody.replaceChildren(); selected = null; confirmation.hidden = true; pager.hidden = true; updated.textContent = '';
          for (const value of [countValue, cpuValue, memoryValue]) value.textContent = '–';
          showState(controller.signal.aborted ? 'Process lookup timed out.' : error.message, true);
        }
      } finally {
        clearTimeout(deadline);
        if (pending === controller) { pending = null; refresh.disabled = false; dialog.removeAttribute('aria-busy'); schedule(); }
      }
    }
    function updateFilters() {
      const options = (el, pairs, value) => {
        el.replaceChildren(); for (const [id, label] of pairs) { const opt = text('option', '', label); opt.value = id; el.append(opt); }
        el.value = pairs.some(p => p[0] === value) ? value : '';
      };
      const projects = [...new Set(snapshot.processes.filter(p => p.sessionId).map(p => p.project))].sort();
      options(project, [['', 'All projects'], ...projects.map(p => [p, p])], filterProject); filterProject = project.value;
      const agents = new Map(snapshot.processes.filter(p => p.sessionId && (!filterProject || p.project === filterProject)).map(p => [p.sessionId, `${p.session} · ${p.project}`]));
      options(agent, [['', 'All agents'], ...[...agents].sort((a, b) => a[1].localeCompare(b[1]))], filterSession); filterSession = agent.value;
      project.disabled = agent.disabled = mode === 'other';
    }
    function render() {
      for (const option of view.children) option.setAttribute('aria-pressed', String(option.dataset.value === mode));
      if (!snapshot) return;
      const focus = tbody.contains(document.activeElement) ? document.activeElement?.dataset?.taskControl : null;
      const rows = snapshot.processes.filter(p => (mode === 'all' || (mode === 'agents' ? p.sessionId : !p.sessionId))
        && (mode === 'other' || ((!filterProject || p.project === filterProject) && (!filterSession || p.sessionId === filterSession))));
      const cpu = rows.reduce((sum, p) => sum + p.cpu, 0), memory = rows.reduce((sum, p) => sum + p.memory, 0);
      countValue.textContent = rows.length; countLabel.textContent = rows.length === 1 ? 'process' : 'processes';
      cpuValue.textContent = `${cpu.toFixed(1)}%`; cpuLabel.textContent = `CPU · ${snapshot.cpuCount} cores`; memoryValue.textContent = bytes(memory);
      updated.textContent = `Updated ${new Date(snapshot.sampledAt).toLocaleTimeString()}`;
      tbody.replaceChildren();
      showState(rows.length ? '' : 'No processes match these filters.');
      const groups = new Map();
      let position = 0, displayed = 0;
      for (const p of rows) { const key = p.sessionId || ''; if (!groups.has(key)) groups.set(key, []); groups.get(key).push(p); }
      // One sort for the whole table: agents are ordered by the same column as the jobs inside them (their totals,
      // longest-running job, lowest PID, or project / session name). Unlinked processes always come last.
      const sign = sort.dir === 'asc' ? 1 : -1;
      const groupValue = (group) => sort.key === 'cpu' ? group.reduce((n, p) => n + p.cpu, 0)
        : sort.key === 'memory' ? group.reduce((n, p) => n + p.memory, 0)
        : sort.key === 'elapsed' ? Math.max(...group.map(p => elapsedSeconds(p.elapsed)))
        : Math.min(...group.map(p => p.pid));
      const groupOrder = ([ida, a], [idb, b]) => {
        if (!ida !== !idb) return ida ? -1 : 1;
        const byLabel = byName(a[0].project || '', b[0].project || '') || byName(a[0].session || '', b[0].session || '');
        if (sort.key === 'name') return sign * byLabel;
        return sign * (groupValue(a) - groupValue(b)) || byLabel;
      };
      for (const [id, group] of [...groups].sort(groupOrder)) {
        const beforeGroup = displayed, startPosition = position;
        const groupRow = h('tr', 'tasks-group'), label = h('td'), name = h('div', 'tasks-group-name');
        if (id) name.append(text('span', 'tasks-group-project', group[0].project), text('span', 'tasks-group-sep', ' / '), text('span', 'tasks-group-session', group[0].session));
        else name.append(text('span', 'tasks-group-session', 'Other processes'), text('span', 'tasks-group-sep', ' · '), text('span', 'tasks-group-project', 'owner unknown or outside CliDeck'));
        label.append(name);
        const groupCpu = group.reduce((s, p) => s + p.cpu, 0);
        groupRow.title = id ? 'This agent and everything it started' : '';
        groupRow.append(label, metricCell(`${groupCpu.toFixed(1)}%`, groupCpu >= 50 ? 'hot' : ''), metricCell(bytes(group.reduce((s, p) => s + p.memory, 0))), h('td'), h('td'), h('td'));
        tbody.append(groupRow);
        const byPid = new Map(group.map(p => [p.pid, p])), children = new Map();
        for (const p of group) { const parent = byPid.has(p.ppid) && p.ppid !== p.pid ? p.ppid : 0; if (!children.has(parent)) children.set(parent, []); children.get(parent).push(p); }
        const totals = new Map();
        function total(p, seen = new Set()) {
          if (totals.has(p.pid)) return totals.get(p.pid);
          if (seen.has(p.pid)) return { cpu: 0, memory: 0 };
          seen.add(p.pid); const value = { cpu: p.cpu, memory: p.memory };
          for (const child of children.get(p.pid) || []) { const t = total(child, seen); value.cpu += t.cpu; value.memory += t.memory; }
          totals.set(p.pid, value); return value;
        }
        const value = p => sort.key === 'cpu' || sort.key === 'memory' ? total(p)[sort.key] : sort.key === 'elapsed' ? elapsedSeconds(p.elapsed) : p.pid;
        const compare = (a, b) => (sort.key === 'name' ? sign * byName(describe(a.command).name, describe(b.command).name) : sign * (value(a) - value(b))) || a.pid - b.pid;
        const visited = new Set();
        const count = p => (children.get(p.pid) || []).reduce((n, child) => n + 1 + count(child), 0);
        function add(p, depth) {
          if (visited.has(p.pid)) return; visited.add(p.pid);
          const childRows = children.get(p.pid) || [], isOpen = expanded.get(p.token) ?? !p.canStop;
          // The agent's own processes are its group row (they can't be stopped here); show only its jobs.
          if (id && !p.canStop) { for (const child of childRows.sort(compare)) add(child, depth); return; }
          const index = position++;
          if (index >= page * 400 && index < (page + 1) * 400) {
            displayed++;
            const row = h('tr', 'tasks-row'), command = h('td', 'tasks-command'), line = h('div', 'tasks-command-line');
            line.style.paddingLeft = `${Math.min(depth, 8) * 16}px`;
            if (childRows.length) {
              const toggle = h('button', 'tasks-expand', CHEVRON); toggle.type = 'button';
              toggle.setAttribute('aria-label', `Show children of PID ${p.pid}`); toggle.setAttribute('aria-expanded', String(isOpen)); toggle.dataset.taskControl = `expand-${p.token}`;
              toggle.onclick = () => { expanded.set(p.token, !isOpen); render(); }; line.append(toggle);
            } else line.append(text('span', 'tasks-tree-spacer', ''));
            const { name: program, detail } = describe(p.command), name = h('span', 'tasks-command-text');
            name.append(text('span', 'tasks-proc-name', program)); if (detail) name.append(' ', text('span', 'tasks-proc-args', detail));
            name.title = `${p.command}\nStarted ${p.started} UTC`; line.append(name);
            const rolled = childRows.length && !isOpen, metrics = rolled ? total(p) : p;
            if (rolled) { const inside = count(p), more = text('span', 'tasks-proc-more', `+${inside}`); more.title = `${inside} more process${inside === 1 ? '' : 'es'} inside`; line.append(more); }
            command.append(line);
            row.title = rolled ? 'CPU and RAM include the processes inside' : '';
            row.append(command, metricCell(`${metrics.cpu.toFixed(1)}%`, cpuLevel(metrics.cpu)), metricCell(bytes(metrics.memory), metrics.memory < 64 * 1024 ** 2 ? 'quiet' : ''), metricCell(p.elapsed, 'meta'), metricCell(p.pid, 'meta'));
            const action = h('td', 'tasks-action');
            if (p.canStop) {
              const stop = text('button', `tasks-stop${p.forceAllowed ? ' force' : p.stopping ? ' stopping' : ''}`, p.forceAllowed ? 'Force stop…' : p.stopping ? 'Stopping…' : 'Stop…'); stop.type = 'button'; stop.disabled = busy || (p.stopping && !p.forceAllowed);
              stop.dataset.taskControl = `stop-${p.token}`; stop.onclick = () => confirmStop(p); action.append(stop);
            } else row.title ||= 'CliDeck does not stop this process';
            row.append(action); tbody.append(row);
          }
          if (isOpen) for (const child of childRows.sort(compare)) add(child, depth + 1);
        }
        for (const p of (children.get(0) || []).sort(compare)) add(p, 0);
        // An agent with no jobs is still listed (its own footprint); it takes one slot like a row.
        if (position === startPosition) { const index = position++; if (index >= page * 400 && index < (page + 1) * 400) displayed++; }
        if (displayed === beforeGroup) groupRow.remove();
      }
      const pages = Math.max(1, Math.ceil(position / 400));
      if (page >= pages) { page = pages - 1; render(); return; }
      pager.hidden = pages === 1; pageLabel.textContent = `Page ${page + 1} of ${pages}`;
      prevPage.disabled = page === 0; nextPage.disabled = page >= pages - 1;
      if (focus) [...tbody.querySelectorAll('button')].find(b => b.dataset.taskControl === focus)?.focus();
    }
    function confirmStop(p) {
      selected = p; confirmation.replaceChildren(); confirmation.hidden = false; confirmation.classList.toggle('force', !!p.forceAllowed);
      const title = text('strong', '', `${p.forceAllowed ? 'Force stop' : 'Stop'} PID ${p.pid}?`);
      const label = text('p', '', `This stops the job and its current child processes${p.session ? ` in ${p.project} / ${p.session}` : ''}. ${p.forceAllowed ? 'Unsaved work may be lost. ' : ''}The agent session stays open.`);
      const command = text('code', '', p.command);
      const cancel = text('button', 'tasks-btn', 'Cancel'); cancel.type = 'button'; cancel.onclick = () => { selected = null; confirmation.hidden = true; };
      const yes = text('button', 'tasks-stop-confirm', p.forceAllowed ? 'Force stop job' : 'Stop job'); yes.type = 'button'; yes.onclick = () => stop(p, yes, cancel);
      const buttons = h('div', 'tasks-confirm-actions'); buttons.append(cancel, yes);
      const body = h('div', 'tasks-confirm-body'); body.append(title, label, command);
      confirmation.append(body, buttons); cancel.focus();
    }
    async function stop(p, yes, cancel) {
      if (busy || selected !== p) return;
      busy = true; yes.disabled = cancel.disabled = true; clearTimeout(timer); render();
      try {
        const response = await fetch('/api/tasks/stop', { method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ token: p.token, force: p.forceAllowed }), signal: AbortSignal.timeout(8000) });
        const result = await response.json(); if (!response.ok) throw new Error(result.error || 'Stop failed.');
        if (!closed) message(result.message, result.failed?.length > 0);
      } catch (error) { if (!closed) message(error.name === 'TimeoutError' ? 'Stop result unknown. Refresh and check the process before retrying.' : error.message, true); }
      finally { busy = false; selected = null; confirmation.hidden = true; if (!closed) load(); }
    }
    function visibility() {
      clearTimeout(timer);
      if (document.hidden) { const request = pending; pending = null; request?.abort(); }
      else load();
    }
    function keydown(event) {
      if (event.isComposing) return;
      if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); if (selected && !busy) { selected = null; confirmation.hidden = true; } else dismiss(); }
      if (event.key === 'Tab') {
        const nodes = [...dialog.querySelectorAll('button, select')].filter(n => !n.disabled && n.getClientRects().length);
        if (event.shiftKey && document.activeElement === nodes[0]) { event.preventDefault(); nodes.at(-1)?.focus(); }
        else if (!event.shiftKey && document.activeElement === nodes.at(-1)) { event.preventDefault(); nodes[0]?.focus(); }
      }
    }
    function changed() { page = 0; selected = null; confirmation.hidden = true; filterProject = project.value; filterSession = agent.value; if (snapshot) { updateFilters(); } render(); }
    close.onclick = dismiss;
    overlay.addEventListener('mousedown', e => { if (e.target === overlay) dismiss(); });
    for (const control of [project, agent]) control.onchange = changed;
    refresh.onclick = load;
    document.addEventListener('visibilitychange', visibility);
    document.addEventListener('keydown', keydown, true);
    showState('Loading processes…'); render(); close.focus(); load();
  };
}
