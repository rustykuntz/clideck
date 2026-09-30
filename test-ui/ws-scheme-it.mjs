// UI IT — the engine socket follows the page scheme: a page served over https (a TLS reverse proxy or
// tunnel in front of the loopback engine) must open wss://, or the browser blocks it as mixed content.
import { installFakeDom, installFakeWs } from "./fakedom.mjs";

installFakeDom();
globalThis.location = { protocol: "https:", host: "deck.example.com" };
installFakeWs();
const urls = [];
const Base = globalThis.WebSocket;
globalThis.WebSocket = class extends Base { constructor(url) { super(url); urls.push(url); } };
globalThis.WebSocket.OPEN = Base.OPEN;

let pass = 0, fail = 0;
const ok = (name, condition) => {
  if (condition) { pass++; console.log("  ok   " + name); }
  else { fail++; console.log("  FAIL " + name); }
};

try {
  const { connectWs } = await import("../public/js/ws.js");
  connectWs();
  ok("https page connects with wss://", urls[0] === "wss://deck.example.com");
  console.log(`\n${fail === 0 ? "✓" : "✗"} ${pass} passed, ${fail} failed`);
} catch (error) {
  console.log("THREW", error && error.stack || error); fail++;
}
process.exit(fail === 0 ? 0 : 1);
