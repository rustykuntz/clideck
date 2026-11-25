// UI IT — Google sign-in completion page (plugin-packages/google/oauth-page.js). The plugin serves this from its
// loopback callback after gog reports the result. Checks the copy per status, that only `connected` ever reads
// as success, escaping of every dynamic value, no outside requests, the credit links, and the a11y/theme hooks.
import { createRequire } from "node:module";
const require = createRequire(import.meta.url);
const { renderOAuthPage } = require("../plugin-packages/google/oauth-page.js");

let pass = 0, fail = 0;
const ok = (name, yes, detail) => { if (yes) { pass++; console.log("  ok   " + name); } else { fail++; console.log("  FAIL " + name + (detail === undefined ? "" : " " + JSON.stringify(detail))); } };
const body = (html) => html.slice(html.indexOf("<body>"));
const words = (html) => body(html).replace(/<[^>]+>/g, " ").replace(/&#39;/g, "'").replace(/&amp;/g, "&").replace(/\s+/g, " ");

try {
  const connected = renderOAuthPage({ status: "connected", email: "or@example.com", message: "" });
  ok("connected: standalone HTML document", /^<!doctype html>\n<html lang="en">/.test(connected) && /<\/html>\n$/.test(connected));
  ok("connected: says connected with the email, and to close this tab and return to CliDeck", /Google account connected/.test(words(connected)) && /or@example\.com is now connected to CliDeck/.test(words(connected)) && /close this tab and go back to CliDeck/.test(words(connected)));
  ok("connected: no failure or cancel copy", !/didn’t finish|cancelled|couldn’t/i.test(words(connected)));
  ok("connected: title names the outcome", /<title>You’re connected · CliDeck<\/title>/.test(connected));

  const failed = renderOAuthPage({ status: "failed", email: "or@example.com", message: "access_denied: The user denied access." });
  ok("failed: clear failure heading, the reported reason, and what to do", /Sign-in didn’t finish/.test(words(failed)) && /access_denied: The user denied access\./.test(words(failed)) && /Close this tab, go back to CliDeck and try signing in again/.test(words(failed)));
  ok("failed: never reads as success", !/connected to CliDeck|You’re connected|Google account connected/.test(failed));

  const cancelled = renderOAuthPage({ status: "cancelled", email: "or@example.com", message: "" });
  ok("cancelled: says it was stopped and to check the connection in CliDeck — no promise that nothing was saved", /Sign-in stopped/.test(words(cancelled)) && /This Google sign-in was stopped\./.test(words(cancelled)) && /Close this tab and check the connection in CliDeck before trying again\./.test(words(cancelled)) && !/nothing was (connected|saved|changed)/i.test(words(cancelled)) && !/You’re connected|is now connected/.test(cancelled));

  for (const status of [undefined, "", "waiting", "CONNECTED", "connected ", null]) {
    const html = renderOAuthPage({ status, email: "x@example.com" });
    if (/You’re connected|is now connected/.test(html)) { ok("unknown status " + JSON.stringify(status) + " is never success", false); }
  }
  ok("anything but exactly 'connected' (missing, 'waiting', wrong case) shows the not-finished page", ["", "waiting", "CONNECTED"].every((s) => /Sign-in didn’t finish/.test(renderOAuthPage({ status: s }))));
  ok("no arguments at all still renders a safe not-finished page", /Sign-in didn’t finish/.test(renderOAuthPage()) && /couldn’t connect your Google account/.test(words(renderOAuthPage())));

  const evil = renderOAuthPage({ status: "failed", email: "<script>alert(1)</script>@x.com", message: "\"><img src=x onerror=alert(2)><a href='javascript:alert(3)'>&amp;" });
  ok("escaping: no injected tags survive", !/<script|<img|<a href='javascript/i.test(evil) && /&lt;script&gt;alert\(1\)&lt;\/script&gt;/.test(evil) && /&quot;&gt;&lt;img src=x onerror=alert\(2\)&gt;/.test(evil) && /&amp;amp;/.test(evil));
  const evilOk = renderOAuthPage({ status: "connected", email: "a\"b'c<d>&e@x.com" });
  ok("escaping: quotes and ampersands in the email", /a&quot;b&#39;c&lt;d&gt;&amp;e@x\.com/.test(evilOk));
  ok("escaping: no scripts anywhere", !/<script/i.test(connected) && !/<script/i.test(failed) && !/\son[a-z]+=/i.test(connected + failed + cancelled));

  const long = renderOAuthPage({ status: "failed", message: "x".repeat(5000), email: "y".repeat(400) + "@x.com" });
  ok("long values are clipped (message ≤ 600, email ≤ 254)", !long.includes("x".repeat(601)) && !long.includes("y".repeat(255)) && long.includes("…"));

  const urls = (html) => [...html.matchAll(/https?:\/\/[^\s"'<>)]+/g)].map((m) => m[0]);
  ok("no outside requests: no src/link/import/url(), the only URLs are the two GitHub links", [connected, failed, cancelled].every((h) => !/\ssrc=|<link\b|@import|url\(\s*['"]?https?:/i.test(h) && urls(h).sort().join() === "https://github.com/openclaw/gogcli,https://github.com/rustykuntz/clideck"));
  ok("credit: says CliDeck connects to Google with gog, links both projects", /CliDeck connects to Google with gog, an open-source command-line tool\./.test(words(connected)) && /gog on GitHub/.test(words(connected)) && /CliDeck on GitHub/.test(words(connected)));
  ok("credit links open safely in a new tab (noopener noreferrer)", (connected.match(/<a href="https:\/\/github\.com\/[^"]+" target="_blank" rel="noopener noreferrer">/g) || []).length === 2 && (connected.match(/<a /g) || []).length === 2);
  ok("referrer policy no-referrer, CSP blocks everything but inline styles", /<meta name="referrer" content="no-referrer">/.test(connected) && /default-src 'none'; style-src 'unsafe-inline'/.test(connected));
  ok("responsive: viewport meta and a narrow-screen rule", /<meta name="viewport" content="width=device-width, initial-scale=1">/.test(connected) && /@media \(max-width:420px\)/.test(connected));
  ok("system theme: light and dark via prefers-color-scheme + color-scheme", /@media \(prefers-color-scheme: light\)/.test(connected) && /<meta name="color-scheme" content="light dark">/.test(connected));
  ok("reduced motion turns the entrance animation off", /@media \(prefers-reduced-motion: reduce\) \{ \.badge \{ animation:none; \} \}/.test(connected));
  ok("a11y: lang, one h1 labelling main, decorative icons hidden, visible focus", (connected.match(/<h1\b/g) || []).length === 1 && /<main aria-labelledby="title">/.test(connected) && /<h1 id="title">/.test(connected) && (connected.match(/<svg[^>]*aria-hidden="true"|class="badge" aria-hidden="true"/g) || []).length >= 3 && /a:focus-visible/.test(connected));
} catch (e) { console.log("THREW", e && e.stack || e); fail++; }
console.log(`\n${fail === 0 ? "✓" : "✗"} ${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
