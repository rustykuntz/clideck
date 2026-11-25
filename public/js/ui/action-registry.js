// Host-owned plugin actions. Client plugins live in module Workers; this registry stores only declarative
// labels/placements and RPC callbacks. It never accepts plugin DOM or markup.

const PLACEMENTS = new Set([
  "terminal.context", "viewer.context", "terminal.header", "viewer.header",
  "session.menu", "project.menu", "toolbar", "terminal.voice",
  "plugin.settings",                 // buttons on the plugin's own card in Settings → Plugins (e.g. Configure)
  "terminal.primary",                // visible, labelled actions beside the terminal's voice controls
]);
const actions = new Map();                 // pluginId/actionId -> normalized action
const listeners = new Set();
let onError = () => {};

const keyOf = (pluginId, id) => pluginId + "/" + id;
const safeId = (value) => /^[a-z][a-z0-9-]{0,62}$/.test(String(value || ""));
function changed() { for (const fn of listeners) fn(); }
function clone(value) { try { return structuredClone(value); } catch { try { return JSON.parse(JSON.stringify(value)); } catch { return {}; } } }
function deepFreeze(value) {
  if (!value || typeof value !== "object" || Object.isFrozen(value)) return value;
  Object.freeze(value); for (const child of Object.values(value)) deepFreeze(child); return value;
}
function contextSnapshot(context) { return deepFreeze(clone(context || {})); }

export function registerAction(pluginId, definition, invoke) {
  const id = String(definition && definition.id || "");
  const label = String(definition && definition.label || "").trim();
  const placements = Array.isArray(definition && definition.placements)
    ? [...new Set(definition.placements.filter((p) => PLACEMENTS.has(p)))] : [];
  if (!safeId(pluginId) || !safeId(id) || !label || label.length > 120 || !placements.length || typeof invoke !== "function") return () => {};
  const key = keyOf(pluginId, id);
  if (actions.has(key)) return () => {};
  actions.set(key, {
    pluginId, id, label, placements,
    icon: String(definition.icon || "").slice(0, 24),
    iconOnly: definition.iconOnly === true,
    ...(typeof definition.pressed === "boolean" && { pressed: definition.pressed }),
    description: String(definition.description || "").slice(0, 240),
    hasWhen: definition.hasWhen === true,
    invoke,
  });
  changed();
  return () => { if (actions.delete(key)) changed(); };
}

export function unregisterActionsForPlugin(pluginId) {
  let any = false;
  for (const [key, action] of actions) if (action.pluginId === pluginId) { actions.delete(key); any = true; }
  if (any) changed();
}

export function hasActions(placement) {
  for (const action of actions.values()) if (action.placements.includes(placement)) return true;
  return false;
}

export async function resolveActions(placement, context) {
  const snapshot = contextSnapshot(context);
  const candidates = [...actions.values()].filter((action) => action.placements.includes(placement));
  const visible = await Promise.all(candidates.map(async (action) => {
    if (!action.hasWhen) return action;
    try { return (await action.invoke("match-action", action.id, snapshot)) ? action : null; }
    catch { return null; } // a broken availability predicate hides one action; it never breaks a core menu
  }));
  return visible.filter(Boolean).map((action) => ({ ...action, context: snapshot }));
}

// Context menus must decide preventDefault synchronously. Unconditional actions are safe to expose now;
// Worker-backed `when` predicates are primed ahead of time and consumed from the surface cache.
export function resolveImmediateActions(placement, context) {
  const snapshot = contextSnapshot(context);
  return [...actions.values()]
    .filter((action) => action.placements.includes(placement) && !action.hasWhen)
    .map((action) => ({ ...action, context: snapshot }));
}

export async function runAction(action, context) {
  if (!action) return false;
  try { await action.invoke("run-action", action.id, contextSnapshot(context || action.context)); return true; }
  catch (error) { onError(action.pluginId, error); return false; }
}

export function onActionsChange(fn) { listeners.add(fn); return () => listeners.delete(fn); }
export function setActionErrorHandler(fn) { onError = typeof fn === "function" ? fn : () => {}; }

// Small test seams: registrations remain private; tests assert normalized outcomes, not implementation maps.
export function __clearActionsForTest() { actions.clear(); changed(); }
