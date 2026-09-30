// R2 file drop — drag anything over the deck and a full-bleed frosted VEIL invites the drop. WHERE you let go
// decides what happens, and the two targets are deliberately distinct so no modifier key is needed:
//  • On the TAB STRIP → the file OPENS as a document tab. Its BYTES go to the engine as content.open; the
//    engine registers them as an asset and broadcasts content.show, so the tab draws through the existing
//    handler and survives a refresh. Nothing is uploaded and the agent is not told.
//  • Anywhere else (the TERMINAL) → a FILE uploads to the active live session (PUT /upload) and the
//    engine-returned path is pasted into the terminal (bracketed, NOT auto-sent). Any document / text / image /
//    code is accepted; only executables, archives and disk images are rejected with a gentle toast.
//  • A FOLDER can't be uploaded — its absolute path is pasted straight in as a 'path' (from the drag's
//    file:// uri-list, e.g. /Users/you/Projects/my-app). No upload.
// Multi-file; big files get a live progress toast; targets the session active at drop time.
import { store } from "../store.js";
import { uploadFile, openContent } from "../ws.js";
import { toast } from "./toast.js";
import { pasteToTerminal } from "./prompts.js";
import { h } from "../util.js";
import { armTabDrop, overTabDrop } from "./content-dock.js";

const BIG = 512 * 1024;
// Blocklist — send any doc/text/image/code; refuse only binaries the agent can't use.

const REJECT_EXT = new Set("exe msi bat com cmd scr ps1 dll so dylib o a obj class jar war app apk ipa dmg pkg mpkg deb rpm appimage iso img bin zip tar gz tgz bz2 tbz xz 7z rar lz lzma zst cab".split(" "));
const REJECT_MIME = ["application/x-msdownload", "application/x-apple-diskimage", "application/vnd.debian", "application/x-msdos-program", "application/zip", "application/x-tar", "application/gzip", "application/x-bzip", "application/x-7z-compressed", "application/x-rar", "application/x-xz"];

const UP_ICON = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M12 16V4"/><path d="M7 9l5-5 5 5"/><path d="M5 20h14"/></svg>';
const NO_ICON = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="9"/><path d="M8 12h8"/></svg>';
const DOC_ICON = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8z"/><path d="M14 3v5h5"/><path d="M12 12v5"/><path d="M9.5 14.5h5"/></svg>';

let zone = null, ic = null, title = null, sub = null, depth = 0;

export function initDrop() {
  const main = document.querySelector(".main");
  if (!main) return;
  zone = h("div", "drop-zone");
  const inner = h("div", "drop-inner");
  ic = h("div", "drop-ic"); ic.innerHTML = UP_ICON;
  title = h("div", "drop-title");
  sub = h("div", "drop-sub");
  inner.append(ic, title, sub);
  zone.appendChild(inner);
  main.appendChild(zone);
  main.addEventListener("dragenter", onEnter);
  main.addEventListener("dragover", onOver);
  main.addEventListener("dragleave", onLeave);
  main.addEventListener("drop", onDrop);
}

function extOf(name) { const m = /\.([A-Za-z0-9]+)$/.exec(String(name || "")); return m ? m[1].toLowerCase() : ""; }
function supported(file) {
  const ext = extOf(file.name);
  if (ext) return !REJECT_EXT.has(ext);                     // any non-binary extension → a document/text/image
  const t = String(file.type || "");                        // no extension (Makefile, LICENSE, Dockerfile…)
  return t !== "application/octet-stream" && !REJECT_MIME.some((m) => t.startsWith(m));
}
function looksBadMime(t) { t = String(t || ""); return t === "application/octet-stream" || REJECT_MIME.some((m) => t.startsWith(m)); }
// During a drag the filename is hidden; peek item MIME types — reject only when every typed item is a known binary.
function dragLooksUnsupported(e) {
  const items = e.dataTransfer && e.dataTransfer.items;
  if (!items || !items.length) return false;
  let known = 0;
  for (const it of items) if (it.kind === "file" && it.type) { known++; if (!looksBadMime(it.type)) return false; }
  return known > 0;
}

function hasFiles(e) { return !!e.dataTransfer && Array.from(e.dataTransfer.types || []).indexOf("Files") !== -1; }
function activeLive() { const s = store.active(); return s && s.live !== false ? s : null; }

function onEnter(e) { if (!hasFiles(e) || !activeLive()) return; e.preventDefault(); depth++; armTabDrop(true); paintVeil(e); zone.classList.add("show"); }
function onOver(e) { if (!hasFiles(e) || !activeLive()) return; e.preventDefault(); if (e.dataTransfer) e.dataTransfer.dropEffect = "copy"; paintVeil(e); }
function onLeave(e) { if (!hasFiles(e)) return; depth = Math.max(0, depth - 1); if (depth === 0) hide(); }
function onDrop(e) {
  if (!hasFiles(e)) return;
  e.preventDefault(); depth = 0;
  const toTab = overTabDrop(e.clientX || 0, e.clientY || 0);   // read the target BEFORE hide() tears the rail down
  hide();
  const s = activeLive(); if (!s) return;
  // Read everything off the dataTransfer NOW — it is neutered the moment this handler returns, and the tab-strip
  // path awaits the file's bytes.
  const files = Array.from(e.dataTransfer.files || []);
  if (toTab) { openDropped(s, files); return; }
  const uris = fileUris(e);
  const items = Array.from(e.dataTransfer.items || []);
  const bad = [];
  if (items.length && items[0] && typeof items[0].webkitGetAsEntry === "function") {
    items.forEach((it, i) => {
      if (it.kind !== "file") return;
      const entry = it.webkitGetAsEntry();
      if (entry && entry.isDirectory) {                     // FOLDER → paste its path, no upload
        const path = uris[i] || matchUri(uris, entry.name);
        if (path) { pasteToTerminal(path); toast.success({ id: "drop-path:" + path, title: baseName(path), body: "Folder path pasted into the terminal" }); }
        else toast.info({ id: "drop-nopath", title: entry.name, body: "Couldn't read the folder's path from this drag" });
      } else {                                              // FILE → upload
        const f = it.getAsFile();
        if (f) { if (supported(f)) uploadOne(s, f); else bad.push(f); }
      }
    });
  } else {
    for (const f of files) { if (supported(f)) uploadOne(s, f); else bad.push(f); }
  }
  reportRejected(bad);
}

function reportRejected(bad) {
  if (bad.length) toast.info({ id: "drop-reject", title: "Can’t send that", body: bad.length === 1 ? "“" + bad[0].name + "” — executables & archives aren’t supported" : bad.length + " files skipped (executables / archives)" });
}

// Pasted files (a copied file, a screenshot) follow the terminal-drop rules: each supported file uploads to the
// session and its path is pasted in; executables and archives are refused.
export function uploadFiles(s, files) {
  const bad = [];
  for (const f of files) { if (supported(f)) uploadOne(s, f); else bad.push(f); }
  reportRejected(bad);
}

// Dropped ON THE TAB STRIP → open each file as a document tab, BY VALUE.
// dataTransfer.files is the one thing EVERY source app gives us. The earlier version recovered a filesystem
// path from text/uri-list instead, which only Finder is obliged to provide — so every drag out of Nimble
// Commander (and any other file manager) failed with "carried no file path". There is no fallback chain here on
// purpose: a fallback chain is the same over-complication wearing a second coat. One path, every app.
const DOC_KIND = new Map([
  ["txt", "text"], ["log", "text"], ["json", "json"], ["csv", "csv"],
  ["md", "markdown"], ["markdown", "markdown"], ["mdown", "markdown"], ["mkd", "markdown"],
  ["html", "html"], ["htm", "html"], ["mmd", "mermaid"], ["patch", "diff"], ["diff", "diff"], ["pdf", "pdf"],
]);
const MAX_DOC = 10 * 1024 * 1024;   // the engine's decoded ceiling — refuse here rather than read a huge file into
                                    // memory, base64 it, and have it bounce off the wire
// The engine chooses the encoding BY KIND — content-store does `binary ? decodeBase64(encoded) :
// Buffer.from(encoded, 'utf8')` — so this side must split the same way or a README renders as its own base64.
// Flagged to the arch: one encoding for everything would delete this set and the branch below it.
const BINARY_KIND = new Set(["pdf"]);
// Chunked because String.fromCharCode(...bytes) blows the argument limit on anything sizeable.
async function toBase64(file) {
  const bytes = new Uint8Array(await file.arrayBuffer());
  let bin = "";
  for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
  return btoa(bin);
}
async function openDropped(session, files) {
  for (const f of files) {
    const kind = DOC_KIND.get(extOf(f.name));
    if (!kind) { toast.info({ id: "tabdrop-kind:" + f.name, title: f.name || "That file", body: "Text, JSON, Markdown, HTML, PDF, diffs and Mermaid open as documents" }); continue; }
    if (f.size > MAX_DOC) { toast.info({ id: "tabdrop-big:" + f.name, title: f.name, body: "Too large to open as a document" }); continue; }
    try { openContent(session.id, { name: f.name, kind, data: BINARY_KIND.has(kind) ? await toBase64(f) : await f.text() }); }
    catch { toast.error({ id: "tabdrop-read:" + f.name, title: f.name, body: "Couldn’t read that file" }); }
  }
}

// Absolute paths from the drag's file:// uri-list (Finder-style). Only readable in the drop handler.
function fileUris(e) {
  let raw = "";
  try { raw = (e.dataTransfer.getData && (e.dataTransfer.getData("text/uri-list") || e.dataTransfer.getData("text/plain"))) || ""; } catch {}
  return raw.split(/\r?\n/).map((l) => l.trim()).filter((l) => l && l[0] !== "#").map(uriToPath).filter(Boolean);
}
function uriToPath(u) {
  if (!/^file:/i.test(u)) return "";
  try { return decodeURIComponent(u.replace(/^file:\/\/(localhost)?/i, "")).replace(/\/+$/, "") || "/"; } catch { return ""; }
}
function baseName(p) { const s = String(p).replace(/\/+$/, ""); const i = s.lastIndexOf("/"); return i >= 0 ? s.slice(i + 1) : s; }
function matchUri(uris, name) { return uris.find((p) => baseName(p) === name) || ""; }

function paintVeil(e) {
  const s = activeLive();
  // Over the strip the veil states the OTHER intention, so the two targets read as one choice rather than as a
  // hidden mode. Kind is not pre-judged there — the engine answers for what it can render.
  const toTab = overTabDrop(e.clientX || 0, e.clientY || 0);
  const reject = !toTab && dragLooksUnsupported(e);
  zone.classList.toggle("reject", reject);
  zone.classList.toggle("to-tab", toTab);
  ic.innerHTML = toTab ? DOC_ICON : reject ? NO_ICON : UP_ICON;
  if (toTab) {
    const pre = h("span"); pre.textContent = "Open as a ";
    const what = h("b"); what.textContent = "document";
    title.replaceChildren(pre, what);
    sub.textContent = "Opens in a new tab — the agent isn’t told";
  } else if (reject) { title.textContent = "This file type isn’t supported"; sub.textContent = "Executables and archives can’t be sent"; }
  else {
    const pre = h("span"); pre.textContent = "Drop to send to ";
    const name = h("b"); name.textContent = s ? (s.name || "this session") : "this session";
    title.replaceChildren(pre, name);
    sub.textContent = "Documents, images & folders";
  }
}
function hide() { zone.classList.remove("show", "reject", "to-tab"); armTabDrop(false); }

async function uploadOne(s, file) {
  const tid = "upload:" + s.id + ":" + file.name;
  const big = file.size > BIG;
  if (big) toast.info({ id: tid, title: file.name, body: "Uploading… 0%", duration: 0 });
  try {
    const res = await uploadFile(s.id, file.name, file, (frac) => { if (big) toast.info({ id: tid, title: file.name, body: "Uploading… " + Math.round(frac * 100) + "%", duration: 0 }); });
    const path = res && res.path;
    if (path && store.activeId === s.id) pasteToTerminal(path);
    toast.success({ id: tid, title: res && res.name ? res.name : file.name, body: path ? "Uploaded → path pasted into the terminal" : "Uploaded" });
  } catch (err) {
    toast.error({ id: tid, title: file.name, body: (err && err.message) || "Upload failed" });
  }
}
