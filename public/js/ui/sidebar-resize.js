// Resizable sidebar (E1): a drag handle on the sidebar/terminal divider sets the --sidebar-w CSS var, clamped
// to [MIN, MAX]; double-click resets to DEFAULT; the width persists in localStorage['clideck.sidebarW'] (the
// same client-pref pattern as the theme). A tiny inline <head> script pre-stamps the saved width before first
// paint (no resize flash); this module owns the drag interaction and re-affirms that stamp. The terminal's own
// ResizeObserver refits xterm as .main reflows, so there's nothing to notify here.
const KEY = "clideck.sidebarW";
export const SIDEBAR_DEFAULT = 340, SIDEBAR_MIN = 240, SIDEBAR_MAX = 560;

const clamp = (px) => Math.max(SIDEBAR_MIN, Math.min(SIDEBAR_MAX, Math.round(px)));
let cur = SIDEBAR_DEFAULT;
function applyWidth(px) { cur = clamp(px); document.documentElement.style.setProperty("--sidebar-w", cur + "px"); }

export function sidebarWidth() { const v = read(); return v == null ? SIDEBAR_DEFAULT : clamp(v); }

export function initSidebarResize() {
  const handle = document.getElementById("resize-handle");
  if (!handle) return;
  applyWidth(sidebarWidth());   // re-affirm the head pre-stamp (and normalize a stale/out-of-range value)
  handle.setAttribute("role", "separator");
  handle.setAttribute("aria-orientation", "vertical");
  handle.removeAttribute("title");
  handle.setAttribute("aria-label", "Resize sessions panel; double-click to reset");
  const tip = document.createElement("span");
  tip.className = "resize-tooltip"; tip.id = "sidebar-size-tip"; tip.setAttribute("role", "tooltip");
  handle.appendChild(tip);
  handle.setAttribute("aria-describedby", tip.id);
  const updateTip = (e) => {
    const vw = window.innerWidth || document.documentElement.clientWidth || 1;
    tip.textContent = "Sessions · " + Math.round(cur / vw * 100) + "%";
    tip.style.left = Math.max(8, Math.min(cur + 14, vw - (tip.offsetWidth || 130) - 8)) + "px";
    if (e) tip.style.top = Math.max(8, Math.min(e.clientY + 12, window.innerHeight - 38)) + "px";
  };
  let dragging = false, pointerId = null, grabOffset = 0, startX = 0, startWidth = cur;
  const onMove = (e) => {
    if (!dragging || e.pointerId !== pointerId) return;
    applyWidth(e.clientX === startX ? startWidth : Math.round((e.clientX - grabOffset) / 5) * 5);
    updateTip(e); e.preventDefault();
  };
  const onUp = (e) => {
    if (!dragging || (e && e.pointerId != null && e.pointerId !== pointerId)) return;
    dragging = false;
    document.body.classList.remove("resizing");
    window.removeEventListener("pointermove", onMove);
    window.removeEventListener("pointerup", onUp);
    window.removeEventListener("pointercancel", onUp);
    window.removeEventListener("blur", onUp);
    try { handle.releasePointerCapture(pointerId); } catch {}
    pointerId = null;
    write(cur); updateTip(e && e.clientY != null ? e : null);
  };
  handle.addEventListener("pointermove", updateTip);
  handle.addEventListener("pointerenter", updateTip);
  window.addEventListener("resize", () => updateTip());
  handle.addEventListener("lostpointercapture", onUp);
  handle.addEventListener("pointerdown", (e) => {
    if (e.button !== 0 || dragging) return;
    dragging = true; pointerId = e.pointerId; grabOffset = e.clientX - cur; startX = e.clientX; startWidth = cur;
    document.body.classList.add("resizing");
    try { handle.setPointerCapture(pointerId); } catch {}
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
    window.addEventListener("pointercancel", onUp);
    window.addEventListener("blur", onUp);
    updateTip(e); e.preventDefault();
  });
  handle.addEventListener("dblclick", () => { applyWidth(SIDEBAR_DEFAULT); write(SIDEBAR_DEFAULT); updateTip(); });
  updateTip();
}

function read() { try { const v = parseInt(localStorage.getItem(KEY), 10); return Number.isFinite(v) ? v : null; } catch { return null; } }
function write(px) { try { localStorage.setItem(KEY, String(clamp(px))); } catch {} }
