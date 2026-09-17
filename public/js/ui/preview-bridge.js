// The HTML preview's theme and reading bridge. This file is INLINED into the sandboxed frame together with
// doc-text.js, whose functions it calls directly — see the warning at the top of that file.
//
// The frame is `sandbox="allow-scripts"` with no allow-same-origin, so it cannot reach this window, its
// storage or its cookies, and that is not being relaxed for a highlight. What crosses the boundary is
// deliberately unprivileged in BOTH directions:
//   • down: a light/dark theme, integer ranges to mark, and a request for the current selection.
//     No urls, paths, secrets, or session details.
//   • up: "ready" with a fingerprint of the text, "pointer" when the user touches the document, and a
//     selection ONLY in reply to a request that named an id. The host validates event.source, but the
//     author's own scripts share this frame and can forge any of it, so nothing here is ever trusted with
//     an action: the worst a forged message can do is dismiss a menu or offer text the user then hears.
(function () {
  const HOST = window.parent;
  if (!HOST || HOST === window) return;
  const send = (message) => { try { HOST.postMessage(message, "*"); } catch {} };
  const themed = document.documentElement.hasAttribute("data-clideck-theme");
  const applyTheme = (theme) => {
    if (themed && (theme === "light" || theme === "dark")) document.documentElement.setAttribute("data-clideck-theme", theme);
  };
  // The host supplies this argument inside its private wrapper, before author CSS/scripts parse.
  if (typeof initialPreviewTheme !== "undefined") applyTheme(initialPreviewTheme);
  let index = null, pending = "", fingerprint = "", stale = false;

  const build = () => { try { index = docTextIndex(document.body); } catch { index = null; } stale = false; return index; };
  const announce = () => {
    const built = build();
    fingerprint = built ? textFingerprint(built.text) : "";
    send({ ck: "ready", fp: fingerprint, truncated: !!(built && built.truncated) });
  };
  // A document whose own scripts rewrite its text would leave every offset the host holds pointing at words
  // that have moved. We do not re-walk on every audio frame — we notice the mutation, re-walk when the next
  // mark arrives, and if the text is no longer the text the host measured we say so and paint NOTHING.
  try {
    new MutationObserver(() => { stale = true; }).observe(document.documentElement, { subtree: true, childList: true, characterData: true });
  } catch {}
  const current = () => {
    if (!index || stale) {
      const before = fingerprint;
      const built = build();
      fingerprint = built ? textFingerprint(built.text) : "";
      if (fingerprint !== before) { send({ ck: "ready", fp: fingerprint, truncated: !!(built && built.truncated) }); return null; }
    }
    return index;
  };

  // The user touching the document is the only thing this reports unasked, and the host uses it for exactly
  // one purpose: a menu open over the preview has to go away like any other outside click.
  for (const type of ["pointerdown", "mousedown", "touchstart"]) {
    window.addEventListener(type, () => send({ ck: "pointer" }), true);
  }

  const rangeFor = (from, to) => {
    if (!index) return null;
    const start = partAt(index.at[from], index.parts);
    const last = index.at[Math.max(from, to - 1)];
    const end = partAt(last, index.parts);
    if (!start || !end || !start.node || !end.node) return null;
    try {
      const range = document.createRange();
      range.setStart(start.node, start.offset);
      range.setEnd(end.node, Math.min(end.offset + 1, (end.node.nodeValue || "").length));
      return range;
    } catch { return null; }
  };
  const paint = (ranges) => {
    if (typeof Highlight !== "function" || typeof CSS === "undefined" || !CSS.highlights) return;
    const highlight = new Highlight();
    for (const pair of ranges) {
      const range = rangeFor(pair[0], pair[1]);
      if (range) { try { highlight.add(range); } catch {} }
    }
    CSS.highlights.set("read-along", highlight);
  };

  const selectionReport = (id) => {
    let text = "", offset = -1, truncated = false;
    try {
      const selection = window.getSelection();
      if (selection && selection.rangeCount && current()) {
        const range = selection.getRangeAt(0);
        const whole = String(selection);
        text = whole.slice(0, MAX_VIEWER_TEXT);
        truncated = whole.length > MAX_VIEWER_TEXT;
        for (const part of index.parts) {
          if (part.node !== range.startContainer) continue;
          const rawAt = part.from + Math.max(0, Math.min(range.startOffset - part.base, part.to - part.from));
          offset = index.text.length;
          for (let j = 0; j < index.at.length; j++) if (index.at[j] >= rawAt) { offset = j; break; }
          break;
        }
      }
    } catch { text = ""; offset = -1; truncated = false; }
    send({ ck: "selection", id, text, offset, truncated });
  };

  window.addEventListener("message", (event) => {
    if (event.source !== HOST) return;
    const data = event.data;
    if (!data || typeof data.ck !== "string") return;
    if (data.ck === "theme") { applyTheme(data.theme); return; }
    if (data.ck === "mark") {
      if (!current()) return;
      const ranges = Array.isArray(data.ranges) ? data.ranges.slice(0, 8) : [];
      const clean = [];
      for (const pair of ranges) {
        if (!Array.isArray(pair) || pair.length !== 2) continue;
        const from = Math.floor(Number(pair[0])), to = Math.floor(Number(pair[1]));
        if (Number.isFinite(from) && Number.isFinite(to) && from >= 0 && to > from && to <= index.text.length) clean.push([from, to]);
      }
      paint(clean);
      return;
    }
    if (data.ck === "clear") { try { CSS.highlights.delete("read-along"); } catch {} return; }
    // A selection is only ever reported in ANSWER to a request that named an id, so an unsolicited one from
    // the page's own scripts has nowhere to land.
    if (data.ck === "selection" && typeof data.id === "string" && data.id && data.id !== pending) {
      pending = data.id; selectionReport(data.id);
    }
  });

  const style = document.createElement("style");
  style.textContent = "::highlight(read-along){background-color:color-mix(in srgb,#f0be4d 26%,transparent);}";
  document.documentElement.appendChild(style);
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", announce, { once: true });
  else announce();
})();
