import { installFakeDom, installFakeWs } from "./fakedom.mjs";
const { body } = installFakeDom();
Object.defineProperty(globalThis, "navigator", { configurable: true, value: { platform: "MacIntel", userAgent: "", clipboard: { writeText: async () => {} } } });
const ws = installFakeWs();
for (const id of ["settings-btn", "theme-btn"]) { const el = document.createElement("button"); el.id = id; body.append(el); }
const checks = [];
function ok(name, pass) { checks.push([name, !!pass]); console.log((pass ? "  ok   " : "  FAIL ") + name); }
const tick = () => new Promise((resolve) => setTimeout(resolve, 8));

const { connectWs } = await import("../public/js/ws.js");
const { store } = await import("../public/js/store.js");
const { openSettings } = await import("../public/js/ui/settings.js");
connectWs(); await tick(); openSettings(); await tick();
const echo = {
  id: "echo-tool", name: "Echo Tool", version: "1.2.0", apiVersion: 1, description: "A focused test plugin.", source: "user", enabled: true, status: "ready", error: "", commands: [{ name: "echo", description: "Echo text", usage: "echo-tool/echo" }],
  settings: [{ key: "prefix", label: "Prefix", type: "text", default: "echo:" }, { key: "token", label: "API token", type: "secret", default: "", group: "Advanced (optional)" }], values: { prefix: "say:" }, configured: { token: true }, clientUrl: "", hasWorkspaceAssets: false,
};
const helper = { id: "helper", name: "Helper", version: "0.2.0", description: "Another local extension.", source: "user", enabled: true, status: "ready", settings: [], values: {}, configured: {} };
store.applyEvent({ type: "plugins", plugins: [echo, helper] });
const pluginsCat = [...document.querySelectorAll(".set-cat")].find((el) => el.textContent === "Plugins");
pluginsCat._fire("click");
ok("Settings exposes a Plugins category", !!pluginsCat && !!document.querySelector(".plg-list"));
ok("inventory renders identity, version and ready state", document.querySelector(".plg-name")?.textContent === "Echo Tool" && document.querySelector(".plg-version")?.textContent === "v1.2.0" && !!document.querySelector(".plg-status.ready"));
const search = document.querySelector(".plg-search input"), originalSearch = search; search.focus();
for (const char of "echo tool") { search.value += char; search._fire("input"); }
ok("multi-character search preserves focus and caret node", document.querySelector(".plg-search input") === originalSearch && document.activeElement === originalSearch && search.value === "echo tool");
ok("search filters existing rows without rebuilding the list", [...document.querySelectorAll(".plg-row")].filter((row) => !row.hidden).length === 1 && document.querySelector(".plg-name")?.textContent === "Echo Tool");
// ⚠️ The empty-state card is BUILT hidden and revealed by the filter, so "hidden" is a claim that has to hold
// while there are still matches. It did not: `.plg-state`'s own `display:flex` beat the UA `[hidden]` rule and
// the card sat under three healthy rows on every Plugins pane (found in a release capture, 09-10). This
// asserts the attribute contract; whether it is actually INVISIBLE is CSS, and cdp-gate-plugindefaults owns it.
const emptyCard = () => document.querySelector(".plg-state.empty");
ok("a search that still matches something keeps the empty-state card hidden", emptyCard() && emptyCard().hidden === true);
for (const char of " zzz") { search.value += char; search._fire("input"); }
ok("filtering everything out hides every row", [...document.querySelectorAll(".plg-row")].every((row) => row.hidden));
ok("…and only then is the empty-state card unhidden", emptyCard() && emptyCard().hidden === false);
search.value = ""; search._fire("input");
ok("clearing the search brings the rows back and hides the card again",
  [...document.querySelectorAll(".plg-row")].every((row) => !row.hidden) && emptyCard().hidden === true);
document.querySelector(".plg-row-main")._fire("click");
ok("plugin row opens a focused detail view", document.querySelector(".plg-detail-name")?.textContent === "Echo Tool" && !!document.querySelector(".plg-back"));
const advanced = document.querySelector(".plg-setting-group");
ok("optional settings are collapsed under a descriptive label", advanced?.tagName === "DETAILS" && advanced.open === false && advanced.querySelector("summary")?.textContent === "Advanced (optional)" && !!advanced.querySelector("#plugin-setting-echo-tool-token"));
advanced.open = true; advanced._fire("toggle");
store.applyEvent({ type: "plugins", plugins: [echo, helper] });
ok("settings refresh preserves the user's expanded group", document.querySelector(".plg-setting-group")?.open === true);
const secret = document.querySelector("#plugin-setting-echo-tool-token");
ok("masked secrets are never projected back into the input", secret && secret.value === "" && /Saved/.test(secret.placeholder));
const clear = document.querySelector(".plg-clear"); clear._fire("click"); await tick();
const cleared = ws.last("plugin.settings.update");
ok("saved secrets have an explicit immediate clear action", cleared && cleared.settings.token === "" && clear.disabled === true && clear.textContent === "Cleared");
const stateSwitch = document.querySelector(".plg-detail-head")?.parentNode?.querySelector(".set-switch");
stateSwitch?._fire("click"); await tick();
const enable = ws.last("plugin.setEnabled");
ok("enable/disable uses a correlated plugin control", enable && enable.pluginId === "echo-tool" && enable.enabled === false && /^ui-/.test(enable.requestId));
store.applyEvent({ type: "plugin.result", operation: "setEnabled", success: true, pluginId: "echo-tool", requestId: enable.requestId });
ok("matching result clears the busy state and reports success", !!document.querySelector(".plg-notice.ok"));
const prefix = document.querySelector("#plugin-setting-echo-tool-prefix"); prefix.focus(); prefix.value = "next:"; prefix._fire("input");
await new Promise((resolve) => setTimeout(resolve, 480));
const setting = ws.last("plugin.settings.update");
ok("text settings save quietly with a correlated request", setting && setting.settings.prefix === "next:" && /^ui-/.test(setting.requestId));
store.applyEvent({ type: "plugins", plugins: [{ ...store.plugins[0], values: { prefix: "next:" } }, store.plugins[1]] });
ok("the settings echo does not replace the focused input", document.querySelector("#plugin-setting-echo-tool-prefix") === prefix && document.activeElement === prefix);
store.applyEvent({ type: "plugin.result", operation: "settings", success: false, error: "invalid value", pluginId: "echo-tool", requestId: setting.requestId });
ok("a quiet settings failure is still surfaced", !!document.querySelector(".plg-notice.bad") && /invalid value/.test(document.querySelector(".plg-notice.bad").textContent));
store.applyEvent({ type: "plugins", plugins: [{ ...store.plugins[0], status: "failed", error: "backend exploded" }, store.plugins[1]] });
ok("failed plugins expose a concise accessible failure panel", document.querySelector(".plg-failure")?.getAttribute("role") === "alert" && /backend exploded/.test(document.querySelector(".plg-failure")?.textContent || ""));

// Plugins shipped with CliDeck (optional ones off, like Dictation) are listed with no install step; the folder
// action is only for downloaded plugins and says so.
document.querySelector(".plg-back")._fire("click"); await tick();
const shipped = (id, name) => ({ id, name, version: "1.0.0", apiVersion: 1, description: name + " for CliDeck.", source: "bundled", enabled: false, status: "disabled", error: "", settings: [], values: {}, configured: {} });
store.applyEvent({ type: "plugins", plugins: [store.plugins[0], store.plugins[1], shipped("google", "Google Workspace"), shipped("telegram", "Telegram")] });
const rowOf = (name) => [...document.querySelectorAll(".plg-row")].find((row) => row.querySelector(".plg-name")?.textContent === name);
ok("shipped Google and Telegram are listed, switched off, with no install step",
  ["Google Workspace", "Telegram"].every((name) => { const row = rowOf(name), sw = row?.querySelector(".set-switch"); return !!row && sw?.getAttribute("aria-checked") === "false" && sw.disabled === false && !!row.querySelector(".plg-status.disabled"); }));
const addButton = [...document.querySelectorAll(".plg-head button")].find((el) => /Add from folder/.test(el.textContent));
ok("the folder action is labelled for downloaded plugins; the intro says shipped ones are already listed",
  !!addButton && /downloaded/.test(addButton.title) && /come with CliDeck are already listed/.test(document.querySelector(".plg-copy")?.textContent || "") && ![...document.querySelectorAll("button")].some((el) => /Install plugin/.test(el.textContent)));
addButton._fire("click"); await tick();
const trust = document.querySelector(".plg-trust");
ok("…and asks for the plugin's unpacked folder", /Add a downloaded plugin/.test(trust?.textContent || "") && /unpacked folder/.test(trust?.textContent || "") && /clideck-plugin\.json/.test(trust?.textContent || "") && [...trust.querySelectorAll("button")].some((el) => /Choose plugin folder/.test(el.textContent)));
rowOf("Google Workspace").querySelector(".set-switch")._fire("click"); await tick();
const turnOn = ws.last("plugin.setEnabled");
ok("turning a shipped plugin on uses the normal enable control", turnOn && turnOn.pluginId === "google" && turnOn.enabled === true && /^ui-/.test(turnOn.requestId));
store.applyEvent({ type: "plugin.result", operation: "setEnabled", success: true, pluginId: "google", requestId: turnOn.requestId });
store.applyEvent({ type: "plugins", plugins: [store.plugins[0], store.plugins[1], { ...shipped("google", "Google Workspace"), enabled: true, status: "ready" }, shipped("telegram", "Telegram")] });
ok("once the engine says so it shows on and ready", rowOf("Google Workspace")?.querySelector(".set-switch")?.getAttribute("aria-checked") === "true" && !!rowOf("Google Workspace").querySelector(".plg-status.ready"));
rowOf("Telegram").querySelector(".plg-row-main")._fire("click"); await tick();
ok("a shipped plugin's page says it comes with CliDeck and cannot be removed", /Bundled with CliDeck/.test(document.body.textContent) && /cannot be removed/.test(document.body.textContent) && !document.querySelector(".plg-remove"));
document.querySelector(".plg-back")._fire("click"); await tick();
store.applyEvent({ type: "plugins", plugins: [] });
ok("the empty state points to the folder action and the plugins folder", /Add a downloaded plugin from its folder/.test(document.querySelector(".plg-state")?.textContent || ""));

if (checks.some(([, pass]) => !pass)) process.exitCode = 1;
else console.log(`\n${checks.length}/${checks.length} plugin settings checks passed`);
