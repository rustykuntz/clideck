// IT — the shared document extractor, and the two properties that let it be INLINED into the sandboxed HTML
// preview. The preview has no module loader and no same-origin fetch, so the host strips `export ` and
// concatenates this file with the bridge. Nothing here can import, and nothing here may need a global beyond
// the nodes it is handed — and if that ever stops being true the preview breaks in silence, which is why it
// is asserted here rather than left as a comment.
import { readFileSync } from "node:fs";
import { installFakeDom } from "./fakedom.mjs";
installFakeDom();
const checks = [];
const ok = (name, pass) => { checks.push([name, !!pass]); console.log((pass ? "  ok   " : "  FAIL ") + name); };

const source = readFileSync(new URL("../public/js/ui/doc-text.js", import.meta.url), "utf8");
const bridge = readFileSync(new URL("../public/js/ui/preview-bridge.js", import.meta.url), "utf8");
const { docTextIndex, textFingerprint, normalizeWithMap, partAt, textParts } = await import("../public/js/ui/doc-text.js");

ok("the extractor imports nothing at all", !/^\s*import[\s{*]/m.test(source));
ok("and every export is a plain declaration, so stripping `export ` leaves valid script",
  !/^export\s+(?!function |const )/m.test(source) && !/export\s+default/.test(source));
ok("stripping it really does parse as a classic script",
  (() => { try { new Function(source.replace(/^export /gm, "")); return true; } catch { return false; } })());
ok("the bridge imports nothing either, and is one self-contained function",
  !/^\s*import[\s{*]/m.test(bridge) && /^\(function \(\) \{/m.test(bridge));
ok("and the two together parse as the single script the preview is handed",
  (() => { try { new Function("(function(){\n" + source.replace(/^export /gm, "") + "\n" + bridge + "\n})();"); return true; } catch { return false; } })());
// The frame shares a global scope with the author's own code, so nothing may leak out of that wrapper.
ok("and it creates no globals of its own — the frame's scope belongs to the author",
  !/(?:globalThis|window|self)\.[A-Za-z_$][\w$]*\s*=[^=]/.test(source + bridge));

// ── the walk itself ──────────────────────────────────────────────────────────────────────────────────────
const el = (tag, children, text) => {
  const node = document.createElement(tag);
  if (text != null) node.appendChild(document.createTextNode(text));
  for (const child of children || []) node.appendChild(child);
  return node;
};
const root = document.createElement("div");
root.appendChild(el("h1", null, "Release plan"));
root.appendChild(el("p", null, "The build is green."));
const list = document.createElement("ul");
list.appendChild(el("li", [el("p", null, "first item")]));
list.appendChild(el("li", [el("p", null, "second item")]));
root.appendChild(list);

const index = docTextIndex(root);
ok("a heading is a paragraph apart from the prose under it", /Release plan\n\nThe build is green\./.test(index.text));
ok("list items are ONE break apart, however the renderer wraps them", /first item\nsecond item/.test(index.text));
ok("every character knows where it came from", index.at.length === index.text.length
  && index.parts.length > 0 && index.at.every((raw) => raw >= 0));
const at = index.text.indexOf("green");
const where = partAt(index.at[at], index.parts);
ok("and an offset resolves to the node holding it",
  where && String(where.node.nodeValue || where.node.textContent).slice(where.offset, where.offset + 5) === "green");

ok("a fingerprint separates two different readings of the same length",
  textFingerprint("abc") !== textFingerprint("abd") && textFingerprint("abc") === textFingerprint("abc"));
const mapped = normalizeWithMap("  a\t\tb \n\n\n\n c  ");
ok("normalising collapses runs, trims the ends, and caps blank lines at one",
  mapped.text === "a b\n\nc" && mapped.at.length === mapped.text.length && mapped.truncated === false);
ok("a document too big to hold says so instead of pretending it is complete",
  normalizeWithMap("x".repeat(256 * 1024 + 10)).truncated === true);

const splitBreaks = el("div", [el("span", null, "first\n"), el("span", null, "\n"),
  el("span", null, "\n\n"), el("p", null, "second")]);
const splitIndex = docTextIndex(splitBreaks);
ok("newlines split across text nodes preserve paragraph spacing and raw offsets",
  textParts(splitBreaks).raw === "first\n\n\n\nsecond\n\n" && splitIndex.text === "first\n\nsecond"
  && partAt(splitIndex.at[7], splitIndex.parts).node.nodeValue === "second"
  && partAt(splitIndex.at[7], splitIndex.parts).offset === 0);

const longRoot = el("main", Array.from({ length: 5000 }, (_, i) => el("p", null, `Paragraph ${i}.`)));
const longIndex = docTextIndex(longRoot);
const expectedLong = Array.from({ length: 5000 }, (_, i) => `Paragraph ${i}.`).join("\n\n");
ok("a long document preserves every paragraph and its exact character-to-node mapping",
  longIndex.text === expectedLong && !longIndex.truncated
  && longIndex.at.every((offset, i) => {
    if (/\s/.test(longIndex.text[i])) return true;
    const part = partAt(offset, longIndex.parts);
    return part?.node?.nodeValue[part.offset] === longIndex.text[i];
  }));

if (checks.some(([, pass]) => !pass)) process.exitCode = 1;
else console.log(`\n${checks.length}/${checks.length} document text checks passed`);
