// Rich-content renderers for the content dock. Two families:
//  • PURE builders (text/JSON in → DOM out): renderText / renderJson / renderMarkdown / renderDiff / renderChart / renderTestResults.
//    No fetch, no globals — unit-tested directly. All user/agent text is escaped; markdown link hrefs are
//    scheme-sanitised (the dock is same-origin DOM, not a sandboxed frame, so nothing may inject markup).
//  • ELEMENT factories (url in → element out): htmlFrame / pdfEmbed / imageEl / videoEl / mermaidEl.
// The dock fetches url→text/JSON for the pure kinds and hands the element straight through for the url kinds.
//
// CHART SPEC (JSON served at /content/<id>) — agents target this:
//   { "type":"bar"|"line", "title"?:str, "x"?:[label,…], "yLabel"?:str,
//     "series":[ { "name":str, "color"?:"#rrggbb", "values":[num,…] }, … ] }
//   x labels are optional (default 1..n); every series shares the x axis. bar → grouped, line → polylines+dots.
// TESTRESULTS SPEC (JSON served at /content/<id>):
//   { "passed":int, "failed":int, "skipped"?:int, "duration"?:str, "suite"?:str,
//     "tests":[ { "name":str, "status":"pass"|"fail"|"skip", "message"?:str }, … ] }
import { h, esc } from "../util.js";

const SVGNS = "http://www.w3.org/2000/svg";
const svg = (tag, attrs) => { const n = document.createElementNS(SVGNS, tag); for (const k in attrs) n.setAttribute(k, attrs[k]); return n; };
const num = (v, d = 0) => (Number.isFinite(+v) ? +v : d);

// ── plain text + JSON ────────────────────────────────────────────────────────────────────────────────────
// These are intentionally DOM-only renderers. Agent/user content is assigned through textContent, never
// parsed as markup; JSON highlighting is a small lexical pass over JSON.stringify's canonical output.
function docPage(kind, detail) {
  const shell = h("section", "ct-doc ct-" + kind);
  const page = h("div", "ct-doc-page");
  const meta = h("div", "ct-doc-meta"); meta.textContent = detail;
  page.appendChild(meta); shell.appendChild(page);
  return { shell, page, meta };
}
function lineCount(text) { return String(text).split("\n").length; }

export function renderText(value) {
  const text = String(value == null ? "" : value);
  const { shell, page } = docPage("text", "Plain text · " + lineCount(text) + (lineCount(text) === 1 ? " line" : " lines"));
  const body = h("pre", "ct-text-body"); body.textContent = text; page.appendChild(body);
  return shell;
}

const JSON_TOKEN = /"(?:\\u[\da-fA-F]{4}|\\[^u]|[^"\\])*"|-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?|\b(?:true|false|null)\b/g;
function jsonCode(pretty) {
  const code = h("pre", "ct-json-code");
  let end = 0, match;
  const append = (text, cls) => { if (!text) return; const span = h("span", cls); span.textContent = text; code.appendChild(span); };
  while ((match = JSON_TOKEN.exec(pretty))) {
    append(pretty.slice(end, match.index), "json-punct");
    const token = match[0], tail = pretty.slice(JSON_TOKEN.lastIndex);
    const cls = token[0] === '"' ? (/^\s*:/.test(tail) ? "json-key" : "json-string")
      : token === "true" || token === "false" ? "json-bool" : token === "null" ? "json-null" : "json-number";
    append(token, cls); end = JSON_TOKEN.lastIndex;
  }
  append(pretty.slice(end), "json-punct");
  return code;
}

// `onError(message)` (optional) hears a genuine failure to draw; what the person sees is unchanged.
export function renderJson(value, { onError } = {}) {
  const source = typeof value === "string" ? value : JSON.stringify(value);
  let parsed;
  try { parsed = typeof value === "string" ? JSON.parse(value) : value; }
  catch (error) {
    const { shell, page, meta } = docPage("json invalid", "Invalid JSON"); meta.classList.add("bad");
    const notice = h("div", "ct-json-error"); notice.setAttribute("role", "alert");
    const title = h("strong"); title.textContent = "This file isn’t valid JSON";
    const detail = h("span"); detail.textContent = error && error.message ? error.message : "The document could not be parsed.";
    if (onError) onError("This file isn’t valid JSON: " + detail.textContent);
    notice.append(title, detail);
    const raw = h("pre", "ct-json-raw"); raw.textContent = source;
    page.append(notice, raw); return shell;
  }
  const pretty = JSON.stringify(parsed, null, 2);
  const { shell, page } = docPage("json", "JSON · Formatted · " + lineCount(pretty) + (lineCount(pretty) === 1 ? " line" : " lines"));
  const scroll = h("div", "ct-json-scroll"); scroll.appendChild(jsonCode(pretty)); page.appendChild(scroll);
  return shell;
}

// ── markdown (slim, safe): headings · hr · blockquote · fenced code · ul/ol · tables · inline ──
const SAFE_HREF = /^(https?:\/\/|mailto:|\/|#|\.)/i;
const LIST_RE = /^(\s*)([-*+]|\d+[.)])\s+(.*)$/;
const HR_RE = /^\s*([-*_])\1{2,}\s*$/;
const TABLE_RE = /^\s*\|(.+)\|\s*$/;
const BLANK_RE = /^\s*$/;
// The one predicate for "this line opens a block of its own", so a line can never be swallowed as continuation
// text — of a paragraph OR of a list item. Both callers agree by construction rather than by two regexes that
// drift apart (the old paragraph rule missed `---`, so a rule after a paragraph was absorbed into it).
const startsBlock = (l) =>
  LIST_RE.test(l) || HR_RE.test(l) || TABLE_RE.test(l) || /^\s*```/.test(l) || /^#{1,6}\s/.test(l) || /^\s*>/.test(l);
// Indent comparisons need ONE unit: expand leading tabs to columns (leading only — a tab inside fenced code is
// the author's). Then indentOf is a plain space count and dedent is a slice.
const lead = (l) => l.replace(/^[ \t]+/, (w) => " ".repeat(w.replace(/\t/g, "    ").length));
const indentOf = (l) => l.length - l.replace(/^ +/, "").length;
const dedent = (l, n) => l.slice(Math.min(n, indentOf(l)));

// ── one status vocabulary, shared by callout labels and table chips ───────────────────────────────────────
// A word means the same thing wherever an agent writes it: `> **Warning:** …` and a WARNING chip in a table
// are the same claim in two shapes, so both resolve through this table and land on the same colour.
// Matching is EXACT and closed — an unknown word gets the neutral treatment rather than a guessed colour,
// because a confidently wrong colour on a status reads as fact and is worse than no colour at all.
const TONES = [
  ["good", /^(done|shipped|pass(ed)?|ok|success|green|live|resolved|fixed|complete[d]?)$/i],
  ["bad", /^(fail(ed|ure)?|error|blocked|blocker|broken|critical|danger|red|rejected)$/i],
  ["warn", /^(warn(ing)?|caution|pending|hold|todo|skip(ped)?|deferred|stale|flaky|partial|amber)$/i],
  ["info", /^(note|tip|info|hint|context|why)$/i],
  ["muted", /^(draft|illustrative|proposed|example|specimen|mock|n\/?a|unknown)$/i],
];
// A figure the author SIGNED: "+4.5%", "-12ms", "-3". Deliberately narrow — a sign, digits, and at most a
// short unit, no spaces — so a prose cell that merely opens with a dash can never be read as a fall.
// Direction is judged per cell and independently of the right-alignment heuristic: whether a column is
// "numeric enough" to align is a different question from whether THIS value states a direction.
const SIGNED = /^[+-]\d[\d.,]*\s?[\w%]{0,6}$/;
function toneOf(word) {
  const w = String(word == null ? "" : word).trim().replace(/[:.]$/, "");
  for (const [tone, re] of TONES) if (re.test(w)) return tone;
  return "";
}

// A list item OWNS every line that belongs to it: its marker line, LAZY CONTINUATION lines (markdown wraps one
// long item across source lines — the old builder ended the whole list at the first of those and the rest fell
// out as top-level paragraphs, which is why wrapped bullets snapped back to the page margin mid-item),
// blank-separated indented blocks, and deeper markers. Those lines are dedented to the item's own content column
// and re-parsed AS A DOCUMENT, so an item may hold anything a document may — paragraphs, code, tables, quotes,
// nested lists — instead of the builder re-implementing a second, weaker parser inline.
// A blank line anywhere inside the list makes it LOOSE: items get air, which is exactly what the author meant.
function buildList(lines, start, seen) {
  const open = lead(lines[start]).match(LIST_RE);
  const base = indentOf(open[1]);
  const ordered = /\d/.test(open[2]);
  const list = h(ordered ? "ol" : "ul", "md-list");
  const items = [];
  let i = start, loose = false, blanks = 0;
  while (i < lines.length) {
    const line = lead(lines[i]);
    if (BLANK_RE.test(line)) { blanks++; i++; continue; }
    const ind = indentOf(line);
    const m = line.match(LIST_RE);
    if (m && indentOf(m[1]) <= base) {                      // a marker at, or left of, this list's own column
      if (indentOf(m[1]) < base) break;                     // dedent → this list is finished
      if (/\d/.test(m[2]) !== ordered) break;               // marker type changed → a new sibling list
      if (blanks && items.length) loose = true;
      items.push({ col: m[0].length - m[3].length, lines: [m[3]] });
      blanks = 0; i++; continue;
    }
    if (!items.length) break;
    const cur = items[items.length - 1];
    if (blanks) {
      if (ind <= base) break;                               // blank + back at the margin → the list is over
      loose = true; cur.lines.push("");                      // blank + indented → a further block in this item
    } else if (ind <= base && startsBlock(line)) break;     // a block opening at list level ends the list
    cur.lines.push(dedent(line, cur.col));
    blanks = 0; i++;
  }
  if (loose) list.className = "md-list md-loose";
  for (const it of items) {
    const li = h("li");
    const body = it.lines.slice();
    const task = body[0].match(/^\[([ xX])\]\s+(.*)$/);     // GitHub task list
    if (task) { li.className = "md-task" + (task[1] === " " ? "" : " done"); body[0] = task[2]; }
    parseBlocks(body, li, seen);
    // Item text keeps its <p> rather than being unwrapped into the <li>: tight vs loose is then one CSS rule
    // instead of a DOM rewrite, and no element ever mixes innerHTML with child nodes — a shape the fake DOM the
    // tests run on cannot represent, and a construct the harness cannot see is a bug it cannot catch.
    if (task) { const c = h("span", "md-check"); c.setAttribute("aria-hidden", "true"); li.prepend(c); }
    list.appendChild(li);
  }
  return { node: list, next: i };
}
// Heading anchor: stable, readable, de-duplicated within one document.
function slugId(text, seen) {
  const base = "md-" + (text.toLowerCase().replace(/[^\w\s-]/g, "").trim().replace(/\s+/g, "-") || "section");
  let id = base, n = 2;
  while (seen.has(id)) id = base + "-" + n++;
  seen.add(id);
  return id;
}

function inlineMd(t) {
  let s = esc(t);
  s = s.replace(/`([^`]+)`/g, (_m, c) => "<code>" + c + "</code>");
  s = s.replace(/\*\*([^*]+)\*\*/g, (_m, b) => "<strong>" + b + "</strong>");
  s = s.replace(/(^|[^*])\*(?!\s)([^*]+?)\*/g, (_m, p, i) => p + "<em>" + i + "</em>");
  // images BEFORE links, or ![alt](src) would match the link rule and lose its bang
  s = s.replace(/!\[([^\]]*)\]\(([^)\s]+)\)/g, (_m, alt, src) => {
    const clean = src.replace(/"/g, "%22");
    if (!SAFE_HREF.test(src)) return esc(alt);
    const img = `<img class="md-img" src="${clean}" alt="${alt}" loading="lazy">`;
    return alt ? `<figure class="md-figure">${img}<figcaption>${esc(alt)}</figcaption></figure>` : img;
  });
  s = s.replace(/\[([^\]]+)\]\(([^)\s]+)\)/g, (_m, txt, href) => {
    const clean = href.replace(/"/g, "%22");
    return SAFE_HREF.test(href) ? `<a href="${clean}" target="_blank" rel="noopener noreferrer">${txt}</a>` : txt;
  });
  // Link plain web addresses, leaving generated tags, explicit links and code untouched.
  return s.replace(/<a\b[^>]*>[\s\S]*?<\/a>|<code>[\s\S]*?<\/code>|<[^>]*>|https?:\/\/(?:(?!&(?:lt|gt|quot|#39);)[^\s<>"'])+/gi, (match) => {
    if (!/^https?:\/\//i.test(match)) return match;
    let url = match;
    // Sentence punctuation and enclosing parentheses are prose; balanced URL parentheses stay.
    while (url) {
      const last = url.slice(-1);
      if (/[.,;:!?]/.test(last)) { url = url.slice(0, -1); continue; }
      const open = { ")": "(", "]": "[", "}": "{" }[last];
      if (open && url.split(last).length > url.split(open).length) { url = url.slice(0, -1); continue; }
      break;
    }
    if (!/^https?:\/\/.+/i.test(url)) return match;
    return `<a href="${url}" target="_blank" rel="noopener noreferrer">${url}</a>` + match.slice(url.length);
  });
}
export function renderMarkdown(src) {
  const root = h("div", "md");
  parseBlocks(String(src == null ? "" : src).replace(/\r\n?/g, "\n").split("\n"), root, new Set());
  return root;
}
// The block loop, over any run of lines into any container. renderMarkdown is the document-level call; a list
// item is the same call over its own dedented lines, which is the whole reason an item can hold real blocks.
function parseBlocks(lines, root, seen) {
  let i = 0;
  const add = (tag, cls, html) => { const e = h(tag, cls); if (html != null) e.innerHTML = html; root.appendChild(e); return e; };
  while (i < lines.length) {
    let line = lines[i];
    if (/^\s*```/.test(line)) {                                // fenced code
      const lang = line.trim().slice(3).trim(); const buf = [];
      for (i++; i < lines.length && !/^\s*```/.test(lines[i]); i++) buf.push(lines[i]);
      i++;
      const pre = h("pre", "md-code"); const code = h("code");
      if (lang) { code.className = "lang-" + lang; pre.dataset.lang = lang; }
      code.textContent = buf.join("\n"); pre.appendChild(code); root.appendChild(pre); continue;
    }
    if (BLANK_RE.test(line)) { i++; continue; }
    const hd = line.match(/^(#{1,6})\s+(.*)$/);
    if (hd) {
      const level = hd[1].length, raw = hd[2].trim();
      // Display h1 reads two-tone when the author already wrote a title–subtitle dash. No new syntax: the dash
      // is theirs, we only ink the two halves differently. Without a dash it renders as one tone.
      const split = level === 1 ? raw.match(/^(.+?)\s+([—–])\s+(.+)$/) : null;
      // The space BEFORE the dash is the author's and must survive: the sub-half used to be display:block, so a
      // dropped space was invisible; inline, it reads as "trades— curated".
      const html = split
        ? inlineMd(split[1]) + ' <span class="md-h1-sub">' + esc(split[2]) + " " + inlineMd(split[3]) + "</span>"
        : inlineMd(raw);
      const el = add("h" + level, "md-h", html);
      el.id = slugId(raw, seen);                       // anchor now → TOC/deep-link is additive later
      i++; continue;
    }
    if (HR_RE.test(line)) { root.appendChild(h("hr", "md-hr")); i++; continue; }
    if (/^\s*>\s?/.test(line)) {                                // blockquote (collapses consecutive)
      const buf = [];
      for (; i < lines.length && /^\s*>\s?/.test(lines[i]); i++) buf.push(lines[i].replace(/^\s*>\s?/, ""));
      let body = buf.join(" ").trim();
      const lab = body.match(/^\*\*([^*]{1,40})\*\*[:.]?\s*/);      // "> **Note** …" — the established alert form
      const q = h("blockquote", "md-quote");
      if (lab) {
        const l = h("div", "md-callout-label"); l.textContent = lab[1]; q.appendChild(l);
        const tone = toneOf(lab[1]);           // Warning/Done/Draft… colour the rule and the label together
        if (tone) q.className = "md-quote md-tone-" + tone;
        body = body.slice(lab[0].length);
      }
      const qp = h("div", "md-callout-body"); qp.innerHTML = inlineMd(body); q.appendChild(qp);
      root.appendChild(q); continue;
    }
    if (TABLE_RE.test(line) && /^\s*\|?[\s:|-]+\|?\s*$/.test(lines[i + 1] || "")) {   // table
      const cells = (r) => r.trim().replace(/^\||\|$/g, "").split("|").map((c) => c.trim());
      const head = cells(line); i += 2; const body = [];
      for (; i < lines.length && /^\s*\|(.+)\|\s*$/.test(lines[i]); i++) body.push(cells(lines[i]));
      const tbl = h("table", "md-table"); const thead = h("thead"); const htr = h("tr");
      head.forEach((c) => { const th = h("th"); th.innerHTML = inlineMd(c); htr.appendChild(th); });
      const cellClass = (t) => (/^[\d][\d.,%+\-\s/]*(of\s+\d+)?$/i.test(t.trim()) ? "md-num" : "");
      thead.appendChild(htr); tbl.appendChild(thead);
      const tb = h("tbody"); body.forEach((r) => { const tr = h("tr"); r.forEach((c) => { const td = h("td", cellClass(c)); td.innerHTML = inlineMd(c); tr.appendChild(td); }); tb.appendChild(tr); });
      tbl.appendChild(tb);
      // ── column shape is a COLUMN decision, never one cell's ──────────────────────────────────────
      // A step/id/rank/uuid column should take the width of its widest value and hand the rest to the column
      // carrying the content — which is what anyone laying this table out by hand would do. Left to itself the
      // browser splits the width evenly, so a one-token index column ends up as wide as a column of code.
      //
      // The rule is per column and unanimous. It has to be: `width:1%` used to ride on any single cell that
      // happened to hold nothing but `code`, so ONE such row in a column of prose declared that whole column
      // narrow and shoved every other column's slack away — the reported bug. The badge look travelled the
      // same way, so two rows rendered as badges while their neighbours stayed plain.
      const strip = (t) => t.replace(/^`|`$/g, "").trim();
      const isNum = (t) => /^[\d][\d.,%+\-\s/]*(of\s+\d+)?$/i.test(t);
      const isChip = (t) => /^`[^`]+`$/.test(t);
      // One token, and short enough that holding it on one line cannot cost the content column real width.
      // 40 keeps ids, ranks, hashes and a 36-char uuid whole; a column of long URLs stays a normal wide column.
      const isTerse = (t) => !/\s/.test(strip(t)) && strip(t).length <= 40;
      const shape = head.map((_, col) => {
        const cells = body.map((r) => (r[col] || "").trim()).filter((t) => t !== "");
        if (!cells.length) return {};
        return { num: cells.every(isNum), chip: cells.every(isChip), terse: cells.every(isTerse) };
      });
      const tight = shape.map((s) => !!(s.num || s.chip || s.terse));
      // Only narrow anything when some column is left to absorb the slack — otherwise every column would claim
      // to be narrow and the browser would just share the width out again, for no gain and a worse table.
      const hasContentCol = tight.some((t) => !t);
      for (let col = 0; col < head.length; col++) {
        const s = shape[col], cls = [];
        if (s.num) cls.push("md-col-num");        // figures right-align, header included, so the digits line up
        if (s.chip) cls.push("md-chip-cell");     // a column of badges — the badge look, applied column-wide
        if (hasContentCol && tight[col]) cls.push("md-col-tight");
        const paint = (el, extra) => {
          const all = extra && extra.length ? cls.concat(extra) : cls;
          if (el && all.length) el.className = ((el.className || "") + " " + all.join(" ")).trim();
        };
        paint(htr.children[col]);
        // Shape belongs to the column; MEANING belongs to the cell. A badge takes the tone of the word it
        // holds, and a figure takes the direction of its own sign — so one FAILED among PASSEDs reads red
        // without the column having to be about failure.
        //
        // Only an EXPLICIT sign is coloured. A bare 0 is left alone on purpose: whether zero is good news or
        // the whole finding is the author's point, not something the shape of the number can tell us, and a
        // wrong colour on a figure is read as fact. Signs are the author saying which way is which.
        for (let ri = 0; ri < tb.children.length; ri++) {
          const td = tb.children[ri].children[col]; if (!td) continue;
          const raw = ((body[ri] && body[ri][col]) || "").trim();
          const extra = [];
          if (s.chip) { const t = toneOf(strip(raw)); if (t) extra.push("md-tone-" + t); }
          if (SIGNED.test(raw)) extra.push(raw[0] === "+" ? "md-pos" : "md-neg");
          paint(td, extra);
        }
      }
      const wrap = h("div", "md-table-wrap"); wrap.appendChild(tbl); root.appendChild(wrap); continue;
    }
    if (LIST_RE.test(line)) {                                   // list — nests by indent, ordered if the marker is numeric
      const consumed = buildList(lines, i, seen);
      root.appendChild(consumed.node); i = consumed.next; continue;
    }
    const buf = [line];                                        // paragraph (join until blank, or until a block opens)
    for (i++; i < lines.length && !BLANK_RE.test(lines[i]) && !startsBlock(lines[i]); i++) buf.push(lines[i]);
    // Honour hard breaks (two trailing spaces or a trailing backslash) instead of reflowing every line into one
    // blob — addresses, poetry and signature blocks depend on them.
    const joined = buf.map((l, n) => (n === buf.length - 1 ? l : (/(\s\s|\\)$/.test(l) ? l.replace(/(\s\s|\\)$/, "") + "\u0000BR\u0000" : l)))
      .join(" ").replace(/\s*\u0000BR\u0000\s*/g, "\u0000BR\u0000");
    const pHtml = inlineMd(joined).replace(/\u0000BR\u0000/g, "<br>");
    const figOnly = pHtml.match(/^\s*<figure class="md-figure">[\s\S]*<\/figure>\s*$/) || pHtml.match(/^\s*<img class="md-img"[^>]*>\s*$/);
    if (figOnly) { const holder = h("div", "md-figure-block"); holder.innerHTML = pHtml; root.appendChild(holder); }
    else add("p", "md-p", pHtml);
  }
}

// ── unified-diff → side-by-side, add/del coloured ──
export function renderDiff(src) {
  const root = h("div", "diff");
  const grid = h("div", "diff-grid"); root.appendChild(grid);
  const row = (cls, ln, ol, nl, text) => {
    const r = h("div", "diff-row " + cls);
    const g1 = h("span", "diff-gutter"); g1.textContent = ol || "";
    const g2 = h("span", "diff-gutter"); g2.textContent = nl || "";
    const c = h("span", "diff-code"); c.textContent = text;
    r.append(g1, g2, c); grid.appendChild(r);
  };
  let oln = 0, nln = 0;
  for (const raw of String(src == null ? "" : src).replace(/\r\n?/g, "\n").split("\n")) {
    if (/^(diff |index |--- |\+\+\+ )/.test(raw)) continue;     // file headers — skip
    const hunk = raw.match(/^@@\s*-(\d+)(?:,\d+)?\s+\+(\d+)(?:,\d+)?\s*@@(.*)$/);
    if (hunk) { oln = +hunk[1]; nln = +hunk[2]; const r = h("div", "diff-row hunk"); const c = h("span", "diff-code"); c.textContent = raw; const s1 = h("span", "diff-gutter"), s2 = h("span", "diff-gutter"); r.append(s1, s2, c); grid.appendChild(r); continue; }
    if (raw[0] === "+") { row("add", 0, "", nln, raw.slice(1)); nln++; }
    else if (raw[0] === "-") { row("del", 0, oln, "", raw.slice(1)); oln++; }
    else { const t = raw[0] === " " ? raw.slice(1) : raw; row("ctx", 0, oln, nln, t); oln++; nln++; }
  }
  return root;
}

// ── chart (hand-rolled SVG): bar (grouped) or line ──
export function renderChart(spec, { onError } = {}) {
  if (onError && (!spec || typeof spec !== "object" || Array.isArray(spec))) onError("The chart spec must be a JSON object.");
  spec = spec || {};
  const wrap = h("div", "chart");
  if (spec.title) { const t = h("div", "chart-title"); t.textContent = spec.title; wrap.appendChild(t); }
  const series = Array.isArray(spec.series) ? spec.series.filter((s) => s && Array.isArray(s.values)) : [];
  const n = series.reduce((m, s) => Math.max(m, s.values.length), 0);
  if (onError && !n && spec && typeof spec === "object" && !Array.isArray(spec)) onError("The chart has no series with values to draw.");
  const xs = Array.isArray(spec.x) && spec.x.length ? spec.x : Array.from({ length: n }, (_, k) => String(k + 1));
  const PAL = ["#5b8def", "#e0894f", "#3fa06a", "#b366d9", "#d9556f", "#4bb3c4"];
  const W = 640, H = 300, P = { t: 16, r: 16, b: 34, l: 44 };
  const iw = W - P.l - P.r, ih = H - P.t - P.b;
  let max = 0, min = 0;
  for (const s of series) for (const v of s.values) { max = Math.max(max, num(v)); min = Math.min(min, num(v)); }
  if (max === min) max = min + 1;
  const s = svg("svg", { class: "chart-svg", viewBox: `0 0 ${W} ${H}`, preserveAspectRatio: "xMidYMid meet", role: "img" });
  const y = (v) => P.t + ih - ((num(v) - min) / (max - min)) * ih;
  for (let g = 0; g <= 4; g++) {                               // gridlines + y ticks
    const gy = P.t + (ih * g) / 4; const val = max - ((max - min) * g) / 4;
    s.appendChild(svg("line", { class: "chart-grid", x1: P.l, y1: gy, x2: W - P.r, y2: gy }));
    const tl = svg("text", { class: "chart-tick", x: P.l - 7, y: gy + 4, "text-anchor": "end" }); tl.textContent = (Math.round(val * 100) / 100).toString(); s.appendChild(tl);
  }
  const band = iw / Math.max(1, n);
  xs.forEach((lab, k) => { const tx = svg("text", { class: "chart-tick", x: P.l + band * (k + 0.5), y: H - 12, "text-anchor": "middle" }); tx.textContent = lab; s.appendChild(tx); });
  if (spec.type === "line") {
    series.forEach((se, si) => {
      const col = se.color || PAL[si % PAL.length];
      const pts = se.values.map((v, k) => `${P.l + band * (k + 0.5)},${y(v)}`).join(" ");
      s.appendChild(svg("polyline", { class: "chart-line", points: pts, stroke: col, fill: "none" }));
      se.values.forEach((v, k) => s.appendChild(svg("circle", { class: "chart-dot", cx: P.l + band * (k + 0.5), cy: y(v), r: 3, fill: col })));
    });
  } else {
    const bw = (band * 0.72) / Math.max(1, series.length);
    series.forEach((se, si) => se.values.forEach((v, k) => {
      const col = se.color || PAL[si % PAL.length];
      const bx = P.l + band * k + band * 0.14 + si * bw; const by = y(v); const y0 = y(Math.max(0, min));
      s.appendChild(svg("rect", { class: "chart-bar", x: bx, y: Math.min(by, y0), width: Math.max(1, bw - 2), height: Math.abs(by - y0), fill: col, rx: 2 }));
    }));
  }
  wrap.appendChild(s);
  if (series.length > 1 || (series[0] && series[0].name)) {     // legend
    const leg = h("div", "chart-legend");
    series.forEach((se, si) => { const it = h("span", "chart-leg"); const sw = h("span", "chart-swatch"); sw.style.background = se.color || PAL[si % PAL.length]; const lb = h("span"); lb.textContent = se.name || "series " + (si + 1); it.append(sw, lb); leg.appendChild(it); });
    wrap.appendChild(leg);
  }
  return wrap;
}

// ── test results: summary + green/red grid + failure detail ──
export function renderTestResults(spec) {
  spec = spec || {};
  const passed = num(spec.passed), failed = num(spec.failed), skipped = num(spec.skipped);
  const total = passed + failed + skipped || (Array.isArray(spec.tests) ? spec.tests.length : 0);
  const wrap = h("div", "tr" + (failed ? " has-fail" : ""));
  const head = h("div", "tr-head");
  const verdict = h("span", "tr-verdict " + (failed ? "fail" : "pass")); verdict.textContent = failed ? "FAILED" : "PASSED";
  const counts = h("span", "tr-counts");
  counts.append(pill("pass", passed + " passed"));
  if (failed) counts.append(pill("fail", failed + " failed"));
  if (skipped) counts.append(pill("skip", skipped + " skipped"));
  head.append(verdict, counts);
  if (spec.duration) { const d = h("span", "tr-dur"); d.textContent = String(spec.duration); head.appendChild(d); }
  wrap.appendChild(head);
  if (total) { const bar = h("div", "tr-bar"); const seg = (cls, v) => { if (!v) return; const e = h("span", "tr-seg " + cls); e.style.flex = String(v); bar.appendChild(e); }; seg("pass", passed); seg("fail", failed); seg("skip", skipped); wrap.appendChild(bar); }
  const tests = Array.isArray(spec.tests) ? spec.tests : [];
  if (tests.length) {
    const grid = h("div", "tr-grid");
    tests.forEach((t) => { const cell = h("span", "tr-cell " + (t.status || "pass")); cell.title = (t.name || "") + (t.message ? " — " + t.message : ""); grid.appendChild(cell); });
    wrap.appendChild(grid);
    const fails = tests.filter((t) => t.status === "fail");
    if (fails.length) { const fl = h("div", "tr-fails"); fails.forEach((t) => { const row = h("div", "tr-fail"); const nm = h("div", "tr-fail-name"); nm.textContent = t.name || "(unnamed)"; row.appendChild(nm); if (t.message) { const ms = h("pre", "tr-fail-msg"); ms.textContent = String(t.message); row.appendChild(ms); } fl.appendChild(row); }); wrap.appendChild(fl); }
  }
  return wrap;
  function pill(cls, txt) { const p = h("span", "tr-pill " + cls); p.textContent = txt; return p; }
}

// ── element factories (url kinds) ──
// No src: the dock fills it with `srcdoc` so a host-owned bridge can ride in ahead of the document. It falls
// back to loading the url directly when that cannot be done, and the sandbox is identical either way.
export function htmlFrame(url) {
  const f = h("iframe", "ct-frame");
  f.setAttribute("sandbox", "allow-scripts");   // scripts run, but no same-origin / no top-nav / no forms escaping
  f.setAttribute("referrerpolicy", "no-referrer");
  if (url) f.src = url;
  return f;
}
export function pdfEmbed(url) { const e = h("iframe", "ct-pdf"); e.setAttribute("title", "PDF"); e.src = url; return e; }
export function imageEl(url, name) { const i = h("img", "ct-img"); i.src = url; i.alt = name || ""; return i; }
export function videoEl(url) { const v = h("video", "ct-video"); v.src = url; v.controls = true; v.playsInline = true; v.preload = "metadata"; return v; }
// mermaid renders via the vendored lib; until it loads (or if the diagram fails) we show the source. The engine
// serves the UMD build at /vendor/mermaid.js (static map, like xterm.js) → window.mermaid; we lazy-inject that
// <script> once, on first mermaid content, and init in securityLevel:'strict' (no click handlers / raw HTML from
// diagram text). Only the produced <svg> is inserted.
export function mermaidEl(text, { onError } = {}) {
  const failed = (message) => { if (onError) onError(message); };
  const box = h("div", "ct-mermaid");
  const pre = h("pre", "ct-mermaid-src"); pre.textContent = String(text == null ? "" : text); box.appendChild(pre);
  ensureMermaid().then((m) => {
    if (!m || typeof m.render !== "function") { failed("The Mermaid renderer couldn’t load, so only the diagram source is shown."); return; }
    const id = "mmd-" + Math.abs(hashCode(text)).toString(36);
    Promise.resolve(m.render(id, String(text))).then((out) => {
      const code = out && (out.svg || out); if (typeof code === "string") box.innerHTML = code;   // strict-mode SVG only
    }).catch((error) => failed("Mermaid couldn’t draw this diagram: " + (error && error.message || String(error))));
  }).catch(() => failed("The Mermaid renderer couldn’t load, so only the diagram source is shown."));
  return box;
}
let _mermaidP = null;
function ensureMermaid() {
  if (typeof window !== "undefined" && window.mermaid) return Promise.resolve(window.mermaid);
  if (_mermaidP) return _mermaidP;
  _mermaidP = new Promise((resolve) => {
    const head = (typeof document !== "undefined" && (document.head || document.documentElement)) || null;
    if (!head || !head.appendChild || typeof document.createElement !== "function") { resolve(null); return; }
    const s = document.createElement("script");
    s.src = "/vendor/mermaid.js"; s.async = true;
    s.onload = () => { const lib = typeof window !== "undefined" ? window.mermaid : null; if (lib && lib.initialize) { try { lib.initialize({ startOnLoad: false, securityLevel: "strict", theme: "neutral" }); } catch {} } resolve(lib || null); };
    s.onerror = () => resolve(null);
    head.appendChild(s);
  });
  return _mermaidP;
}
function hashCode(s) { let h = 0; s = String(s || ""); for (let k = 0; k < s.length; k++) { h = (h << 5) - h + s.charCodeAt(k); h |= 0; } return h; }
