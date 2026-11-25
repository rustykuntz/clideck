// Integration test — the pure rich-content renderers (markdown / diff / chart / testresults). Runs the ACTUAL
// content-renderers.js against the committed fake DOM. Covers structure + the safety rules (escaped text,
// scheme-sanitised markdown links) and the documented chart / testresults JSON specs.
import { installFakeDom } from "./fakedom.mjs";
installFakeDom();
const R = await import("../public/js/ui/content-renderers.js");

let pass = 0, fail = 0;
const ok = (n, c) => { if (c) { pass++; console.log("  ok   " + n); } else { fail++; console.log("  FAIL " + n); } };
const q = (el, s) => el.querySelector(s);
const qa = (el, s) => el.querySelectorAll(s);

// ── plain text + JSON ──
const text = R.renderText("first\tline\n<script>not markup</script>\n" + "x".repeat(500));
ok("text: content remains literal text, including markup-looking input", q(text, ".ct-text-body").textContent.includes("<script>not markup</script>") && !q(text, "script"));
ok("text: page exposes calm document metadata and one wrapping body", /Plain text · 3 lines/.test(q(text, ".ct-doc-meta").textContent) && qa(text, ".ct-text-body").length === 1);
const json = R.renderJson('{"name":"CliDeck","count":2,"ready":true,"missing":null,"nested":{"unsafe":"<img onerror=x>"}}');
ok("json: valid source is parsed and pretty-printed", /\n  "name": "CliDeck"/.test(q(json, ".ct-json-code").textContent) && /Formatted/.test(q(json, ".ct-doc-meta").textContent));
ok("json: keys, strings, numbers, booleans and null receive distinct safe spans", qa(json, ".json-key").length === 6 && qa(json, ".json-string").length === 2 && qa(json, ".json-number").length === 1 && qa(json, ".json-bool").length === 1 && qa(json, ".json-null").length === 1);
ok("json: markup-looking values never become DOM", !q(json, "img") && q(json, ".ct-json-code").textContent.includes("<img onerror=x>"));
const invalidJson = R.renderJson('{"broken": } <script>');
ok("json: malformed source gets an accessible parse state plus intact raw text", q(invalidJson, ".ct-json-error").getAttribute("role") === "alert" && /isn’t valid JSON/.test(q(invalidJson, ".ct-json-error").textContent) && q(invalidJson, ".ct-json-raw").textContent === '{"broken": } <script>' && !q(invalidJson, "script"));

// ── markdown ──
const md = R.renderMarkdown([
  "# Title",
  "",
  "Para with **bold**, *em*, `code` and a [link](https://ok.dev).",
  "",
  "- one",
  "- two",
  "",
  "| A | B |",
  "| - | - |",
  "| 1 | 2 |",
  "",
  "```js",
  "const x = 1 < 2 && 3;",
  "```",
  "",
  "> a quote",
].join("\n"));
ok("md: heading → <h1>", !!q(md, "h1") && q(md, "h1").textContent === "Title");
ok("md: bold/em/code inline", /<strong>bold<\/strong>/.test(q(md, "p").innerHTML) && /<em>em<\/em>/.test(q(md, "p").innerHTML) && /<code>code<\/code>/.test(q(md, "p").innerHTML));
ok("md: safe link becomes <a href>", /<a href="https:\/\/ok.dev"[^>]*>link<\/a>/.test(q(md, "p").innerHTML));
ok("md: unordered list with 2 items", q(md, "ul") && qa(md, "li").length === 2);
ok("md: table head + body cells", q(md, "table.md-table") && qa(md, "th").length === 2 && qa(md, "td").length === 2);
ok("md: fenced code is TEXT (angle brackets not markup)", q(md, "pre.md-code code").textContent === "const x = 1 < 2 && 3;" && !/<code>/.test(q(md, "pre.md-code code").textContent));
ok("md: blockquote", !!q(md, "blockquote"));
const xss = R.renderMarkdown("Hi <script>alert(1)</script> and [x](javascript:alert(1))");
ok("md: raw HTML in text is escaped (no live <script>)", !q(xss, "script") && /&lt;script&gt;/.test(q(xss, "p").innerHTML));
ok("md: javascript: link is NOT linkified", !q(xss, "a") && /x/.test(q(xss, "p").innerHTML));

const urls = R.renderMarkdown("Sources (https://github.com/elder-plinius/CL4R1T4S), https://example.com/wiki/Topic_(detail). https://example.com/?a=1&b=2");
const hrefs = (html) => [...html.matchAll(/<a href="([^"]*)"/g)].map(m => m[1]);
ok("md: bare URLs become links without surrounding prose punctuation", hrefs(q(urls, "p").innerHTML).join(" ") === "https://github.com/elder-plinius/CL4R1T4S https://example.com/wiki/Topic_(detail) https://example.com/?a=1&amp;b=2");
const protectedUrls = R.renderMarkdown("[https://explicit.dev](https://target.dev) `https://code.dev` ![image](https://image.dev/pic.png)\n\n```\nhttps://fenced.dev\n```");
const protectedHtml = q(protectedUrls, "p").innerHTML;
ok("md: autolinking preserves explicit links, images and code", hrefs(protectedHtml).join(" ") === "https://target.dev" && protectedHtml.includes("<code>https://code.dev</code>") && protectedHtml.includes('src="https://image.dev/pic.png"') && q(protectedUrls, "pre code").textContent === "https://fenced.dev");
const quotedUrl = R.renderMarkdown('https://safe.dev/" onclick="alert(1) <https://angle.dev>');
ok("md: bare URLs cannot introduce HTML attributes", hrefs(q(quotedUrl, "p").innerHTML).join(" ") === "https://safe.dev/ https://angle.dev" && q(quotedUrl, "p").innerHTML.startsWith('<a href="https://safe.dev/" target="_blank" rel="noopener noreferrer">https://safe.dev/</a>') && !/<a\b[^>]*onclick/.test(q(quotedUrl, "p").innerHTML));

// ── diff ──
const df = R.renderDiff(["@@ -1,2 +1,2 @@", " keep", "-old line", "+new line"].join("\n"));
ok("diff: one add row", qa(df, ".diff-row.add").length === 1 && q(df, ".diff-row.add .diff-code").textContent === "new line");
ok("diff: one del row", qa(df, ".diff-row.del").length === 1 && q(df, ".diff-row.del .diff-code").textContent === "old line");
ok("diff: context row", qa(df, ".diff-row.ctx").length === 1);
ok("diff: hunk header row present", qa(df, ".diff-row.hunk").length === 1);

// ── chart (bar) ──
const bar = R.renderChart({ type: "bar", title: "Sales", x: ["Q1", "Q2", "Q3"], series: [{ name: "A", values: [3, 5, 2] }, { name: "B", values: [1, 4, 6] }] });
ok("chart: title rendered", q(bar, ".chart-title").textContent === "Sales");
ok("chart: bar rect per value (2 series x 3)", qa(bar, "rect.chart-bar").length === 6);
ok("chart: legend has an entry per series", qa(bar, ".chart-leg").length === 2);
ok("chart: x tick labels present", qa(bar, "text.chart-tick").length >= 3);
// ── chart (line) ──
const line = R.renderChart({ type: "line", series: [{ name: "cpu", values: [10, 20, 15, 30] }] });
ok("chart: line → polyline", qa(line, "polyline.chart-line").length === 1);
ok("chart: line → a dot per point", qa(line, "circle.chart-dot").length === 4);

// ── test results ──
const tr = R.renderTestResults({ passed: 2, failed: 1, skipped: 1, duration: "1.2s", tests: [
  { name: "a", status: "pass" }, { name: "b", status: "pass" }, { name: "c", status: "fail", message: "expected 1 got 2" }, { name: "d", status: "skip" },
] });
ok("testresults: FAILED verdict when any fail", q(tr, ".tr-verdict.fail") && q(tr, ".tr-verdict").textContent === "FAILED");
ok("testresults: a cell per test", qa(tr, ".tr-cell").length === 4);
ok("testresults: pass/fail/skip cells coloured", qa(tr, ".tr-cell.pass").length === 2 && qa(tr, ".tr-cell.fail").length === 1 && qa(tr, ".tr-cell.skip").length === 1);
ok("testresults: failure detail shows name + message", q(tr, ".tr-fail-name").textContent === "c" && /expected 1 got 2/.test(q(tr, ".tr-fail-msg").textContent));
ok("testresults: duration shown", q(tr, ".tr-dur").textContent === "1.2s");
const green = R.renderTestResults({ passed: 5, failed: 0, tests: [] });
ok("testresults: PASSED verdict when none fail", q(green, ".tr-verdict.pass") && q(green, ".tr-verdict").textContent === "PASSED");

// ── element factories ──
ok("html frame is sandboxed (allow-scripts, no allow-same-origin)", (() => { const f = R.htmlFrame("/content/x"); const sb = f.getAttribute("sandbox") || ""; return f.tag === "iframe" && /allow-scripts/.test(sb) && !/allow-same-origin/.test(sb) && f.src === "/content/x"; })());
ok("pdf embed points at the url", (() => { const e = R.pdfEmbed("/content/p"); return e.src === "/content/p"; })());
ok("video factory: controls + no autoplay", (() => { const v = R.videoEl("/content/v"); return v.controls === true && !v.autoplay; })());
ok("mermaid factory falls back to source when lib absent", (() => { const m = R.mermaidEl("graph TD; A-->B"); return !!q(m, ".ct-mermaid-src") && /A-->B/.test(q(m, ".ct-mermaid-src").textContent); })());

console.log(`\n${fail === 0 ? "✓" : "✗"} ${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
