// A plugin declares `icon` as a SHORT STRING, never markup: either one of the deck's named marks below, or a
// single glyph it draws itself. Anything else falls back to the plugin mark, so an unknown name degrades to a
// row that still lines up rather than to the literal word "waveform" sitting where an icon belongs.
const NAMED_ICONS = {
  copy: '<rect x="8" y="8" width="12" height="12" rx="2"/><path d="M16 8V5a2 2 0 0 0-2-2H5a2 2 0 0 0-2 2v9a2 2 0 0 0 2 2h3"/>',
  paste: '<rect x="8" y="3" width="8" height="4" rx="1"/><path d="M8 5H6a2 2 0 0 0-2 2v12a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V7a2 2 0 0 0-2-2h-2"/>',
  "☺": '<circle cx="12" cy="12" r="9"/><path d="M8 14a4 4 0 0 0 8 0M8 9h.01M16 9h.01"/>',
  mic: '<rect x="9" y="3" width="6" height="11" rx="3"/><path d="M5 11a7 7 0 0 0 14 0"/><line x1="12" y1="18" x2="12" y2="21"/>',
  waveform: '<path d="M3 12h2"/><path d="M8 7v10"/><path d="M12 4v16"/><path d="M16 8v8"/><path d="M20 11v2"/>',
  speaker: '<path d="M11 5L6 9H3v6h3l5 4V5z"/><path d="M15.5 8.5a5 5 0 0 1 0 7"/>',
  text: '<path d="M4 7V5h16v2"/><path d="M12 5v14"/><path d="M9 19h6"/>',
  clock: '<circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/>',
  terminal: '<path d="M5 7l4 4-4 4"/><path d="M12 17h7"/>',
  phone: '<rect x="6.5" y="2.5" width="11" height="19" rx="2.6"/><path d="M10.5 18.5h3"/>',
  send: '<path d="M21 4 3 11.2l6.6 2.3L18 7.5l-6.3 7.2.2 5.3 3.3-3.9 4.1 3z"/>',
  plugin: '<rect x="4" y="4" width="6" height="6" rx="1.5"/><rect x="14" y="4" width="6" height="6" rx="1.5"/><rect x="4" y="14" width="6" height="6" rx="1.5"/><rect x="14" y="14" width="6" height="6" rx="1.5"/>',
};
export const isNamedIcon = (icon) => Object.hasOwn(NAMED_ICONS, String(icon || ""));
export function actionIcon(icon) {
  const name = String(icon || "");
  const node = document.createElement("span");
  if (name && !NAMED_ICONS[name] && [...name].length <= 2 && !/^[\w-]+$/.test(name)) { node.textContent = name; return node; }
  node.innerHTML = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round">'
    + (NAMED_ICONS[name] || NAMED_ICONS.plugin) + "</svg>";
  return node;
}
