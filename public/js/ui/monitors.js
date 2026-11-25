// Monitors: engine-run checks that wake a session when something changes. The engine owns the schedule; this
// window only shows the snapshot (GET on open, then the monitors.updated broadcast — no client polling) and
// sends explicit actions. Same window family as Task Manager.
import { h } from "../util.js";
import { store } from "../store.js";

const ATTENTION = new Set(["error", "uncertain", "waiting"]);
const ALERT = new Set(["error", "uncertain"]);      // the header dot: something only the person can sort out
const STATE = { watching: "Watching", checking: "Checking…", waiting: "Waiting", paused: "Paused", error: "Error", complete: "Done", uncertain: "Needs a look" };
const MODE = { change: "When the output changes", items: "When new items appear", "until-success": "Until the command succeeds" };
const text = (tag, cls, value) => { const node = h(tag, cls); node.textContent = value; return node; };
const svg = (path, size = 14) => `<svg width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${path}</svg>`;
const CLOSE = svg('<path d="m6 6 12 12M18 6 6 18"/>');
const CHEVRON = '<svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m9 6 6 6-6 6"/></svg>';

// ── plain-language time ─────────────────────────────────────────────────────────────────────────────────
const num = (v) => typeof v === "number" && Number.isFinite(v) ? v : null;
const clock = (ms) => new Date(ms).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
function day(ms, now = Date.now()) {
  const d = new Date(ms), today = new Date(now);
  if (d.toDateString() === today.toDateString()) return "today " + clock(ms);
  return d.toLocaleDateString([], { weekday: "short" }) + " " + clock(ms);
}
export function ago(ms, now = Date.now()) {
  const s = Math.round((now - ms) / 1000);
  if (s < 45) return "just now";
  if (s < 3600) return `${Math.max(1, Math.round(s / 60))} min ago`;
  if (s < 86400) return `${Math.round(s / 3600)} h ago`;
  return day(ms, now);
}
export function until(ms, now = Date.now()) {
  const s = Math.round((ms - now) / 1000);
  if (s <= 30) return "due now";
  if (s < 3600) return `in ${Math.max(1, Math.round(s / 60))} min`;
  if (s < 6 * 3600) return `in ${Math.round(s / 3600)} h`;
  return day(ms, now);
}
export function schedule(m, now = Date.now()) {
  const every = num(m.everyMs), at = num(m.at);
  if (every) {
    const s = every / 1000;
    const span = s < 60 ? `${Math.round(s)} sec` : s < 3600 ? `${+(s / 60).toFixed(1)} min` : s < 86400 ? `${+(s / 3600).toFixed(1)} h` : `${+(s / 86400).toFixed(1)} days`;
    return "every " + span.replace(/^1 days$/, "day").replace(/^1 h$/, "hour");
  }
  if (at) return "once, " + day(at, now);
  return "manual";
}
const stamp = (ms) => new Date(ms).toLocaleString();

// ── header button: dot only when something needs the person ────────────────────────────────────────────
function paintTrigger(trigger) {
  const list = store.monitors?.list || [], alerts = list.filter((m) => ALERT.has(m.state)).length + (store.monitors?.error ? 1 : 0);
  trigger.classList.toggle("mon-alert", alerts > 0);
  trigger.title = alerts ? `Monitors — ${alerts} need${alerts === 1 ? "s" : ""} attention` : "Monitors";
}

// Opened from the sidebar footer's app menu (openMonitors); the menu shows the attention count itself.
let opener = null;
export function openMonitors() { opener?.(); }
export function monitorsNeedingAttention() { return (store.monitors?.list || []).filter((m) => ALERT.has(m.state)).length + (store.monitors?.error ? 1 : 0); }
export function initMonitors() {
  const trigger = document.getElementById("monitors") || document.createElement("button");
  store.on("monitors", () => paintTrigger(trigger)); paintTrigger(trigger);
  let opened = false;
  opener = () => trigger.onclick();
  trigger.onclick = () => {
    if (opened) return;
    opened = true;
    let closed = false, filter = "all", snapshot = store.monitors, loading = !snapshot, loadError = "", updates = 0;
    let confirming = null, focusNext = "", minuteTimer = null, offline = !store.connected, generation = 0;
    const busy = new Set(), expanded = new Set(), returnFocus = document.activeElement;

    const overlay = h("div", "tasks-overlay");
    const dialog = h("section", "tasks-dialog mon-dialog"); dialog.setAttribute("role", "dialog");
    dialog.setAttribute("aria-modal", "true"); dialog.setAttribute("aria-label", "Monitors");
    const head = h("header", "tasks-head");
    const titles = h("div", "tasks-titles"); titles.append(text("h2", "", "Monitors"), text("p", "tasks-muted", "Checks that wake a session when something changes."));
    const close = h("button", "tasks-close", CLOSE); close.type = "button"; close.setAttribute("aria-label", "Close Monitors");
    const actions = h("div", "tasks-head-actions"); actions.append(close); head.append(titles, actions);
    const toolbar = h("div", "tasks-toolbar");
    const view = h("div", "tasks-seg"), counts = new Map(); view.setAttribute("role", "group"); view.setAttribute("aria-label", "Monitors to show");
    for (const [value, name] of [["all", "All"], ["attention", "Needs attention"], ["paused", "Paused"]]) {
      const option = h("button", "tasks-seg-b"); option.type = "button"; option.dataset.value = value;
      const count = text("span", "mon-seg-count", ""); counts.set(value, count);
      option.append(text("span", "", name), count);
      option.onclick = () => { if (filter !== value) { filter = value; confirming = null; render(); } };
      view.append(option);
    }
    toolbar.append(view);
    const notice = h("div", "tasks-notice error"); notice.hidden = true; notice.setAttribute("role", "alert");
    const offlineNote = text("div", "tasks-notice mon-offline", "Reconnecting to CliDeck… Monitor controls are paused until the latest state arrives.");
    offlineNote.setAttribute("role", "status");
    const scroll = h("div", "tasks-scroll");
    const list = h("div", "mon-list"); list.setAttribute("role", "list");
    const state = h("div", "tasks-state"); state.setAttribute("role", "status");
    scroll.append(list, state);
    const foot = h("footer", "tasks-foot"); foot.append(text("p", "", "Monitors run while CliDeck is running and this Mac is awake. Agents add them from the terminal."));
    dialog.append(head, toolbar, offlineNote, notice, scroll, foot); overlay.append(dialog); document.body.append(overlay);

    const showNotice = (value) => { notice.textContent = value; notice.hidden = !value; };
    const apply = (data) => {
      snapshot = { list: Array.isArray(data?.monitors) ? data.monitors : data?.list || [], error: typeof data?.error === "string" ? data.error : "" };
      loading = false; loadError = ""; offline = !store.connected; render();   // without live updates it stays frozen
    };

    function dismiss() {
      clearInterval(minuteTimer); offMonitors(); offConnection();
      document.removeEventListener("keydown", keydown, true);
      document.removeEventListener("visibilitychange", visibility);
      overlay.remove(); closed = true; opened = false; returnFocus?.focus?.();
    }
    // A reset/disconnect makes what is on screen stale: keep it visible but freeze every control until the
    // engine's own snapshot arrives again. Replies to requests sent before that are ignored.
    const offMonitors = store.on("monitors", (value) => {
      if (closed) return;
      if (!value) { offline = true; render(); return; }
      updates++; apply(value);
    });
    const offConnection = store.on("connection", (connected) => {
      if (closed) return;
      generation++;
      if (!connected) { offline = true; confirming = null; render(); } else load();
    });

    async function load() {
      const seen = updates, era = generation;
      try {
        const response = await fetch("/api/monitors", { cache: "no-store", signal: AbortSignal.timeout(8000) });
        if (response.status === 404) throw new Error("Restart the CliDeck engine when you are ready to enable Monitors. Your sessions have not been changed.");
        const data = await response.json();
        if (!response.ok) throw new Error(data.error || "Could not load monitors.");
        if (!closed && updates === seen && era === generation) apply(data);   // a broadcast or reconnect since then is newer
      } catch (error) {
        if (closed || snapshot || era !== generation) return;
        loading = false; loadError = error.name === "TimeoutError" ? "Monitors did not answer. Try again." : error.message; render();
      }
    }

    async function act(monitor, action, extra = {}) {
      if (busy.has(monitor.id) || offline) return;
      const seen = updates, era = generation;
      busy.add(monitor.id); showNotice(""); render();
      try {
        const response = await fetch("/api/monitors", { method: "POST", headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ action, id: monitor.id, ...extra }), signal: AbortSignal.timeout(8000) });
        const data = await response.json().catch(() => ({}));
        if (!response.ok) throw new Error(data.error || "Could not update this monitor.");
        if (!closed) {
          if (action === "remove") expanded.delete(monitor.id);
          if (updates === seen && era === generation) apply(data);   // otherwise a newer broadcast already shows the result
        }
      } catch (error) {
        if (!closed && era === generation) showNotice(error.name === "TimeoutError" ? "No answer from CliDeck. Check the monitor before trying again." : error.message);
      } finally { busy.delete(monitor.id); if (!closed) render(); }
    }

    // Closing a confirmation returns focus to the button that opened it.
    const closeConfirm = () => { focusNext = confirming ? confirming.action + "-" + confirming.id : ""; confirming = null; render(); };
    function visible(m) {
      return filter === "all" || (filter === "attention" ? ATTENTION.has(m.state) : m.paused === true || m.state === "paused");
    }

    function row(m, now) {
      const isBusy = busy.has(m.id) || offline, open = expanded.has(m.id), paused = m.paused === true || m.state === "paused";
      const item = h("div", "mon-row mon-" + (STATE[m.state] ? m.state : "watching")); item.setAttribute("role", "listitem");
      const toggle = h("button", "tasks-expand mon-expand", CHEVRON); toggle.type = "button";
      toggle.setAttribute("aria-expanded", String(open)); toggle.setAttribute("aria-label", `Details for ${m.name || "monitor"}`); toggle.dataset.control = "expand-" + m.id;
      toggle.onclick = () => { open ? expanded.delete(m.id) : expanded.add(m.id); render(); };
      const title = h("div", "mon-title");
      title.append(h("span", "mon-dot"), text("span", "mon-name", m.name || m.command || "Monitor"));
      const buttons = h("div", "mon-actions");
      const button = (label, control, disabled, onClick, cls = "") => {
        const b = text("button", "mon-act" + cls, label); b.type = "button"; b.disabled = isBusy || disabled; b.dataset.control = control + "-" + m.id; b.onclick = onClick; buttons.append(b); return b;
      };
      button("Check now", "check", paused || ["checking", "complete", "uncertain"].includes(m.state), () => act(m, "check"));
      if (paused) button("Resume", "resume", m.state === "uncertain", () => act(m, "resume")).title = m.state === "uncertain" ? "Clear the pending finding first" : "";
      else button("Pause", "pause", m.state === "complete", () => act(m, "pause"));
      // Possibly delivered: never resend blindly — the person clears it after looking at the session.
      if (m.state === "uncertain") button("Clear pending…", "acknowledge", false, () => { confirming = { id: m.id, action: "acknowledge" }; focusNext = "cancel-" + m.id; render(); }, " keep");
      button("Delete…", "remove", false, () => { confirming = { id: m.id, action: "remove" }; focusNext = "cancel-" + m.id; render(); }, " danger");
      item.append(toggle, title, buttons);

      const meta = h("div", "mon-meta");
      const part = (value, tip) => { const s = text("span", "", value); if (tip) s.title = tip; meta.append(s); };
      part(STATE[m.state] || "Watching");
      part(schedule(m, now));
      // One time per row: when it checks next, or (paused / done) when it last checked. The rest is on hover.
      const checked = num(m.lastCheckAt) ? "Last checked " + ago(m.lastCheckAt, now) + " · " + stamp(m.lastCheckAt) : "";
      if (num(m.nextCheckAt) && !paused && m.state !== "complete") part("next " + until(m.nextCheckAt, now), checked);
      else if (num(m.lastCheckAt)) part("checked " + ago(m.lastCheckAt, now), stamp(m.lastCheckAt));
      const wakes = Number(m.wakeCount) || 0;
      if (wakes) part(`${wakes} wake${wakes === 1 ? "" : "s"}`, num(m.lastFiredAt) ? "Last wake " + ago(m.lastFiredAt, now) + " · " + stamp(m.lastFiredAt) : "");
      if (Number(m.pendingCount) > 0) part(`${m.pendingCount} waiting to deliver`);
      item.append(meta);
      // Routine notes ("No change.", "Paused by you.") repeat the state; show the line only when it explains something.
      if (m.message && !["watching", "checking", "paused"].includes(m.state)) item.append(text("p", "mon-message", m.message));

      if (confirming?.id === m.id) {
        const remove = confirming.action === "remove", action = confirming.action;
        const card = h("div", "tasks-confirm mon-confirm" + (remove ? " force" : "")); card.setAttribute("role", "alertdialog");
        card.setAttribute("aria-label", remove ? "Confirm delete" : "Confirm clear pending");
        const body = h("div", "tasks-confirm-body");
        body.append(...(remove
          ? [text("strong", "", "Delete this monitor?"), text("p", "", "It stops checking and its history is removed. The session is not changed.")]
          : [text("strong", "", "Clear the pending finding?"), text("p", "", "Text may already be in the session. Clear this pending finding without sending it again?")]));
        const cancel = text("button", "tasks-btn", "Cancel"); cancel.type = "button"; cancel.dataset.control = "cancel-" + m.id;
        cancel.onclick = closeConfirm;
        const yes = text("button", remove ? "tasks-stop-confirm" : "tasks-btn mon-primary", remove ? "Delete monitor" : "Clear pending"); yes.type = "button"; yes.disabled = isBusy; yes.dataset.control = "confirm-" + m.id;
        yes.onclick = () => { confirming = null; act(m, action); };
        const row2 = h("div", "tasks-confirm-actions"); row2.append(cancel, yes);
        card.append(body, row2); item.append(card);
      }

      if (open) {
        const details = h("div", "mon-details"); details.id = "mon-details-" + m.id; toggle.setAttribute("aria-controls", details.id);
        const field = (label, value, mono = false) => { if (!value) return; const r = h("div", "mon-field"); r.append(text("span", "mon-label", label), text(mono ? "code" : "span", mono ? "mon-code" : "", value)); details.append(r); };
        field("Command", m.command, true);
        field("Folder", m.cwd, true);
        field("Trigger", (MODE[m.mode] || "") + (m.once ? " · runs once" : ""));
        field("Finding", m.lastFinding, true);
        const opt = h("label", "mon-opt"), box = h("input"); box.type = "checkbox"; box.checked = m.resumeSession === true; box.disabled = isBusy;
        box.dataset.control = "resume-session-" + m.id;
        box.addEventListener("change", () => act(m, "configure", { resumeSession: box.checked }));
        opt.append(box, text("span", "", "If this session is stopped, resume it to deliver findings"));
        details.append(opt);
        const history = (Array.isArray(m.history) ? [...m.history] : []).sort((a, b) => (num(b.at) || 0) - (num(a.at) || 0)).slice(0, 5);
        if (history.length) {
          const r = h("div", "mon-field"), log = h("ol", "mon-history");
          for (const entry of history) {
            const li = h("li", "mon-h-" + String(entry.status || "").replace(/[^a-z-]/gi, ""));
            li.append(text("time", "", num(entry.at) ? day(entry.at, now) : ""), text("span", "mon-h-status", entry.status || ""), text("span", "", entry.message || ""));
            if (num(entry.at)) li.firstChild.title = stamp(entry.at);
            log.append(li);
          }
          r.append(text("span", "mon-label", "Recent"), log); details.append(r);
        }
        item.append(details);
      }
      return item;
    }

    function render() {
      if (closed) return;
      offlineNote.hidden = !offline || !snapshot;
      dialog.classList.toggle("mon-stale", offline);
      const now = Date.now(), all = snapshot?.list || [];
      for (const option of view.children) {
        const value = option.dataset.value, count = value === "all" ? 0 : all.filter((m) => value === "attention" ? ATTENTION.has(m.state) : m.paused === true || m.state === "paused").length;
        option.setAttribute("aria-pressed", String(value === filter));
        counts.get(value).textContent = count ? String(count) : "";
      }
      if (snapshot?.error) showNotice("Monitors can’t be read or saved: " + snapshot.error + " Nothing was reset.");

      const focus = list.contains(document.activeElement) ? document.activeElement?.dataset?.control : null;
      list.replaceChildren();
      const rows = all.filter(visible);
      const message = loading ? "Loading monitors…" : loadError || (!all.length ? "No monitors yet. Ask an agent to watch something for you — for example, “tell me when the build finishes”."
        : !rows.length ? (filter === "attention" ? "Nothing needs your attention." : "No paused monitors.") : "");
      state.replaceChildren(); state.hidden = !message; list.hidden = !!message;
      if (message) {
        state.append(text("p", "", message));
        if (loadError) { const again = text("button", "tasks-btn", "Try again"); again.type = "button"; again.onclick = () => { loading = true; loadError = ""; render(); load(); }; state.append(again); }
      }
      const groups = new Map();
      for (const m of rows) {
        const key = m.sessionId || "";
        if (!groups.has(key)) groups.set(key, []);
        groups.get(key).push(m);
      }
      const order = (g) => [g[0].sessionName ? 0 : 1, String(g[0].projectName || ""), String(g[0].sessionName || "")];   // missing sessions last
      for (const [, group] of [...groups].sort((a, b) => { const x = order(a[1]), y = order(b[1]); return x[0] - y[0] || x[1].localeCompare(y[1]) || x[2].localeCompare(y[2]); })) {
        const first = group[0], header = h("div", "mon-group"), name = h("div", "tasks-group-name");
        if (first.sessionName) {
          if (first.projectName) name.append(text("span", "tasks-group-project", first.projectName), text("span", "tasks-group-sep", " / "));
          name.append(text("span", "tasks-group-session", first.sessionName));
        } else name.append(text("span", "", "Missing session"), text("span", "tasks-group-sep", " · "), text("span", "tasks-group-project", "its session was deleted"));
        header.append(name); list.append(header);
        for (const m of group) list.append(row(m, now));
      }
      const target = focusNext || focus; focusNext = "";
      if (target) [...list.querySelectorAll("button, input")].find((n) => n.dataset.control === target)?.focus();
    }

    function visibility() { if (document.visibilityState !== "hidden") render(); }
    function keydown(event) {
      if (event.isComposing) return;
      if (event.key === "Escape") {
        event.preventDefault(); event.stopPropagation();
        if (confirming) closeConfirm(); else dismiss();
      }
      if (event.key === "Tab") {
        const nodes = [...dialog.querySelectorAll("button, input")].filter((n) => !n.disabled && n.getClientRects().length);
        if (event.shiftKey && document.activeElement === nodes[0]) { event.preventDefault(); nodes.at(-1)?.focus(); }
        else if (!event.shiftKey && document.activeElement === nodes.at(-1)) { event.preventDefault(); nodes[0]?.focus(); }
      }
    }
    close.onclick = dismiss;
    overlay.addEventListener("mousedown", (e) => { if (e.target === overlay) dismiss(); });
    document.addEventListener("keydown", keydown, true);
    document.addEventListener("visibilitychange", visibility);
    minuteTimer = setInterval(() => { if (document.visibilityState !== "hidden") render(); }, 60000);   // relative times only; no network
    render(); close.focus(); load();
  };
}
