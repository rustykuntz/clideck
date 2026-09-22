// Central hotkey + clipboard layer (v2 parity for v1 hotkeys.js). Owns the per-terminal key pipeline and a
// capture-phase global dispatcher that future features/plugins register combos into.
//
// Per-terminal pipeline order (matches v1 hotkeys.js:115-158) — the // prompt trigger owns its key window,
// so the terminal-native keys are decided BEFORE it, and the registry catches whatever survives:
//   OSC52 (output) → Ctrl+C-copy → Shift+Enter → clear/Ctrl+K → // interception → registry
import { send } from "../ws.js";
import { pastePayload } from "./paste.js";
import { toast } from "./toast.js";
import { store } from "../store.js";
import { handleTerminalKey } from "./prompts.js";

const registry = new Map();                 // normalized combo → { pluginId, callback }
const MAX_OSC52_BYTES = 512 * 1024;
const MULTILINE_PROVIDERS = new Set(["claude-code", "antigravity"]);
const IS_MAC = /Mac|iPhone|iPad/i.test((typeof navigator !== "undefined" && (navigator.platform || navigator.userAgent)) || "");
export function ctrlVPasteEnabled() {
  try { return localStorage.getItem("clideck.ctrlVPaste") === "true"; } catch { return false; }
}
const writeClipboard = (text) => { try { if (navigator.clipboard && navigator.clipboard.writeText) return navigator.clipboard.writeText(text); } catch {} return null; };

// macOS only binds Cmd+V to native Paste. Guard the asynchronous read against focus/session changes.
async function pasteOnMac(term) {
  const session = store.active(), target = term.textarea, pid = session?.pid;
  if (!session || session.live === false || document.activeElement !== target) return;
  try {
    const text = await navigator.clipboard.readText();
    if (!text || store.active() !== session || session.pid !== pid || session.live === false || document.activeElement !== target) return;
    if (session.bracketedPaste ?? term.modes.bracketedPasteMode) send({ type: "input", sessionId: session.id, data: pastePayload(text) });
    else term.paste(text);
  } catch { toast({ type: "error", body: "Could not read the clipboard. Use Cmd+V to paste." }); }
}

// ── combo registry (Cmd ≡ Ctrl) ────────────────────────────────────────────────
// F1 THROUGH F24 — the keys a user may bind BARE, because they do not type: a bare letter or digit shortcut
// would swallow ordinary input. The recorder and this file must agree on that set exactly; if the recorder
// accepts a key the registry spells differently, the shortcut saves and then never fires, which is worse
// than refusing it.
const FUNCTION_KEY = /^F([1-9]|1[0-9]|2[0-4])$/;
export function isFunctionKey(code) { return FUNCTION_KEY.test(String(code || "")); }
// `code` is the key's PHYSICAL identity and is what the registry is keyed on. An event can arrive without a
// usable one ("" or "Unidentified"); `key` still names a function key, and for F1-F24 the two spellings are
// identical, so the fallback there cannot be ambiguous. It is deliberately NOT a general `key` fallback:
// `key` is layout- and shift-dependent ("A" vs "a" vs "ä") and would make the registry unkeyable.
export function hotkeyCodeFromEvent(e) {
  const code = String((e && e.code) || "");
  if (code && code !== "Unidentified") return code;
  const key = String((e && e.key) || "");
  return isFunctionKey(key) ? key : code;
}
function normalizeEvent(e) {
  const parts = [];
  if (e.ctrlKey || e.metaKey) parts.push("Ctrl");   // Cmd is folded into Ctrl
  if (e.altKey) parts.push("Alt");
  if (e.shiftKey) parts.push("Shift");
  parts.push(hotkeyCodeFromEvent(e));
  return parts.join("+");
}
// Normalize a user combo string ("Alt+Ctrl+F4" / "Cmd+K") into canonical e.code form ("Ctrl+Alt+F4" / "Ctrl+KeyK").
function normalizeCombo(combo) {
  const parts = String(combo).split("+").map((p) => p.trim()).filter(Boolean);
  let key = parts[parts.length - 1] || "";
  if (/^f\d+$/i.test(key)) key = key.toUpperCase();
  else if (/^[a-z]$/i.test(key)) key = "Key" + key.toUpperCase();
  else if (/^[0-9]$/.test(key)) key = "Digit" + key;
  else if (key.toLowerCase() === "escape") key = "Escape";
  else if (key.toLowerCase() === "space") key = "Space";
  else if (key.toLowerCase() === "enter") key = "Enter";
  else if (key.toLowerCase() === "tab") key = "Tab";
  const mods = [];
  for (const p of parts.slice(0, -1)) {
    const l = p.toLowerCase();
    if (l === "ctrl" || l === "cmd" || l === "meta") mods.push("Ctrl");
    else if (l === "alt") mods.push("Alt");
    else if (l === "shift") mods.push("Shift");
  }
  const sorted = ["Ctrl", "Alt", "Shift"].filter((m) => mods.includes(m));
  sorted.push(key);
  return sorted.join("+");
}
function isInput(t) { return !!t && (t.tagName === "INPUT" || t.tagName === "TEXTAREA" || t.isContentEditable || (t.closest && t.closest("[data-hotkey-recorder]"))); }
function dispatch(e) {
  const entry = registry.get(normalizeEvent(e));
  if (!entry) return true;
  e.preventDefault(); e.stopPropagation();
  entry.callback(e);
  return false;
}

// Catch registered combos OUTSIDE a terminal — skip text inputs, and always let a bare Ctrl+K pass (shell).
if (typeof document !== "undefined" && document.addEventListener) {
  document.addEventListener("keydown", (e) => {
    if (isInput(e.target)) return;
    if (e.ctrlKey && !e.metaKey && !e.altKey && !e.shiftKey && e.code === "KeyK") return;
    dispatch(e);
  }, true);
}

export function registerHotkey(pluginId, combo, callback) {
  const norm = normalizeCombo(combo);
  const existing = registry.get(norm);
  if (existing) {                                        // duplicate: warn, first registration wins
    if (typeof console !== "undefined") console.warn(`[hotkeys] "${norm}" already registered by ${existing.pluginId}, ignoring ${pluginId}`);
    return false;
  }
  registry.set(norm, { pluginId, callback });
  return true;
}
export function hotkeyComboFromEvent(event) { return normalizeEvent(event); }
export function hotkeyConflict(combo, pluginId) {
  const norm = normalizeCombo(combo), entry = registry.get(norm);
  return entry && entry.pluginId !== pluginId ? { combo: norm, pluginId: entry.pluginId } : null;
}
export function unregisterHotkey(pluginId, combo) {
  const norm = normalizeCombo(combo);
  const entry = registry.get(norm);
  if (entry && entry.pluginId === pluginId) registry.delete(norm);
}
export function unregisterAllForPlugin(pluginId) {
  for (const [combo, entry] of registry) if (entry.pluginId === pluginId) registry.delete(combo);
}

// ── OSC 52 → system clipboard ───────────────────────────────────────────────────
// A terminal program writing `\x1b]52;c;<base64>\x07` gets its payload copied. Queries ('?') and
// oversized payloads are ignored (v1 hotkeys.js:88-110).
export function decodeOsc52(data) {
  const parts = String(data || "").split(";");
  if (parts.length < 2) return "";
  const encoded = parts.slice(1).join(";").trim();
  if (!encoded || encoded === "?" || encoded.length > MAX_OSC52_BYTES) return "";
  try {
    const binary = atob(encoded);
    return new TextDecoder().decode(Uint8Array.from(binary, (ch) => ch.charCodeAt(0)));
  } catch { return ""; }
}
function attachClipboardOscHandler(term, isReplaying) {
  if (!term.parser || !term.parser.registerOscHandler) return;
  term.parser.registerOscHandler(52, (data) => {
    // History restores terminal pixels, never terminal side effects. The write counter stays active until
    // xterm's parse callback, so overlapping async replay writes cannot reopen the clipboard path early.
    if (isReplaying && isReplaying()) return true;
    const text = decodeOsc52(data);
    if (!text) return false;
    const p = writeClipboard(text);
    return p ? p.then(() => true, () => false) : false;
  });
}

// ── per-terminal key pipeline ────────────────────────────────────────────────────
// getProvider() returns the CURRENT active session's provider id (the pane is shared across sessions in v2,
// so Shift+Enter's claude-code scoping is resolved live, not captured at attach time).
export function attachToTerminal(term, getProvider, isReplaying) {
  attachClipboardOscHandler(term, isReplaying);
  term.attachCustomKeyEventHandler((e) => {
    if (e.type !== "keydown") return true;

    // Let the browser deliver its native paste event to the existing terminal paste handler.
    // Non-Mac keeps native focus/permission handling; Mac needs an explicit clipboard read.
    if (!e.isComposing && e.keyCode !== 229 && e.ctrlKey && !e.metaKey && !e.altKey && !e.shiftKey && e.code === "KeyV" && ctrlVPasteEnabled()) {
      if (IS_MAC) { e.preventDefault(); pasteOnMac(term); }
      return false;
    }

    // 1. Ctrl+C copies a selection instead of sending SIGINT — ONLY when a selection exists; otherwise it
    //    passes through untouched so ^C still interrupts the shell (v1 :117-128).
    if (e.ctrlKey && !e.metaKey && !e.altKey && !e.shiftKey && e.code === "KeyC" && term.hasSelection && term.hasSelection()) {
      e.preventDefault();
      const sel = term.getSelection ? term.getSelection() : "";
      if (sel) writeClipboard(sel);
      return false;
    }

    // 2. Shift+Enter → CSI-u multiline newline for Claude-compatible input screens (others keep plain Enter).
    if (e.key === "Enter" && e.shiftKey && !e.ctrlKey && !e.altKey && !e.metaKey && getProvider && MULTILINE_PROVIDERS.has(getProvider())) {
      e.preventDefault();
      term.input("\x1b[13;2u");
      return false;
    }

    // 3. Clear scrollback: Cmd+K (mac) / Ctrl+Shift+K (win/linux) — a distinct combo from bare Ctrl+K (Increment 1).
    if (e.key === "k" || e.key === "K") {
      const clear = IS_MAC ? (e.metaKey && !e.ctrlKey && !e.altKey) : (e.ctrlKey && e.shiftKey && !e.altKey);
      if (clear) { e.preventDefault(); term.clear(); return false; }
    }
    // 4. Ctrl+K protection: a bare Ctrl+K reaches the shell as \x0b, never shadowed by the clear (v1 :144-153).
    if (e.ctrlKey && !e.metaKey && !e.altKey && !e.shiftKey && e.code === "KeyK") {
      e.preventDefault();
      term.input("\x0b");
      return false;
    }

    // 5. The // prompt trigger owns its key window next (opens/captures the dropdown).
    if (handleTerminalKey(e) === false) return false;

    // 6. Whatever survives → the registered-combo dispatcher.
    return dispatch(e);
  });
}
