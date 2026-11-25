// Chrome-style tab dragging for the pane's tab strip (content-dock). Grab a document tab and it follows the
// pointer along the strip while the tabs it passes slide aside to open its slot; let go and it settles into that
// slot. The Terminal tab stays first and nothing can pass it. With more tabs than fit, holding the tab near the
// strip's left/right edge (or past it) scrolls the strip, and the vertical wheel scrolls it sideways at any time.
// This module only moves pixels; `commit(from, to)` (indices among the draggable tabs) does the real reorder and
// re-render, after which the dropped tab glides from where it was released into its new place.
const THRESHOLD = 4;     // px before a press becomes a drag (a click still selects the tab)
const EDGE = 36;         // px band inside each strip edge that auto-scrolls during a drag
const MAX_STEP = 14;     // px per frame at the very edge (and anywhere past it)

export function initTabDrag(strip, { commit }) {
  let ds = null;
  strip.addEventListener("wheel", (e) => {
    if (Math.abs(e.deltaY) <= Math.abs(e.deltaX) || strip.scrollWidth <= strip.clientWidth) return;
    strip.scrollLeft += e.deltaY; e.preventDefault();
  }, { passive: false });
  strip.addEventListener("pointerdown", (e) => {
    if (e.button !== 0 || ds || e.target.closest("button")) return;
    const tab = e.target.closest(".cd-tab[data-item-id]");
    if (tab) ds = { tab, pointerId: e.pointerId, startX: e.clientX, x: e.clientX, active: false };
  });
  strip.addEventListener("pointermove", (e) => {
    if (!ds || e.pointerId !== ds.pointerId) return;
    ds.x = e.clientX;
    if (!ds.active) { if (Math.abs(e.clientX - ds.startX) < THRESHOLD) return; if (!start()) return; }
    if (!ds.tab.isConnected) { finish(false); return; }   // the strip re-rendered under the drag
    layout();
  });
  strip.addEventListener("pointerup", (e) => { if (ds && e.pointerId === ds.pointerId) finish(true); });
  strip.addEventListener("pointercancel", (e) => { if (ds && e.pointerId === ds.pointerId) finish(false); });

  function start() {
    const tabs = [...strip.querySelectorAll(".cd-tab[data-item-id]")];
    const from = tabs.indexOf(ds.tab);
    if (from < 0 || tabs.length < 2) { ds = null; return false; }
    ds.active = true; ds.tabs = tabs; ds.from = ds.to = from; ds.scroll = strip.scrollLeft;
    ds.box = tabs.map((t) => ({ left: t.offsetLeft, width: t.offsetWidth }));
    ds.gap = Math.max(0, ds.box[1].left - (ds.box[0].left + ds.box[0].width));
    try { ds.tab.setPointerCapture(ds.pointerId); } catch {}
    strip.classList.add("tab-dragging"); ds.tab.classList.add("dragging");
    ds.raf = requestAnimationFrame(edgeScroll);
    return true;
  }
  function layout() {
    const { box, from } = ds, me = box[from], last = box[box.length - 1];
    const pos = Math.max(box[0].left, Math.min(last.left + last.width - me.width, me.left + (ds.x - ds.startX) + (strip.scrollLeft - ds.scroll)));
    ds.tab.style.transform = "translateX(" + (pos - me.left) + "px)";
    const center = pos + me.width / 2;
    let to = from;
    for (let i = from + 1; i < box.length; i++) if (center > box[i].left + box[i].width / 2) to = i;
    for (let i = from - 1; i >= 0; i--) if (center < box[i].left + box[i].width / 2) to = i;
    ds.to = to;
    const shift = me.width + ds.gap;
    ds.tabs.forEach((t, i) => {
      if (i === from) return;
      const d = from < i && i <= to ? -shift : to <= i && i < from ? shift : 0;
      t.style.transform = d ? "translateX(" + d + "px)" : "";
    });
  }
  function edgeScroll() {
    if (!ds || !ds.active) return;
    const r = strip.getBoundingClientRect(), before = strip.scrollLeft;
    const edge = Math.min(EDGE, r.width / 4);
    const depth = ds.x < r.left + edge ? ds.x - (r.left + edge) : ds.x > r.right - edge ? ds.x - (r.right - edge) : 0;
    if (depth) strip.scrollLeft += Math.sign(depth) * Math.ceil(MAX_STEP * Math.min(1, Math.abs(depth) / edge));
    if (strip.scrollLeft !== before && ds.tab.isConnected) layout();
    ds.raf = requestAnimationFrame(edgeScroll);
  }
  function finish(drop) {
    const d = ds; ds = null;
    if (!d || !d.active) return;
    cancelAnimationFrame(d.raf);
    const id = d.tab.dataset.itemId, released = d.tab.getBoundingClientRect().left;
    strip.classList.remove("tab-dragging"); d.tab.classList.remove("dragging");
    for (const t of d.tabs) t.style.transform = "";
    if (drop && d.tab.isConnected) commit(d.from, d.to);
    // Settle: start the (possibly new) tab element where it was let go, then glide it into its slot.
    const now = [...strip.querySelectorAll(".cd-tab[data-item-id]")].find((t) => t.dataset.itemId === id);
    if (!now) return;
    const dx = released - now.getBoundingClientRect().left;
    if (Math.abs(dx) < 1 || matchMedia("(prefers-reduced-motion: reduce)").matches) return;
    now.style.transition = "none"; now.style.transform = "translateX(" + dx + "px)";
    void now.offsetWidth;
    now.style.transition = ""; now.classList.add("settling"); now.style.transform = "";
    now.addEventListener("transitionend", () => now.classList.remove("settling"), { once: true });
  }
}
