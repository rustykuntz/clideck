// Content surfaces for the content.show broadcast. There is now exactly ONE surface: every renderable asset
// opens as a TAB in the content dock (content-dock.js), and content for ANOTHER session also raises a
// clickable toast that switches there without stealing focus. Replayed content restores its tab quietly; it
// must not notify again on refresh/reconnect.
//
// ⚠️ Images and video used to be different: a one-shot (no `replaces`) opened a modal GLANCE LIGHTBOX instead
// of a tab, and only a LOOP got a tab. That surface has been retired, because it accounted for nothing. An
// asset is held by the engine until a `content.close` retires it, the lightbox never sent one, and dismissing
// it left the asset with no tab, no control, and no way back — so a session filled its 20-asset budget with
// pictures the user could not see, let alone close. A replay made it worse: the frame arrived again and
// popped the lightbox open on a plain refresh. One asset, one tab, one close is the whole fix.
import { store } from "../store.js";
import { toast } from "./toast.js";
import { shortId } from "../util.js";
import { initContentDock, presentInDock, renderableKind, showDocument } from "./content-dock.js";

const IMG_ICON = '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="3" width="18" height="18" rx="2"/><circle cx="9" cy="9" r="1.6"/><path d="M21 15l-5-5L5 21"/></svg>';
const VID_ICON = '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="5" width="14" height="14" rx="2"/><path d="M17 9l4-2v10l-4-2z"/></svg>';
const DOC_ICON = '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M7 3h7l4 4v14H7z"/><path d="M14 3v4h4"/></svg>';
const KIND_NOUN = { csv: "CSV table", text: "Text document", json: "JSON document", html: "HTML preview", markdown: "Markdown", pdf: "PDF", mermaid: "Diagram", diff: "Diff", chart: "Chart", testresults: "Test results", image: "Image", video: "Video" };

export function initContentViewer() {
  initContentDock();
  store.on("content:show", onContent);
  store.on("content:openFailed", onOpenFailed);
}

// A content.open the engine could NOT serve (missing file, outside the session's scope, nothing it can render).
// Success needs no handling here — it arrives as an ordinary content.show and draws the tab through the same
// path as the CLI, which is the point of routing the drop through the engine rather than a client blob: URL.
// The engine's own message is the body — never a restatement of it, which would drift the day the engine changes
// its mind. The hint is keyed on the engine's CODE and only says what to do next, not what happened.
const OPEN_HINT = { outside_scope: " Open it from a session whose folder contains it." };
function onOpenFailed(sessionId, error) {
  const path = String((error && error.path) || "");
  const name = path.slice(path.lastIndexOf("/") + 1) || "That file";
  const msg = (error && error.message) || "Couldn’t open this content.";
  toast.error({
    id: "content-open:" + path,
    title: name,
    body: msg + (OPEN_HINT[error && error.code] || ""),
    iconHtml: DOC_ICON,
  });
}

function sessionLabel(sid) {
  const s = store.sessions.get(sid);
  return (s && (s.name || shortId(sid))) || shortId(sid) || "another session";
}

function onContent(ev) {
  if (!ev || !renderableKind(ev.kind) || !ev.url) return;
  // The tab is recorded for EITHER session — for the active one it appears now, for another it is already
  // there when the user switches. That is also what makes the asset closable, which is the whole accounting.
  presentInDock(ev);
  if (ev.sessionId === store.activeId || ev.replay === true) return;
  toast.info({
    id: "content:" + ev.contentId,
    title: ev.name || (KIND_NOUN[ev.kind] || "Content"),
    body: (KIND_NOUN[ev.kind] || "Content") + " from " + sessionLabel(ev.sessionId),
    iconHtml: ev.kind === "video" ? VID_ICON : ev.kind === "image" ? IMG_ICON : DOC_ICON,
    onClick: () => { store.select(ev.sessionId); showDocument(ev.sessionId, ev.contentId); },   // the toast is about THIS document
  });
}
