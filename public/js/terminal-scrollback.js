// xterm 6's CSI S deletes rows even when the scrolling region starts at the top.
// Codex uses that sequence as its input grows, so preceding reply lines disappear.
// Use xterm's ordinary scroll path to retain those rows in normal-buffer history;
// it also maintains markers, erase attributes, the viewport and dirty rows.
// These internals are version-sensitive: fall back to xterm if they change, and
// exercise the shipped browser build in cdp-gate-term-scroll.cjs on upgrades.
export function installScrollbackPreservation(terminal) {
  const core = terminal._core;
  const service = core?._bufferService;
  const input = core?._inputHandler;
  if (!terminal.parser?.registerCsiHandler || !service?.buffers?.normal ||
      typeof core.scroll !== "function" || typeof input?._eraseAttrData !== "function") return;
  return terminal.parser.registerCsiHandler({ final: "S" }, (params) => {
    const buffer = service.buffer;
    if (buffer !== service.buffers.normal || buffer.scrollTop !== 0) return false;
    const count = Math.min(params[0] || 1, buffer.scrollBottom + 1);
    const erase = input._eraseAttrData();
    const base = buffer.ybase;
    for (let i = 0; i < count; i++) core.scroll(erase);
    // CSI S leaves saved cursor screen coordinates unchanged. xterm stores savedY
    // as an absolute buffer row, so account for the history we just inserted.
    buffer.savedY += buffer.ybase - base;
    return true;
  });
}
