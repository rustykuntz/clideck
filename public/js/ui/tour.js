// The guided walkthrough (seven stops) and the "only what you have not seen" feature tips.
//
// One card and spotlight serve the walkthrough, unseen feature tips and user-requested help.
//
// ⚠️ Deliberately NOT built on menu.js. That popover is a SINGLETON that closes on outside-click and scroll,
// and every stop here points at a control which itself opens a menu.js popover (New project, New session, the
// settings sub-menus). Sharing the singleton would mean the tour closing the thing it just told you to press —
// a dead end. This module owns its own positioning and never dismisses on a click landing elsewhere: the real
// controls stay live, which is the whole point of an interactive walkthrough.
//
// The spotlight is ONE element. `box-shadow: <ring>, 0 0 0 100vmax <dim>` paints the ring and the page dimming
// from the same box, so moving between stops is a single animated rect rather than four edges kept in sync.
// A stop with no usable anchor collapses that box to a zero-size point — the dimming still covers the viewport,
// the ring is hidden, and the card centres itself with the stop's own fallback copy.
//
// ⚠️ A HIDDEN ELEMENT REPORTS AN ALL-ZERO RECT. The ask and preview stops live in the terminal header and the
// tab strip, neither of which exists without a live session, so "is there an anchor" is a question about the
// RECT, never about the node. Both carry fallback copy that still teaches the idea with nothing on screen.
import { store } from "../store.js";
import { updateConfig } from "../ws.js";
import { openSettingsAt, closeSettings, settingsSection } from "./settings.js";

// Stable, release-independent ids. They are persisted forever, so they are named after WHAT the tip is about,
// never after a version — a tip is shown once per user, and there is no version-based replay.
export const TIP_ABOUT_ME = "about-me";
export const TIP_GUIDED_TOUR = "guided-tour";
const RELEASE_TIPS = [TIP_ABOUT_ME, TIP_GUIDED_TOUR];

const SHEET_WIDTH = 720;    // below this the card docks to the bottom edge instead of tracking its anchor
const MARGIN = 14;
const GAP = 12;
const SETTLE_MS = 460;      // an opening overlay ANIMATES its box; re-measure until it has come to rest

const byId = (id) => document.getElementById(id);

// ── the seven stops ───────────────────────────────────────────────────────────
// `enter` puts the app into the state the stop describes (opens Settings, switches category). It runs the same
// code the user's own click runs — no stop stages a fake app.
const STOPS = [
  {
    id: "projects",
    anchor: () => byId("proj-btn"),
    title: "Agents in a project",
    body: "Agents in a project share a folder and can send each other tasks and replies, even across providers, without you relaying messages.",
    fallback: "Agents in a project share a folder and can send each other tasks and replies, even across providers, without you relaying messages.",
    enter: () => closeSettings(),
  },
  {
    id: "session",
    anchor: () => byId("new-btn"),
    title: "Start a session",
    body: "Pick an agent — Claude, Codex, Gemini, or a plain shell — and it opens in a real terminal on the right. Sessions keep running when you switch away.",
    fallback: "The + button beside the project list starts a session: pick an agent and it opens in a real terminal.",
  },
  {
    id: "prompts",
    anchor: () => byId("prompts-btn"),
    title: "Saved prompts",
    body: "Save project introductions, links and instructions in Prompts, then type // in any terminal to find and reuse them.",
    fallback: "Save project introductions, links and instructions in Prompts, then type // in any terminal to find and reuse them.",
  },
  {
    id: "ask",
    anchor: () => byId("th-name"),
    title: "Ask another agent",
    body: "Type @@ to choose another agent, then tell your agent what to ask it; the agents handle the request and reply.",
    fallback: "Open two agent sessions, then type @@ in one to choose the other and tell your agent what to ask it.",
    enter: () => closeSettings(),
  },
  {
    // ⚠️ The tab strip is in the DOM from the start but sits inside the hidden right pane, so with no session it
    // measures 0×0 and this falls back — the same rect-not-node rule as the ask stop above.
    id: "preview",
    anchor: () => byId("pane-tabs"),
    title: "View their work inside CliDeck",
    body: "Ask an agent to show a Markdown report, HTML page, image, video, PDF, or diff. It opens in a tab inside CliDeck. You can also drop files onto the tab strip.",
    fallback: "Ask an agent to show a Markdown report, HTML page, image, video, PDF, or diff. It opens in a tab inside CliDeck. You can also drop files onto the tab strip.",
    enter: () => closeSettings(),
  },
  {
    id: "notifications",
    anchor: () => settingsSection("delivery"),
    title: "Hear what happens",
    body: "One cue when an agent goes idle, another when an agent sends work to another agent.",
    fallback: "Settings ▸ Notifications: one cue when an agent goes idle, another when an agent sends work to another agent.",
    enter: () => openSettingsAt("notifications"),
  },
  {
    id: "agents",
    anchor: () => settingsSection("builtin"),
    title: "Control how agents launch",
    body: "Choose which agents appear in the picker, and open Advanced to add the flags each one starts with. Your own commands go under Custom agents below.",
    fallback: "Settings ▸ CLI Agents chooses which agents appear, and Advanced sets the flags each one launches with.",
    enter: () => openSettingsAt("agents"),
  },
];

// ── feature tips ────────────────────────────────────────────────────────────
// Shown one per app load, in order, and only when the id is not already in seenTips. A new feature appends an
// entry; nobody is ever shown a tip twice, and nothing replays because a version changed.
// Introduce the workspace before optional profile setup when both tips are unseen.
const TIPS = [
  {
    id: TIP_GUIDED_TOUR,
    anchor: () => byId("settings-btn"),
    title: "There is a tour now",
    body: "Seven quick stops cover projects, sessions, saved prompts, asking agents, previews, notifications and launch options; replay them in Settings ▸ General.",
    fallback: "Settings ▸ General ▸ Take the tour walks through the deck in seven quick stops.",
    cta: { label: "Take the tour", run: () => startTour({ replay: true }) },
  },
  {
    id: TIP_ABOUT_ME,
    anchor: () => byId("settings-btn"),
    title: "Tell agents who you are",
    body: "An optional profile now lives in Settings ▸ General — your name, time zone and notes, shared with supported agents when a session starts.",
    fallback: "Settings ▸ General now has About me: an optional name, time zone and notes, shared with supported agents when a session starts.",
    cta: { label: "Open About me", run: () => { openSettingsAt("general"); scrollTo(settingsSection("about")); } },
  },
];

let live = null;      // { mode:'tour'|'tip'|'help', stops, index, els, … } while a card is on screen
let autoRan = false;  // the automatic decision is made ONCE per page load, on the first config frame

// ── persistence ─────────────────────────────────────────────────────────────
// Optimistic local writes so a dismissed tip cannot flash back before the engine's echo. seenTips is only ever
// ADDED to: the engine merges, and no path here clears it — replaying the tour must not un-see a tip.
const union = (a, b) => [...new Set([...(a || []), ...(b || [])])];

function saveCompleted() {
  const next = { ...(store.onboarding || {}), completed: true, seenTips: union(store.seenTips, RELEASE_TIPS) };
  store.setOnboarding(next);
  updateConfig({ onboarding: { completed: true, seenTips: RELEASE_TIPS } });
}
function markTipSeen(id) {
  if (!id) return;
  store.setOnboarding({ ...(store.onboarding || {}), seenTips: union(store.seenTips, [id]) });
  updateConfig({ onboarding: { seenTips: [id] } });   // engine merges; sending only the delta keeps it a union
}

// ── entry points ────────────────────────────────────────────────────────────
export function initTour() {
  byId("team-help-btn")?.addEventListener("click", openAskHelp);
  store.on("config", () => {
    if (autoRan) return;
    autoRan = true;
    // ⚠️ ABSENT is not false. A config with no `onboarding` key is an existing or unknown install and gets a
    // quiet tip at most — the engine seeds completed:false on a fresh one, and that is the ONLY auto-tour.
    // ⚠️ BOTH TIMERS DECIDE AGAIN WHEN THEY FIRE. The state that justified them is re-read on arrival, because
    // in between: another tab can complete onboarding (the engine echoes it here), or the user can press
    // "Take the tour" themselves. Replacing a tour the user just started with an identical one restarts it at
    // stop 1 under their hands, and re-running a tour another tab finished is the exact thing `completed` buys.
    if (store.onboarding && store.onboarding.completed === false) {
      setTimeout(() => { if (live || store.onboardingCompleted) return; startTour({}); }, 420);
    } else {
      setTimeout(() => { if (live) return; maybeShowTip(); }, 1600);
    }
  });
}

export function startTour(opts = {}) {
  close();
  begin({ mode: "tour", stops: STOPS, index: Math.min(Math.max(0, opts.from | 0), STOPS.length - 1) });
}

// User-requested help reuses the Ask stop without changing onboarding or seen tips.
export function openAskHelp() {
  close();
  const ask = STOPS.find((stop) => stop.id === "ask");
  const body = resolveAnchor(ask) ? ask.body : ask.fallback;
  begin({ mode: "help", stops: [{ ...ask, body, anchor: () => byId("team-help-btn") }], index: 0 });
}

export function maybeShowTip() {
  if (live) return null;
  const seen = new Set(store.seenTips);
  const tip = TIPS.find((t) => !seen.has(t.id));
  if (!tip) return null;
  begin({ mode: "tip", stops: [tip], index: 0 });
  return tip.id;
}

export function isTourOpen() { return !!live; }
export function closeTour() { close(); }

// Introspection for the gates: what is on screen right now, without reading class names off the DOM.
export function __tourForTest() {
  if (!live) return null;
  const stop = live.stops[live.index];
  return { mode: live.mode, id: stop.id, index: live.index, total: live.stops.length, anchored: !!live.anchor, sheet: live.sheet };
}

// ── the card ────────────────────────────────────────────────────────────────
function begin(state) {
  // ⚠️ close() lets the old root linger for its fade. A tour started inside that window would leave TWO cards
  // in the document — the retiring one first in DOM order, so every query would answer about the wrong card.
  for (const stale of document.querySelectorAll(".tour")) stale.remove();
  live = { ...state, els: build(), returnFocus: focusable(document.activeElement), anchor: null, sheet: false, settleUntil: 0, raf: 0 };
  document.body.classList.add("tour-active");
  document.addEventListener("keydown", onKey, true);
  window.addEventListener("resize", onReflow);
  document.addEventListener("scroll", onReflow, true);
  watchOverlays();
  render();
  requestAnimationFrame(() => { if (live) live.els.root.classList.add("show"); });
}

function build() {
  const root = el("div", "tour");
  const spot = el("div", "tour-spot");
  const pop = el("div", "tour-pop");
  pop.setAttribute("role", "dialog");
  pop.setAttribute("aria-live", "polite");
  const content = el("div", "tour-content");   // rebuilt per stop, so the copy CROSS-FADES rather than snapping
  const acts = el("div", "tour-acts");
  const skip = btn("tour-btn tour-quiet", "Skip");
  const spacer = el("div", "tour-sp");
  const back = btn("tour-btn", "Back");
  const next = btn("tour-btn tour-primary", "Next");
  acts.append(skip, spacer, back, next);
  pop.append(content, acts);
  root.append(spot, pop);
  document.body.appendChild(root);
  skip.addEventListener("click", () => finish());
  back.addEventListener("click", () => go(-1));
  next.addEventListener("click", () => go(1));
  return { root, spot, pop, content, acts, skip, back, next };
}

function render() {
  if (!live) return;
  const stop = live.stops[live.index];
  const { els } = live;
  const tour = live.mode === "tour";
  const last = live.index === live.stops.length - 1;

  if (stop.enter) { try { stop.enter(); } catch { /* a stop must never strand the card */ } }
  live.anchor = resolveAnchor(stop);
  if (live.anchor) scrollTo(live.anchor);

  const wording = live.anchor ? stop.body : (stop.fallback || stop.body);
  const body = text("tour-body", wording);
  // Only the Ask shortcut needs emphasis; all surrounding copy stays literal text.
  const shortcut = stop.id === "ask" ? wording.indexOf("@@") : -1;
  if (shortcut >= 0) {
    const key = el("kbd", "tour-key"); key.textContent = "@@";
    body.replaceChildren(document.createTextNode(wording.slice(0, shortcut)), key,
      document.createTextNode(wording.slice(shortcut + 2)));
  }
  const content = el("div", "tour-content");
  content.append(
    text("tour-eyebrow", tour ? "Getting started · " + (live.index + 1) + " of " + live.stops.length : live.mode === "help" ? "CliDeck Ask" : "New"),
    text("tour-title", stop.title),
    body,
  );
  els.content.replaceWith(content);
  els.content = content;
  els.pop.classList.toggle("tour-tip", !tour);
  els.root.classList.toggle("tour-unanchored", !live.anchor);

  els.back.hidden = !tour || live.index === 0;
  els.skip.textContent = tour ? "Skip" : "Got it";
  els.next.hidden = tour ? false : !stop.cta;
  els.next.textContent = tour ? (last ? "Done" : "Next") : (stop.cta ? stop.cta.label : "");

  live.settleUntil = Date.now() + SETTLE_MS;   // the surface a stop just opened is still animating its box
  settle();
  (els.next.hidden ? els.skip : els.next).focus({ preventScroll: true });
}

function go(delta) {
  if (!live) return;
  const stop = live.stops[live.index];
  if (live.mode === "tip") {                       // "Next" on a tip is its call to action, then it is seen
    markTipSeen(stop.id);
    close();
    if (stop.cta) { try { stop.cta.run(); } catch { /* a tip never blocks on its own shortcut */ } }
    return;
  }
  const next = live.index + delta;
  if (next < 0) return;
  if (next >= live.stops.length) { finish(); return; }
  live.index = next;
  render();
}

// Done and Skip land in the same place on purpose: both mean "I am not being walked through this again".
function finish() {
  if (!live) return;
  if (live.mode === "tip") markTipSeen(live.stops[live.index].id);
  else if (live.mode === "tour") saveCompleted();
  close();
}

function close() {
  if (!live) return;
  const { root } = live.els;
  if (live.raf) cancelAnimationFrame(live.raf);
  if (live.observer) live.observer.disconnect();
  document.removeEventListener("keydown", onKey, true);
  window.removeEventListener("resize", onReflow);
  document.removeEventListener("scroll", onReflow, true);
  document.body.classList.remove("tour-active");
  // Focus is sitting on a button that is about to leave the document. Hand it back to whatever had it when the
  // card opened, and settle for the body only when that element is gone too.
  const inCard = document.activeElement && root.contains && root.contains(document.activeElement);
  const back = live.returnFocus && live.returnFocus.isConnected ? live.returnFocus : document.body;
  live = null;
  if (inCard && back && typeof back.focus === "function") back.focus();
  root.classList.remove("show");
  setTimeout(() => root.remove(), 220);           // outlast the fade, then take the node with it
}

// ── anchoring + placement ───────────────────────────────────────────────────
function resolveAnchor(stop) {
  let node = null;
  try { node = stop.anchor ? stop.anchor() : null; } catch { node = null; }
  if (!node || !node.isConnected) return null;
  const r = rectOf(node);
  // ⚠️ A hidden node, and every child of one, measures 0×0 — which reads as the top-left corner of the screen.
  // No usable box means no anchor, and the stop falls back rather than spotlighting nothing.
  return r && (r.width > 1 || r.height > 1) ? node : null;
}

function rectOf(node) {
  if (!node || typeof node.getBoundingClientRect !== "function") return null;
  const r = node.getBoundingClientRect();
  return r ? { left: r.left, top: r.top, width: r.width, height: r.height, right: r.left + r.width, bottom: r.top + r.height } : null;
}

// Reduced motion is a promise about MOVEMENT, not only about CSS. A smooth scroll is script-driven travel, so
// it has to answer the same preference the stylesheet does.
export function reducedMotion() {
  try { return typeof matchMedia === "function" && matchMedia("(prefers-reduced-motion: reduce)").matches; } catch { return false; }
}
function scrollTo(node) {
  if (!node || typeof node.scrollIntoView !== "function") return;
  try { node.scrollIntoView({ block: "center", behavior: reducedMotion() ? "auto" : "smooth" }); } catch { node.scrollIntoView(); }
}

function viewport() {
  const d = document.documentElement || {};
  return { w: d.clientWidth || (typeof window !== "undefined" ? window.innerWidth : 0) || 0, h: d.clientHeight || (typeof window !== "undefined" ? window.innerHeight : 0) || 0 };
}

function position() {
  if (!live) return;
  const { spot, pop } = live.els;
  const vw = viewport().w, vh = viewport().h;
  const r = live.anchor ? rectOf(live.anchor) : null;

  // The dimming is this element's outer shadow, so a stop with no anchor collapses it to a point at the centre:
  // the page still dims, and there is simply no hole.
  if (r && (r.width > 1 || r.height > 1)) {
    const pad = 6;
    setBox(spot, r.left - pad, r.top - pad, r.width + pad * 2, r.height + pad * 2);
  } else {
    setBox(spot, vw / 2, vh / 2, 0, 0);
  }

  const sheet = vw < SHEET_WIDTH;
  live.sheet = sheet;
  pop.classList.toggle("tour-sheet", sheet);
  if (sheet) { pop.style.left = ""; pop.style.top = ""; return; }   // docked by CSS; inline coordinates would fight it

  const w = pop.offsetWidth || 320, h = pop.offsetHeight || 160;
  let top, left;
  if (!r) { left = (vw - w) / 2; top = (vh - h) / 2; }
  else {
    const below = vh - MARGIN - (r.bottom + GAP);
    top = h <= below ? r.bottom + GAP : r.top - GAP - h;
    left = r.left + r.width / 2 - w / 2;
  }
  top = clamp(top, MARGIN, Math.max(MARGIN, vh - MARGIN - h));
  left = clamp(left, MARGIN, Math.max(MARGIN, vw - MARGIN - w));
  pop.style.left = Math.round(left) + "px";
  pop.style.top = Math.round(top) + "px";
}

function setBox(node, left, top, width, height) {
  node.style.left = Math.round(left) + "px";
  node.style.top = Math.round(top) + "px";
  node.style.width = Math.round(width) + "px";
  node.style.height = Math.round(height) + "px";
}
const clamp = (v, lo, hi) => Math.min(Math.max(v, lo), hi);

// A settings overlay that has just opened is still sliding its modal into place, and scrollIntoView is smooth:
// measuring once would pin the spotlight to where the anchor WAS. Re-measure every frame until it comes to rest.
function settle() {
  if (!live) return;
  position();
  if (Date.now() >= live.settleUntil) { live.raf = 0; return; }
  live.raf = requestAnimationFrame(settle);
}
function onReflow() {
  if (!live || live.raf) return;
  live.raf = requestAnimationFrame(() => { if (live) { live.raf = 0; position(); } });
}

// A menu.js popover or a modal opened FROM the control a stop points at would be covered by the card. Rather
// than fight for the same space, the card steps back — and comes straight back when that surface closes. No
// click is ever swallowed: the card is pointer-transparent while it is faded.
function watchOverlays() {
  if (typeof MutationObserver !== "function") return;
  const sync = () => {
    if (!live) return;
    const hadLibrary = live.els.root.classList.contains("tour-library-open");
    const libraryOpen = !!document.querySelector(".pl-overlay");
    const busy = overlaid();
    live.els.root.classList.toggle("tour-faded", busy);
    live.els.root.classList.toggle("tour-library-open", libraryOpen);
    if (hadLibrary && !libraryOpen && document.activeElement === document.body) {
      (live.els.next.hidden ? live.els.skip : live.els.next).focus({ preventScroll: true });
    }
  };
  live.observer = new MutationObserver(sync);
  live.observer.observe(document.body, { childList: true, subtree: false, attributes: true, attributeFilter: ["class"] });
  sync();
}

// A surface opened ON TOP of the card owns dismissal until it is gone — a menu.js popover, or any modal that
// raises cd-modal-open. Finishing the tour underneath one would leave the user staring at a popover whose
// context just vanished.
function overlaid() { return !!document.querySelector(".menu, .pl-overlay") || document.body.classList.contains("cd-modal-open"); }

function onKey(e) {
  if (!live) return;
  if (e.key === "Escape") {
    if (overlaid()) return;                       // the popover on top answers Escape first
    e.preventDefault(); e.stopPropagation(); finish(); return;
  }
  if (live.mode !== "tour") return;
  // ⚠️ ARROWS ARE SCOPED TO THE CARD. The controls a stop points at stay live — a caret in the About me notes,
  // an open native select, xterm itself — and a document-level arrow handler would steal every one of them.
  if (!live.els.pop.contains(document.activeElement)) return;
  if (e.key === "ArrowRight") { e.preventDefault(); go(1); }
  else if (e.key === "ArrowLeft") { e.preventDefault(); go(-1); }
}

// Where focus should land when the card goes away. The card's own buttons are about to be removed, so anything
// inside it is not an answer.
function focusable(node) {
  if (!node || typeof node.focus !== "function") return null;
  if (live && live.els.root.contains && live.els.root.contains(node)) return null;   // never hand focus back INTO the card
  return node;
}

function el(tag, cls) { const n = document.createElement(tag); n.className = cls; return n; }
function text(cls, value) { const n = el("div", cls); n.textContent = value; return n; }
function btn(cls, label) { const b = el("button", cls); b.type = "button"; b.textContent = label; return b; }
