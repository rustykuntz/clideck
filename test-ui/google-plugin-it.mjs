// UI IT — Google Workspace plugin (plugin-packages/google): the client Worker's two entry points against a fake
// host API, and the account/status page against a fake parent frame bridge. Server answers follow the
// contract ('request' {requestId, action:'status'|'check'} → 'result' {requestId, ok, ...snapshot} or
// {requestId, ok:false, message}; 'updated' broadcasts the same snapshot). No gog, no network, no Google.
import { readFileSync } from "node:fs";
import { installFakeDom } from "./fakedom.mjs";
const dom = installFakeDom();

let pass = 0, fail = 0;
const ok = (name, yes, detail) => { if (yes) { pass++; console.log("  ok   " + name); } else { fail++; console.log("  FAIL " + name + (detail === undefined ? "" : " " + JSON.stringify(detail))); } };
const sleep = (ms = 5) => new Promise((r) => setTimeout(r, ms));
const accounts = [
  { email: "or@example.com", client: "default", services: ["gmail", "calendar", "drive"], auth: "oauth" },
  { email: "work@example.com", client: "work", services: ["gmail", "sheets"], auth: "oauth" },
  { email: "old@example.com", client: "default", services: [], auth: "oauth" },
];
const snap = (over = {}) => ({ available: true, version: "v0.9.0", executable: "/opt/homebrew/bin/gog", accounts, defaults: { account: "or@example.com", client: "" },
  checked: false, error: "", next: { message: "" }, ...over });

try {
  // ═════ Worker client ═════
  const { activate } = await import("../plugin-packages/google/client.js");
  const actions = new Map(), messages = new Map(), sent = [], toasts = [], opened = [], workspaces = [];
  let unregistered = 0;
  const api = {
    registerWorkspace: (def) => { workspaces.push(def); return () => unregistered++; },
    registerAction: (def) => { actions.set(def.id, def); return () => { unregistered++; actions.delete(def.id); }; },
    openWorkspace: (id, options) => opened.push({ id, options }),
    onMessage: (event, handler) => { messages.set(event, handler); return () => { unregistered++; messages.delete(event); }; },
    send: (event, data) => sent.push({ event, data }),
    toast: (kind, options) => toasts.push({ kind, ...options }),
  };
  const cleanup = activate(api);
  ok("worker: registers the account page under the plugin's public folder", workspaces[0]?.id === "account" && workspaces[0].title === "Google Workspace" && workspaces[0].src === "/plugins/google/public/index.html");
  ok("worker: 'Google Workspace' in the app menu and Configure on its Settings card", actions.get("open").label === "Google Workspace" && actions.get("open").placements.join() === "toolbar" && actions.get("configure").placements.join() === "plugin.settings");
  ok("worker: no background work — nothing sent on activate", sent.length === 0);
  actions.get("open").run({ surface: "toolbar", session: { id: "s1" } });
  actions.get("configure").run({ surface: "settings", session: { id: "s2" } });
  ok("worker: both open the page beside the current session", opened.length === 2 && opened.every((o) => o.id === "account") && opened[0].options.sessionId === "s1" && opened[1].options.sessionId === "s2");
  actions.get("configure").run({ surface: "settings", session: null });
  ok("worker: Configure with NO session still opens the page (the host shows it in the main pane), no toast", opened.length === 3 && opened[2].id === "account" && !opened[2].options.sessionId && toasts.length === 0);
  ok("worker: follows only the 'connection-requested' event", messages.size === 1 && messages.has("connection-requested"));
  messages.get("connection-requested")({ sessionId: "s7" });
  ok("worker: an agent's connection request opens the page beside that agent; nothing is sent", opened.length === 4 && opened[3].id === "account" && opened[3].options.sessionId === "s7" && sent.length === 0);
  messages.get("connection-requested")({});
  ok("worker: a request without a session still opens the page", opened.length === 5 && !opened[4].options.sessionId);
  cleanup();
  ok("worker: deactivation removes every contribution", actions.size === 0 && messages.size === 0 && unregistered === 4);

  // ═════ Account page ═════
  const root = document.createElement("main"); root.id = "root"; document.body.appendChild(root);
  const posts = []; let state = snap(), reply = null, hold = null;
  const answer = (data) => { const r = reply ? reply(data) : { ok: true, ...state }; dom.winFire("message", { source: parent, data: { type: "clideck.message", data: { event: "result", data: { requestId: data.requestId, ...r } } } }); };
  const parent = { postMessage: (m) => { posts.push(m); if (m.type === "clideck.send") { if (hold) hold.push(m.data); else setTimeout(() => answer(m.data), 1); } } };
  globalThis.parent = parent;
  // Record the page's request deadlines (first use may download gog, so status/check wait longer than a save).
  const deadlines = [], realTimeout = globalThis.setTimeout;
  globalThis.setTimeout = (fn, ms, ...rest) => { if (ms >= 1000) deadlines.push(ms); return realTimeout(fn, ms, ...rest); };
  new Function(readFileSync(new URL("../plugin-packages/google/public/app.js", import.meta.url), "utf8"))();
  const all = () => document.body._walk();
  const control = (name) => all().find((n) => n.dataset?.control === name);
  const text = () => root.textContent;
  const requests = () => posts.filter((m) => m.type === "clideck.send").map((m) => m.data);
  const lastReq = () => requests().at(-1);
  const chips = () => all().filter((n) => n.classList?.contains("plg-status")).map((n) => n.textContent);
  const accountRow = (email) => all().find((n) => n.dataset?.account === email);
  const init = (theme = "light") => dom.winFire("message", { source: parent, data: { type: "clideck.init", data: { context: { surface: "workspace", sessionId: "s1" }, theme } } });
  const updated = (s) => dom.winFire("message", { source: parent, data: { type: "clideck.message", data: { event: "updated", data: s } } });

  ok("page: says ready to the host", posts[0]?.type === "clideck.ready");
  dom.winFire("message", { source: {}, data: { type: "clideck.init", data: { theme: "light" } } });
  ok("page: ignores messages that are not from its parent", requests().length === 0);
  const progress = (data) => dom.winFire("message", { source: parent, data: { type: "clideck.message", data: { event: "install-progress", data } } });
  hold = [];
  init(); await sleep();
  ok("page: init checks sign-ins and takes the host theme", lastReq()?.action === "check" && requests().length === 1 && document.documentElement.getAttribute("data-theme") === "light");
  ok("page: check waits up to 210 s (first use may download gog)", deadlines.at(-1) === 210000, deadlines);
  init(); await sleep();
  ok("page: a second init does not reload", requests().length === 1);
  // What a person sees without opening any Details fold.
  const shown = (node = root) => { if (node.tagName === "DETAILS" && !node.open) return (node._kids.find((k) => k.tagName === "SUMMARY") || { textContent: "" }).textContent; if (node._text) return node._text; if (node._kids && node._kids.length) return node._kids.map((k) => (typeof k._walk === "function" ? shown(k) : k.textContent || "")).join(""); return node.textContent || ""; };
  progress({ state: "downloading", source: "managed", message: "Downloading gog v0.48.0…", percent: 42 });
  const bar = () => all().find((n) => n.getAttribute?.("role") === "progressbar");
  ok("install: honest 'Preparing Google connection' progress before the first snapshot", /Preparing Google connection/.test(text()) && /This happens once on this computer/.test(text()) && /42%/.test(text()) && bar()?.getAttribute("aria-valuenow") === "42" && chips()[0] === "Preparing");
  ok("install: no gog, download or version mechanics in the main copy", !/gog|v0\.48|github/i.test(shown()));
  progress({ state: "verifying", source: "managed", message: "" });
  ok("install: verifying is its own step; no percent → no number", /Checking the download/.test(text()) && !/%/.test(text()) && !!bar());
  progress({ state: "error", source: null, message: "Download failed: HTTP 503 from github.com" });
  ok("install: a failure says what to do; the exact error waits under Details; Try again waits for the pending reply", /couldn’t prepare the Google connection/.test(shown()) && /Check that this computer is online/.test(shown()) && !/HTTP 503/.test(shown()) && /HTTP 503 from github\.com/.test(text()) && control("install-retry").disabled === true && chips()[0] === "Not available");
  const first = hold.pop(); hold = null;
  state = snap({ available: false, version: "", executable: "", accounts: [], installation: { state: "error", source: null, message: "Download failed: HTTP 503 from github.com" } });
  answer(first); await sleep(30);
  ok("install: no automatic retry; Try again is offered; supported systems only under Details", requests().length === 1 && control("install-retry").disabled === false && /macOS 15 or later/.test(text()) && !/macOS 15 or later/.test(shown()) && !/succe|Installed by CliDeck/i.test(text()) && !/this Mac/.test(text()));
  state = snap({ installation: { state: "ready", source: "managed", message: "" } });
  control("install-retry")._fire("click"); await sleep();
  ok("install: Try again sends one status; Advanced names who installed gog", requests().length === 2 && lastReq().action === "status" && /Installed by CliDeck/.test(text()) && !bar() && !/couldn’t prepare/.test(text()));
  updated(snap({ installation: { state: "ready", source: "system", message: "" } })); await sleep();
  ok("install: an existing gog is named as such (Advanced)", /Existing gog on this computer/.test(text()) && !/Installed by CliDeck/.test(text()));
  updated(snap({ installation: { state: "ready", source: "custom", message: "" } })); await sleep();
  ok("install: a Settings path is named as such (Advanced)", /gog location set in Settings/.test(text()));
  // Every status reply verifies the sign-ins (main's contract): accounts arrive with valid/error.
  const verified = (over = {}) => snap({ checked: true, accounts: accounts.map((a) => ({ ...a, valid: true })), ...over });
  state = verified(); updated(state); await sleep();
  ok("page: lists every account with readable services", ["or@example.com", "work@example.com", "old@example.com"].every((e) => !!accountRow(e)) && /Gmail · Calendar · Drive/.test(accountRow("or@example.com").textContent) && /Gmail · Sheets/.test(accountRow("work@example.com").textContent) && /No services allowed/.test(accountRow("old@example.com").textContent));
  ok("page: no account is marked as a global default (defaults are per project now)", !/Default/.test(accountRow("or@example.com").textContent));
  ok("page: one state per account — Connected; no Stored / Not checked / Verified words", chips()[0] === "Connected" && chips().filter((c) => c === "Connected").length === 4 && !/Stored|Not checked|Verified|Check failed|Signed in/.test(text()));
  ok("page: no server 'next' lines echoed; main copy has no gog", !/appear below|Check a connection/.test(text()) && !/gog/i.test(shown().replace(/Advanced[\s\S]*$/, "")));
  ok("page: no global default account (chosen per project); sign-in file default explained, edited in Settings; gog version and path under Advanced", /gog’s own default/.test(text()) && !/Default account/.test(text()) && !all().some((n) => n.classList?.contains("gw-default")) && /Settings → Plugins → Google Workspace/.test(text()) && /v0\.9\.0/.test(text()) && /\/opt\/homebrew\/bin\/gog/.test(text()) && !/v0\.9\.0/.test(shown()) && !/this Mac/.test(text()));

  // A failing account: its next step comes first, above services; the exact error is collapsed.
  const setup3 = { setup: { clients: [{ name: "default" }, { name: "work" }], services: [{ id: "gmail", label: "Gmail" }, { id: "calendar", label: "Calendar" }, { id: "drive", label: "Drive" }], error: "", authorization: null } };
  state = verified({ ...setup3, accounts: [{ ...accounts[0], valid: true }, { ...accounts[1], valid: false, error: "oauth2: \"invalid_grant\" \"Token has been expired or revoked.\"" }, { ...accounts[2], valid: true }] });
  control("check")._fire("click");
  ok("page: Check again sends check and shows progress", lastReq().action === "check" && control("check").textContent === "Checking…");
  await sleep();
  const work = () => accountRow("work@example.com");
  ok("failing account: Needs reconnecting, plain reason, Reconnect as its next step", work().textContent.includes("Needs reconnecting") && /Google no longer accepts this sign-in/.test(shown(work())) && control("reconnect-work@example.com")?.className === "plg-primary");
  const order = (node, a, b) => { const t = shown(node); return t.indexOf(a) >= 0 && t.indexOf(b) >= 0 && t.indexOf(a) < t.indexOf(b); };
  ok("failing account: the failure and Reconnect sit above the service list", order(work(), "Google no longer accepts", "Gmail · Sheets") && order(work(), "Reconnect", "Gmail · Sheets"));
  ok("failing account: the exact error is under a closed Details fold", !/invalid_grant/.test(shown(work())) && /invalid_grant/.test(work().textContent) && all().some((n) => n.dataset?.control === "details-work@example.com" && n.open === false));
  ok("page: one failed account → overall Needs attention, others still Connected", chips()[0] === "Needs attention" && accountRow("or@example.com").textContent.includes("Connected"));
  ok("page: no generic server error card when an account explains it", !/couldn’t read your Google sign-ins/.test(text()));
  // valid:false is not always a revoked sign-in: a timeout must not send people back through Google.
  state = verified({ ...setup3, error: "A Google connection needs attention.", accounts: [{ ...accounts[0], valid: false, error: "Get \"https://oauth2.googleapis.com/tokeninfo\": context deadline exceeded (Client.Timeout exceeded while awaiting headers)" }, { ...accounts[1], valid: false, error: "oauth2: \"invalid_grant\" \"Token has been expired or revoked.\"" }, { ...accounts[2], valid: false }] });
  updated(state); await sleep();
  const orRow = () => accountRow("or@example.com"), oldRow = () => accountRow("old@example.com");
  ok("timeout: says Couldn't check with Check again — no Reconnect lead, no 'Needs reconnecting'", orRow().textContent.includes("Couldn’t check") && !orRow().textContent.includes("Needs reconnecting") && /couldn’t check this connection with Google/.test(shown(orRow())) && !!control("recheck-or@example.com") && control("reconnect-or@example.com")?.className === "gw-act");
  ok("timeout: the exact network error is collapsed under Details", !/deadline exceeded/.test(shown(orRow())) && /deadline exceeded/.test(orRow().textContent));
  ok("invalid_grant beside it: still Needs reconnecting with Reconnect first", work().textContent.includes("Needs reconnecting") && control("reconnect-work@example.com")?.className === "plg-primary");
  ok("valid:false without a reason is treated as couldn't check, not revoked", oldRow().textContent.includes("Couldn’t check") && !oldRow().textContent.includes("Needs reconnecting"));
  ok("header: a revoked account outranks couldn't-check → Needs attention", chips()[0] === "Needs attention");
  state = verified({ ...setup3, accounts: [{ ...accounts[0], valid: false, error: "dial tcp: lookup oauth2.googleapis.com: no such host" }, { ...accounts[1], valid: true }, { ...accounts[2], valid: true }] });
  updated(state); await sleep();
  ok("header: only couldn't-check failures → Couldn't check, not Needs attention", chips()[0] === "Couldn’t check");
  state = verified({ ...setup3 });
  control("recheck-or@example.com")._fire("click");
  ok("timeout: Check again sends one check", lastReq().action === "check");
  await sleep();
  ok("timeout: a successful re-check → Connected", orRow().textContent.includes("Connected") && !control("recheck-or@example.com"));
  updated({ ...state, error: "Some Google accounts need attention. See their connection errors.", accounts: state.accounts.map((a) => ({ ...a, valid: true, error: undefined })) }); await sleep();
  ok("page: all valid → Connected; a stale summary line isn't shown as its own error", chips()[0] === "Connected" || chips()[0] === "Needs attention");

  reply = () => ({ ok: false, message: "gog exited with code 1: keyring locked" });
  control("check")._fire("click"); await sleep();
  ok("page: a failed request is shown as an error and the last snapshot stays", /keyring locked/.test(text()) && !!accountRow("or@example.com") && control("check").disabled === false);
  reply = null;

  updated(verified({ error: "gog auth list: secret service unavailable", next: { message: "Open Google Cloud to check the project.", url: "https://console.cloud.google.com/auth/overview" } })); await sleep();
  ok("page: an error not tied to one account → one plain card, exact text under Details, Needs attention", chips()[0] === "Needs attention" && /couldn’t read your Google sign-ins/.test(shown()) && !/secret service unavailable/.test(shown()) && /secret service unavailable/.test(text()));
  ok("page: server 'next' text and links are not echoed", !/Open Google Cloud to check/.test(text()) && !control("next-link"));

  updated(snap({ available: false, version: "", executable: "/usr/local/bin/gog", accounts: [], next: { message: "Install gog to use Google Workspace." } })); await sleep();
  ok("page: not available → plain words + Try again; where it looked only under Details", chips()[0] === "Not available" && /Google connection isn’t ready on this computer/.test(shown()) && !/Looked for gog/.test(shown()) && /Looked for gog at \/usr\/local\/bin\/gog/.test(text()) && !!control("install-retry") && !control("check"));
  updated(snap({ accounts: [] })); await sleep();
  ok("page: no accounts (older backend) → Not connected, no terminal instructions", chips()[0] === "Not connected" && /No Google accounts yet/.test(text()) && !/terminal/i.test(text()));
  ok("page: no link to gog documentation anywhere", !control("docs") && !all().some((n) => /gogcli\.sh/.test(n.title || "")));

  updated({ unrelated: true }); await sleep();
  ok("page: a message that isn't a snapshot is ignored", chips()[0] === "Not connected");
  updated(snap({ accounts: [{ email: "<img src=x onerror=alert(1)>", services: ["<b>x</b>"], client: "", auth: "" }] })); await sleep();
  ok("page: account text is plain text, never markup", !all().some((n) => n.tagName === "IMG") && /<img src=x/.test(text()));
  dom.winFire("message", { source: parent, data: { type: "clideck.theme", data: { theme: "dark" } } });
  ok("page: follows host theme changes", document.documentElement.getAttribute("data-theme") === "dark");

  // ── Agent access (v2: per account, with per-project default accounts) ──
  ok("access: an older backend without access fields hides the editor with an update note", /Update the Google Workspace plugin to choose which agents can use each account/.test(text()) && !all().some((n) => /^access-mode/.test(n.dataset?.control || "")));
  const options = [
    { id: "p1", name: "ai_trading", sessions: [{ id: "s1", name: "researcher", provider: "claude", live: true }, { id: "s2", name: "helper", provider: "codex", live: false }] },
    { id: "p2", name: "clideck-next", sessions: [{ id: "s3", name: "UI", provider: "claude", live: true }] },
    { id: null, name: "No project", sessions: [{ id: "s9", name: "scratch", provider: "shell", live: true }] },
  ];
  const OR = "or@example.com|default", WORK = "work@example.com|work", OLD = "old@example.com|default";
  const v2 = (accountsRows = [], defaults = []) => ({ version: 2, accounts: accountsRows, defaults });
  const withAccess = (access, over = {}) => snap({ access, accessOptions: options, accessError: "", ...over });
  const pick = (name, value) => { const c = control(name); c.value = value; c._fire("change"); };
  const tick = (acct, id, on) => { const c = control("agent-" + acct + "-" + id); c.checked = on; c._fire("change"); };
  const saves = () => requests().filter((r) => r.action === "access-save");
  const block = (email) => all().filter((n) => n.classList?.contains("gw-acct-access")).find((n) => n.textContent.startsWith(email));
  updated(withAccess({ mode: "all", projects: [] })); await sleep();
  ok("access: a not-yet-moved single policy is never edited as per-account access; says the earlier choice applies", /Access per account appears once CliDeck has read your Google accounts\. Until then, the earlier choice still applies\./.test(text()) && !/Update the Google Workspace plugin/.test(text()) && !control("access-mode-" + OR));
  state = withAccess(v2([{ email: "or@example.com", client: "default", mode: "all", projects: [] }])); updated(state); await sleep();
  ok("access: one editor per connected account; no Save until something changes", control("access-mode-" + OR).value === "all" && control("access-mode-" + WORK).value === "selected" && control("access-mode-" + OLD).value === "selected" && !control("access-save") && !/Unsaved changes/.test(text()));
  ok("access: an account without a row can't be used by any agent, and says so", /No agent can use this account yet/.test(block("work@example.com").textContent) && /Every agent, in every project/.test(block("or@example.com").textContent));
  const listed = (cls) => all().filter((n) => n.classList?.contains(cls)).map((n) => (n.dataset.account || n.dataset.access || "").split("|")[0]);
  ok("access: accounts no agent can use yet come first, in Accounts and in Agent access alike",
    listed("gw-acct")[listed("gw-acct").length - 1] === "or@example.com" && listed("gw-acct-access").at(-1) === "or@example.com" && listed("gw-acct")[0] !== "or@example.com");
  const pill = (email) => control("setup-access-" + email);
  ok("access: beside each unassigned email, 'Set up access to projects and agents' — not for one that has access",
    !!pill("work@example.com") && /Set up access to projects and agents/.test(pill("work@example.com").textContent) && !pill("or@example.com"));
  ok("access: the pill sits in the email line, next to the address", pill("work@example.com").parentNode?.classList.contains("gw-email"));
  ok("access: new accounts start unassigned — said once under the section", /New accounts start with no agent access\./.test(text()) && /agents may still access Google through other tools on this computer\./.test(text()));
  ok("access: one account allowed everywhere → no default account choice yet", !all().some((n) => /^default-/.test(n.dataset?.control || "") || n.classList?.contains("gw-defaults")));
  pick("access-mode-" + OR, "selected");
  ok("access: Selected projects with none chosen = no access, unsaved", /No agent can use this account yet/.test(block("or@example.com").textContent) && /Unsaved changes/.test(text()) && control("access-save").disabled === false && saves().length === 0);
  pick("access-add-" + OR, "p-p1");
  ok("access: adding a project starts with All agents", /ai_trading/.test(block("or@example.com").textContent) && control("agents-" + OR + "-p-p1")?.value === "all" && !control("agent-" + OR + "-s1"));
  pick("agents-" + OR + "-p-p1", "selected");
  ok("access: Selected agents lists that project's agents only, with provider and stopped", !!control("agent-" + OR + "-s1") && !!control("agent-" + OR + "-s2") && !control("agent-" + OR + "-s3") && /codex · stopped/.test(text()) && /No agent chosen: nobody in this project can use this account/.test(text()));
  tick(OR, "s1", true);
  ok("access: checking an agent clears the none-chosen warning", control("agent-" + OR + "-s1").checked === true && !/No agent chosen/.test(text()));
  pick("access-mode-" + OLD, "all");
  ok("access: edits to several accounts are kept together, each in its own block", control("access-mode-" + OLD).value === "all" && control("agent-" + OR + "-s1").checked === true && control("access-mode-" + OR).value === "selected");
  pick("access-mode-" + OLD, "selected");
  ok("access: editing one account leaves the others alone", control("access-mode-" + WORK).value === "selected" && !control("access-add-" + WORK + "x") && !control("agents-" + WORK + "-p-p1"));

  updated(withAccess(state.access, { checked: true, accounts: accounts.map((a) => ({ ...a, valid: true })) })); await sleep();
  ok("access: a status/check broadcast does not discard unsaved edits", control("access-mode-" + OR).value === "selected" && control("agent-" + OR + "-s1").checked === true && /Unsaved changes/.test(text()) && chips()[0] === "Connected");

  reply = (data) => data.action === "access-save" ? { ok: false, message: "Session s1 is not in project p1." } : { ok: true, ...state };
  control("access-save")._fire("click"); await sleep();
  ok("access: a rejected save shows the server's reason and keeps the edits", /Session s1 is not in project p1/.test(text()) && control("agent-" + OR + "-s1").checked === true && /Unsaved changes/.test(text()) && !/Access saved/.test(text()));

  reply = null; hold = [];
  control("access-save")._fire("click");
  let saving = hold.pop(); hold = null;
  ok("access: saving is quick (20 s deadline)", deadlines.at(-1) === 20000, deadlines.slice(-3));
  const expected = v2([{ email: "or@example.com", client: "default", mode: "selected", projects: [{ projectId: "p1", agents: "selected", sessionIds: ["s1"] }] }]);
  ok("access: Save sends the whole v2 access object, no optimistic success", saving.action === "access-save" && JSON.stringify(saving.access) === JSON.stringify(expected) && control("access-save").textContent === "Saving…" && !/Access saved/.test(text()) && control("access-mode-" + OR).disabled === true, saving.access);
  state = withAccess(saving.access); answer(saving); await sleep();
  ok("access: after the server's ok the saved state shows, confirmed", /Access saved/.test(text()) && !/Unsaved changes/.test(text()) && control("access-mode-" + OR).value === "selected" && control("agent-" + OR + "-s1").checked === true && !control("access-save"));

  // A second account allowed in p1 → p1 gets a default account choice; projects only one account serves don't.
  pick("access-mode-" + WORK, "all");
  ok("access: two accounts allowed in a project → its default account choice appears (only there)", !!control("default-p-p1") && control("default-p-p1").value === "" && !control("default-p-p2") && !control("default-none") && /Default account/.test(text()) && /with No default, they must name one/.test(text()));
  ok("access: default choices list only the accounts allowed there", [...control("default-p-p1")._kids].map((o) => o.textContent).join("|") === "No default|or@example.com|work@example.com");
  pick("default-p-p1", WORK);
  control("access-save")._fire("click"); await sleep();
  ok("access: the default is saved per project with the account's email and sign-in file", JSON.stringify(saves().at(-1).access) === JSON.stringify(v2([expected.accounts[0], { email: "work@example.com", client: "work", mode: "all", projects: [] }], [{ projectId: "p1", email: "work@example.com", client: "work" }])), saves().at(-1).access);
  state = withAccess(saves().at(-1).access); updated(state); await sleep();
  ok("access: the saved default shows", control("default-p-p1").value === WORK && !control("access-save"));
  pick("access-mode-" + WORK, "selected"); pick("access-add-" + WORK, "p-p1"); pick("agents-" + WORK + "-p-p1", "selected");
  ok("access: like the server, a project where no agent is chosen doesn't count as allowed for a default", !control("default-p-p1"));
  control("access-discard")._fire("click");
  pick("access-mode-" + WORK, "selected");
  ok("access: taking the default account out of the project drops its default and the choice", !control("default-p-p1") && /Unsaved changes/.test(text()));
  control("access-discard")._fire("click");

  pick("access-add-" + OR, "none"); pick("agents-" + OR + "-none", "selected"); tick(OR, "s9", true);
  control("access-save")._fire("click"); await sleep();
  ok("access: 'No project' is saved as projectId null", JSON.stringify(saves().at(-1).access.accounts[0].projects.at(-1)) === JSON.stringify({ projectId: null, agents: "selected", sessionIds: ["s9"] }));
  state = withAccess(saves().at(-1).access); updated(state); await sleep();

  control("remove-" + OR + "-p-p1")._fire("click");
  ok("access: removing a project is an unsaved edit", !control("agents-" + OR + "-p-p1") && /Unsaved changes/.test(text()));
  control("access-discard")._fire("click");
  ok("access: Discard returns to the saved state", !!control("agents-" + OR + "-p-p1") && !/Unsaved changes/.test(text()));

  tick(OR, "s2", true);
  updated(withAccess(v2())); await sleep();
  ok("access: a change made elsewhere while editing is pointed out; edits kept", /changed elsewhere while you were editing/.test(text()) && control("agent-" + OR + "-s2").checked === true);
  control("access-discard")._fire("click");
  ok("access: Discard then shows the other change", control("access-mode-" + OR).value === "selected" && /No agent can use this account yet/.test(block("or@example.com").textContent) && !/changed elsewhere/.test(text()));

  updated(withAccess(v2([{ email: "OR@example.com", client: "default", mode: "selected", projects: [{ projectId: "p1", agents: "selected", sessionIds: ["s1", "gone"] }, { projectId: "deleted", agents: "all", sessionIds: [] }] },
    { email: "old@example.com", client: "default", mode: "selected", projects: [] }], [{ projectId: "p1", email: "old@example.com", client: "default" }, { projectId: "deleted", email: "or@example.com", client: "default" }]))); await sleep();
  ok("access: unknown agents/projects, empty rows and stale defaults in the saved state don't count as unsaved edits", control("agent-" + OR + "-s1").checked === true && !control("agents-" + OR + "-p-deleted") && !control("access-save"));
  ok("access: accounts match by email case-insensitively", control("access-mode-" + OR).value === "selected" && !!control("agents-" + OR + "-p-p1"));
  updated(withAccess(v2(), { accessError: "access.json is not valid JSON; nothing was changed." })); await sleep();
  ok("access: a storage diagnostic is shown", /access\.json is not valid JSON/.test(text()) && !!control("access-mode-" + OR));
  updated(withAccess(v2(), { accounts: [] })); await sleep();
  ok("access: with no accounts, it says where access will be chosen", /Once an account is connected, choose here which projects and agents can use it/.test(text()) && !all().some((n) => /^access-mode/.test(n.dataset?.control || "")));

  // ── Setup inside CliDeck: sign-in file, Google sign-in, reconnect, disconnect ──
  const services = [{ id: "gmail", label: "Gmail", apis: ["gmail.googleapis.com"] }, { id: "calendar", label: "Calendar", apis: ["calendar-json.googleapis.com"] }, { id: "drive", label: "Drive", apis: ["drive.googleapis.com"] }];
  const setupSnap = (setup = {}, over = {}) => snap({ access: v2(), accessOptions: options, accessError: "", setup: { clients: [], services, error: "", authorization: null, ...setup }, ...over });
  const pressed = (name) => control(name)?.getAttribute("aria-pressed") === "true";
  const file = (content) => ({ name: "client.json", size: content.length, text: async () => content });
  const choose = async (name, content) => { const input = control(name); input.files = [file(content)]; input._fire("change"); await sleep(); };
  const opens = () => posts.filter((m) => m.type === "clideck.open").length;
  const asked = (action) => requests().filter((r) => r.action === action);
  let router = {};
  reply = (data) => router[data.action] ? router[data.action](data) : { ok: true, ...state };

  state = setupSnap({}, { accounts: [] }); updated(state); await sleep();
  ok("setup: first time → Gmail, Calendar and Drive with Read and change by default", /Connect your Google account/.test(text()) && ["gmail", "calendar", "drive"].every((id) => control("service-" + id).checked === true) && pressed("level-write") && !pressed("level-read") && control("level-read").disabled === false);
  ok("setup: no sign-in file yet → the one-time guide is inline with Google's own pages", /One-time setup: a Google sign-in file/.test(text()) && /Set this up once/.test(text()) && !/free|five minutes/i.test(text()) && /Desktop app/.test(text()) && /Test users/.test(text()) && /console\.cloud\.google\.com\/flows\/enableapi\?apiid=gmail\.googleapis\.com,calendar-json\.googleapis\.com,drive\.googleapis\.com$/.test(control("guide-apis").title) && !/gogcli|terminal/i.test(text()));
  ok("setup: the guide says Create OAuth client (Desktop app) like Google does", /Create an OAuth client/.test(text()) && /Create OAuth client → Application type: Desktop app/.test(text()) && control("guide-client").textContent === "Create OAuth client" && !/Create client/.test(text()));
  ok("setup: test users are their own step, explained for Testing", /Add yourself as a test user/.test(text()) && /While the app is in Testing, Google lets only its test users sign in/.test(text()) && /In the same project: Google Auth Platform → Audience → Test users → Add users, enter the exact email you’ll sign in with, then Save\./.test(text()) && control("guide-audience").textContent === "Open Audience");
  ok("setup: the first-time guide doesn't repeat the blocked-sign-in help", !control("fold-blocked"));
  ok("setup: the guide says where the file stays", /Your sign-in file stays on the computer running CliDeck\./.test(text()) && !/handed to gog/.test(text()));
  ok("setup: Sign in waits for the file and says why", control("auth-start").disabled === true && /Add your custom Google connection under Advanced/.test(text()));
  control("service-drive").checked = false; control("service-drive")._fire("change");
  ok("setup: the API link follows the chosen services", control("guide-apis").title.endsWith("gmail.googleapis.com,calendar-json.googleapis.com") && /For Gmail, Calendar/.test(text()));
  control("guide-project")._fire("click");
  ok("setup: guide links open Google Cloud through the host", posts.at(-1).type === "clideck.open" && posts.at(-1).url === "https://console.cloud.google.com/projectcreate");

  await choose("credentials-file", JSON.stringify({ web: { client_id: "x" } }));
  ok("setup: a Web application file is refused with what to do instead; nothing sent", /Web application/.test(text()) && /Desktop app client/.test(text()) && asked("credentials-save").length === 0);
  await choose("credentials-file", "not json");
  ok("setup: a non-JSON file is refused", /isn’t a JSON file from Google/.test(text()) && asked("credentials-save").length === 0);
  const secret = "GOCSPX-very-secret";
  router["credentials-save"] = () => { state = setupSnap({ clients: [{ name: "default" }] }, { accounts: [] }); return { ok: true, ...state }; };
  await choose("credentials-file", JSON.stringify({ installed: { client_id: "1.apps.googleusercontent.com", client_secret: secret } })); await sleep();
  const saveReq = asked("credentials-save").at(-1);
  ok("setup: the Desktop app JSON goes to the server as text for the default client", saveReq && saveReq.client === "default" && saveReq.replace === false && JSON.parse(saveReq.json).installed.client_secret === secret);
  ok("setup: once saved, the guide steps away; the secret is never shown", !/One-time setup/.test(text()) && /Google sign-in file saved/.test(text()) && !text().includes(secret) && !all().some((n) => String(n.value || "").includes(secret)));
  const blocked = () => control("fold-blocked");
  ok("blocked help: once a sign-in file exists, a closed “Google blocked the sign-in?” fold is in the form", blocked()?.open === false && /Google blocked the sign-in\?/.test(blocked().textContent) && /If Google says the app is being tested and only approved testers can use it/.test(blocked().textContent) && /Open the same Google Cloud project as the sign-in file you added/.test(blocked().textContent) && /Audience → Test users → Add users/.test(blocked().textContent) && /exact email you’re signing in with, then Save/.test(blocked().textContent) && /Then sign in again/.test(blocked().textContent));
  ok("blocked help: says Google may show the app as not verified yet, promises nothing", /may say this app hasn’t been verified yet/.test(blocked().textContent) && !/will be verified|is verified|approved app|publish|bypass|skip/i.test(blocked().textContent));
  control("blocked-audience")._fire("click");
  ok("blocked help: Open Audience goes to Google's Audience page", posts.at(-1).type === "clideck.open" && posts.at(-1).url === "https://console.cloud.google.com/auth/audience");
  ok("setup: Sign in still needs the account email", control("auth-start").disabled === true && /Enter the Google account’s email/.test(text()));
  control("auth-email").value = "or@example.com"; control("auth-email")._fire("input");
  ok("setup: the chosen services and access level are spelled out before sign-in", control("auth-start").disabled === false && /Agents can read and make changes in Gmail and Calendar, including sending and deleting\./.test(text()));

  const before = opens(), expires = Date.now() + 10 * 60000;
  router["auth-start"] = () => { state = setupSnap({ clients: [{ name: "default" }], authorization: { id: "a1", status: "waiting", email: "or@example.com", client: "default", url: "https://accounts.google.com/o/oauth2/auth?state=s1", message: "", expiresAt: new Date(expires).toISOString() } }, { accounts: [] }); return { ok: true, ...state }; };
  control("auth-start")._fire("click"); await sleep();
  ok("setup: auth-start sends exactly the chosen email, client, services and read-only", JSON.stringify(asked("auth-start").at(-1), ["action", "email", "client", "services", "readonly", "gmailScope", "driveScope"]) === JSON.stringify({ action: "auth-start", email: "or@example.com", client: "default", services: ["gmail", "calendar"], readonly: false }));
  ok("setup: waiting → Open Google sign-in button with expiry; Google's page is NOT opened automatically", /Approve access for or@example\.com/.test(text()) && !!control("auth-open") && /Link expires in 10 min/.test(text()) && opens() === before);
  updated(state); await sleep();
  ok("setup: a later broadcast doesn't open it either", opens() === before);
  const signInUrl = state.setup.authorization.url;
  let copiedUrl = '';
  Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText: async url => { copiedUrl = url; } } });
  control("auth-copy")._fire("click"); await sleep();
  ok("copy sign-in link uses the pending URL without opening a browser", copiedUrl === signInUrl && control("auth-copy").textContent === "Copied" && opens() === before);
  navigator.clipboard.writeText = async () => { throw new Error("Clipboard denied"); };
  document.execCommand = action => action === 'copy' && document.activeElement.value === signInUrl;
  control("auth-copy")._fire("click"); await sleep();
  ok("sandboxed copy uses the selected URL", control("auth-copy-url").hidden && document.activeElement === control("auth-copy"));
  document.execCommand = () => false;
  control("auth-copy")._fire("click"); await sleep();
  ok("when clipboard access is blocked the exact link is selected for manual copying", !control("auth-copy-url").hidden && document.activeElement.value === signInUrl && document.activeElement.selectionEnd === signInUrl.length);
  delete navigator.clipboard;
  delete document.execCommand;
  ok("blocked help: also on the waiting card, saying to cancel this attempt and sign in again", /Cancel this sign-in below, then sign in again/.test(blocked()?.textContent || "") && blocked().open === false);
  control("auth-open")._fire("click");
  ok("setup: the button opens Google's sign-in through the host", opens() === before + 1 && posts.at(-1).url === "https://accounts.google.com/o/oauth2/auth?state=s1");
  ok("setup: the paste-the-address fallback starts closed and disabled", control("fold-paste")?.open === false && control("auth-complete").disabled === true);
  control("auth-url").value = "http://127.0.0.1:5555/oauth2/callback?code=c&state=wrong"; control("auth-url")._fire("input");
  router["auth-complete"] = () => ({ ok: false, message: "That address isn’t from this sign-in. Copy it again from the page that didn’t load." });
  control("auth-complete")._fire("click"); await sleep();
  const done = asked("auth-complete").at(-1);
  ok("setup: auth-complete sends the sign-in id and the pasted address; a refusal is shown, still waiting", done.id === "a1" && done.url === "http://127.0.0.1:5555/oauth2/callback?code=c&state=wrong" && /isn’t from this sign-in/.test(text()) && !!control("auth-open"));
  const connected = { email: "or@example.com", client: "default", services: ["gmail", "calendar"], auth: "oauth", scopes: ["https://www.googleapis.com/auth/gmail.readonly", "https://www.googleapis.com/auth/calendar.readonly", "openid", "email"] };
  state = setupSnap({ clients: [{ name: "default" }], authorization: { id: "a1", status: "connected", email: "or@example.com", client: "default" } }, { accounts: [connected] });
  updated(state); await sleep();
  ok("setup: gog confirmed → Connected, pointing to Agent access because a new account starts unassigned; listed with its access in plain words", /Connected or@example\.com\. Choose which agents can use it under Agent access\./.test(text()) && !/agents can use it now/i.test(text()) && /Read only/.test(accountRow("or@example.com").textContent) && !control("auth-start") && !!control("connect-open"));
  control("auth-dismiss")._fire("click");
  ok("setup: the result can be dismissed", !/Connected or@example\.com/.test(text()));
  state = setupSnap({ clients: [{ name: "default" }], authorization: { id: "a1r", status: "connected", email: "or@example.com", client: "default" } }, { accounts: [connected], access: v2([{ email: "or@example.com", client: "default", mode: "all", projects: [] }]) });
  updated(setupSnap({ clients: [{ name: "default" }], authorization: { id: "a1r", status: "waiting", email: "or@example.com", url: "https://accounts.google.com/r" } }, { accounts: [connected] })); await sleep();
  updated(state); await sleep();
  ok("setup: an account that already has agent access connects without the Agent access pointer", /Connected or@example\.com\./.test(text()) && !/Choose which agents can use it/.test(text()));
  control("auth-dismiss")._fire("click");

  control("reconnect-or@example.com")._fire("click");
  ok("Reconnect brings the account’s sign-in form into focus", document.activeElement?.id === "google-connect-heading");
  ok("reconnect (existing read-only grant): same email locked, same services, Read only kept from the actual grant", /Reconnect or@example\.com/.test(text()) && control("auth-email").value === "or@example.com" && control("auth-email").readOnly === true && control("service-calendar").checked === true && control("service-drive").checked === false && pressed("level-read") && !pressed("level-write") && /Kept from this account’s current access/.test(text()) && /Agents can read Gmail and Calendar\. They can’t send, change or delete anything\./.test(text()) && control("auth-start").disabled === false);
  router["auth-start"] = () => { state = setupSnap({ clients: [{ name: "default" }], authorization: { id: "a1b", status: "waiting", email: "or@example.com", client: "default", url: "https://accounts.google.com/x2" } }, { accounts: [connected] }); return { ok: true, ...state }; };
  control("auth-start")._fire("click"); await sleep();
  ok("reconnect: kept read-only → auth-start readonly:true for the same email, client and services", JSON.stringify(asked("auth-start").at(-1), ["email", "client", "services", "readonly", "gmailScope"]) === JSON.stringify({ email: "or@example.com", client: "default", services: ["gmail", "calendar"], readonly: true }));
  router["auth-cancel"] = (data) => { state = setupSnap({ clients: [{ name: "default" }], authorization: { id: data.id, status: "cancelled", message: "Sign-in stopped. Check connections before starting again." } }, { accounts: [connected] }); return { ok: true, ...state }; };
  control("auth-cancel")._fire("click"); await sleep();
  ok("reconnect: cancelling shows the server's message and the form is back to try again", asked("auth-cancel").at(-1)?.id === "a1b" && /Sign-in stopped/.test(text()) && !!control("auth-start") && pressed("level-read"));
  control("auth-dismiss")._fire("click");
  control("level-write")._fire("click");
  ok("reconnect: read and change reveals fine-tuning, closed", /Agents can read, send, change and delete\./.test(text()) && control("fold-scopes")?.open === false && !!control("gmail-scope") && !control("drive-scope"));
  control("gmail-scope").value = "send"; control("gmail-scope")._fire("change");
  ok("reconnect: the summary names a narrower Gmail choice", /Agents can read and make changes in Gmail \(send only\) and Calendar/.test(text()));
  router["auth-start"] = () => { state = setupSnap({ clients: [{ name: "default" }], authorization: { id: "a2", status: "starting", email: "or@example.com", client: "default" } }, { accounts: [connected] }); return { ok: true, ...state }; };
  control("auth-start")._fire("click"); await sleep();
  ok("reconnect: auth-start carries read-and-change and the Gmail choice only", JSON.stringify(asked("auth-start").at(-1), ["email", "client", "services", "readonly", "gmailScope", "driveScope"]) === JSON.stringify({ email: "or@example.com", client: "default", services: ["gmail", "calendar"], readonly: false, gmailScope: "send" }) && /Getting Google sign-in ready/.test(text()));
  state = setupSnap({ clients: [{ name: "default" }], authorization: { id: "a2", status: "failed", email: "or@example.com", message: "access_denied" } }, { accounts: [connected] });
  updated(state); await sleep();
  ok("reconnect: a failed sign-in says why and the form stays to try again", /Sign-in didn’t finish: access_denied/.test(text()) && !!control("auth-start") && control("auth-start").disabled === false);
  control("connect-cancel")._fire("click");
  updated(setupSnap({ clients: [{ name: "default" }], authorization: { id: "a3", status: "waiting", email: "x@example.com", url: "https://accounts.google.com/x" } }, { accounts: [connected] })); await sleep();
  router["auth-cancel"] = (data) => { state = setupSnap({ clients: [{ name: "default" }], authorization: { id: data.id, status: "cancelled", message: "Sign-in stopped. Check connections before starting again." } }, { accounts: [connected] }); return { ok: true, ...state }; };
  ok("setup: a sign-in started elsewhere still shows its waiting state", /Approve access for x@example\.com/.test(text()) && control("reconnect-or@example.com").disabled === true);
  control("auth-cancel")._fire("click"); await sleep();
  ok("setup: Cancel sends auth-cancel for that sign-in and shows the server's message", asked("auth-cancel").at(-1)?.id === "a3" && /Sign-in stopped/.test(text()));

  control("disconnect-or@example.com")._fire("click");
  ok("disconnect: asks first and explains the shared saved sign-in", /Disconnect or@example\.com\?/.test(text()) && /removes its saved sign-in from this computer/.test(text()) && /Agents and other tools here that use this sign-in/.test(text()) && !/gog/.test(all().find((n) => n.getAttribute?.("role") === "alertdialog")?.textContent || "gog") && asked("account-remove").length === 0);
  control("disconnect-cancel")._fire("click");
  ok("disconnect: Cancel keeps the account", !/Disconnect or@example\.com\?/.test(text()) && asked("account-remove").length === 0);
  router["account-remove"] = () => { state = setupSnap({ clients: [{ name: "default" }, { name: "work" }] }, { accounts: [] }); return { ok: true, ...state }; };
  control("disconnect-or@example.com")._fire("click"); control("disconnect-yes")._fire("click"); await sleep();
  ok("disconnect: confirmed → account-remove {email, client}; shown only after the server's snapshot", JSON.stringify(asked("account-remove").at(-1), ["email", "client"]) === JSON.stringify({ email: "or@example.com", client: "default" }) && /Disconnected or@example\.com/.test(text()) && !accountRow("or@example.com"));

  ok("advanced: technical details are folded away", control("fold-advanced")?.open === false && /Sign-in files/.test(text()) && /Installed by CliDeck|v0\.9\.0/.test(text()));
  router["credentials-remove"] = () => ({ ok: false, message: "An account still uses this sign-in file." });
  control("client-remove-work")._fire("click"); control("client-remove-yes")._fire("click"); await sleep();
  ok("advanced: removing a sign-in file asks first and shows the server's refusal", asked("credentials-remove").at(-1)?.client === "work" && /An account still uses this sign-in file/.test(text()));
  control("client-name").value = "work"; control("client-name")._fire("change");
  ok("advanced: an existing name needs Replace ticked before a file can be chosen", !!control("client-replace") && control("client-file-choose").disabled === true);
  control("client-name").value = "all"; control("client-name")._fire("change");
  ok("advanced: “all” (reserved) and odd names are refused before upload", /“all” is reserved/.test(text()) && control("client-file-choose").disabled === true);
  control("client-name").value = "Work"; control("client-name")._fire("change");
  control("client-replace").checked = true; control("client-replace")._fire("change");
  router["credentials-save"] = () => ({ ok: true, ...state });
  await choose("client-file", JSON.stringify({ installed: { client_id: "2", client_secret: "s2" } })); await sleep();
  ok("advanced: replacing sends client name + replace:true", JSON.stringify(asked("credentials-save").at(-1), ["client", "replace"]) === JSON.stringify({ client: "work", replace: true }) && /Sign-in file “work” saved/.test(text()));
  const ads = { id: "ads", label: "Google Ads", apis: ["googleads.googleapis.com"], supportsReadonly: false };
  updated(setupSnap({ clients: [{ name: "default" }], services: [...services, ads] }, { accounts: [] })); await sleep();
  control("auth-email").value = "ads@example.com"; control("auth-email")._fire("input");
  ok("ads: never chosen by default; it waits under a closed More services", control("service-ads").checked === false && control("fold-more-services")?.open === false && pressed("level-write"));
  control("service-ads").checked = true; control("service-ads")._fire("change");
  ok("ads: ticked with Read and change → can sign in; Read only is disabled upfront with the reason", pressed("level-write") && control("level-read").disabled === true && /Google Ads works only with Read and change\. Untick it to choose Read only\./.test(text()) && control("auth-start").disabled === false && /More services \(1 chosen\)/.test(text()));
  control("level-read")._fire("click");
  ok("ads: the disabled Read only can't be chosen; nothing is flipped", pressed("level-write") && control("service-ads").checked === true);
  control("service-ads").checked = false; control("service-ads")._fire("change"); control("level-read")._fire("click");
  ok("ads: unticked → Read only works, and Google Ads is disabled there with a reason", pressed("level-read") && control("service-ads").disabled === true && control("service-ads").checked === false && /Needs Read and change/.test(text()) && control("auth-start").disabled === false);
  // A configured client (Ubuntu: "clideck") is what new sign-ins use; other saved clients stay out of the form.
  updated(setupSnap({ clients: [{ name: "default" }, { name: "rocie" }] }, { accounts: [], defaults: { account: "", client: "clideck" } })); await sleep();
  control("connect-cancel")?._fire("click"); await sleep();
  ok("client: waits for the built-in connection without a manual upload", /Preparing CliDeck’s Google connection/.test(text()) && !control("auth-client") && !control("credentials-file") && control("auth-start").disabled);
  updated(setupSnap({ clients: [{ name: "default" }, { name: "rocie" }, { name: "clideck" }] }, { accounts: [], defaults: { account: "", client: "clideck" } })); await sleep();
  control("auth-email").value = "new@example.com"; control("auth-email")._fire("input");
  router["auth-start"] = () => { state = setupSnap({ clients: [{ name: "clideck" }], authorization: { id: "a9", status: "waiting", email: "new@example.com", client: "clideck", url: "https://accounts.google.com/x9" } }, { accounts: [], defaults: { account: "", client: "clideck" } }); return { ok: true, ...state }; };
  control("auth-start")._fire("click"); await sleep();
  ok("client: the sign-in uses the configured client", asked("auth-start").at(-1)?.client === "clideck");
  const passkey = control("fold-passkey");
  ok("passkey help: a closed fold on the waiting card with Google's own help, no promise to skip or speed up", passkey?.open === false && /Try another way/.test(passkey.textContent) && /only Google decides how long/.test(passkey.textContent) && !/bypass|skip|faster|shorten/i.test(passkey.textContent));
  control("help-2sv")._fire("click");
  ok("passkey help: links open Google's support pages through the host", posts.at(-1).url === "https://support.google.com/accounts/answer/185834");
  control("help-recovery")._fire("click");
  ok("passkey help: recovery delays link", posts.at(-1).url === "https://support.google.com/accounts/answer/9412469");
  // Or's case: reconnecting a legacy all-services account whose grant isn't reported (no scopes), Ads included.
  const legacy = { email: "legacy@example.com", client: "default", auth: "oauth", services: ["gmail", "calendar", "drive", "ads"], scopes: [] };
  state = setupSnap({ clients: [{ name: "default" }], services: [...services, ads] }, { accounts: [legacy], checked: true });
  updated(state); await sleep();
  control("reconnect-legacy@example.com")._fire("click"); await sleep();
  ok("legacy reconnect (unknown grant + Ads): starts Read only, Ads left out — not kept selected while disabled", pressed("level-read") && control("service-ads").checked === false && control("service-ads").disabled === true && ["gmail", "calendar", "drive"].every((id) => control("service-" + id).checked));
  ok("legacy reconnect: a short note says Ads was left out and how to include it", /Google Ads was left out because it needs Read and change\. To include it, choose Read and change and tick it again\./.test(text()) && !/Untick it/.test(text()));
  ok("legacy reconnect: the form is valid as shown", control("auth-start").disabled === false && /CliDeck can’t tell this account’s current access/.test(text()));
  router["auth-start"] = () => { state = setupSnap({ clients: [{ name: "default" }], services: [...services, ads], authorization: { id: "a10", status: "waiting", email: "legacy@example.com", client: "default", url: "https://accounts.google.com/x10" } }, { accounts: [legacy] }); return { ok: true, ...state }; };
  control("auth-start")._fire("click"); await sleep();
  ok("legacy reconnect: Read only sends the services without Ads", JSON.stringify(asked("auth-start").at(-1), ["email", "services", "readonly"]) === JSON.stringify({ email: "legacy@example.com", services: ["gmail", "calendar", "drive"], readonly: true }));
  control("auth-cancel")._fire("click"); await sleep(); control("auth-dismiss")?._fire("click");
  state = setupSnap({ clients: [{ name: "default" }], services: [...services, ads] }, { accounts: [legacy], checked: true }); updated(state); await sleep();
  control("connect-cancel")._fire("click");
  control("reconnect-legacy@example.com")._fire("click"); await sleep();
  control("level-write")._fire("click"); control("service-ads").checked = true; control("service-ads")._fire("change");
  ok("legacy reconnect: Read and change + Ads ticked again → the note is gone, Ads is in the request", !/was left out/.test(text()) && control("service-ads").checked === true && control("auth-start").disabled === false);
  // ── Connection requests from agents ──
  router = {}; reply = (data) => router[data.action] ? router[data.action](data) : { ok: true, ...state };
  const reqBase = { id: "r1", sessionId: "s1", sessionName: "helper", projectId: "p1", projectName: "Borrow-demo", email: "office@borrowanything.app", services: ["gmail", "calendar"], readonly: true, message: "" };
  const withReq = (req, setup = {}, over = {}) => setupSnap({ clients: [{ name: "default" }], ...setup }, { accounts: [connected], ...(req ? { connectionRequests: [{ ...reqBase, ...req }] } : {}), ...over });
  const reqCard = () => all().find((n) => n.dataset?.request === "r1");
  state = withReq({ status: "pending" }); updated(state); await sleep();
  const sentBefore = requests().length;
  ok("request: pending card names the email, the asking agent and project, services and access level", /Connect office@borrowanything\.app/.test(reqCard()?.textContent || "") && /helper in Borrow-demo asks to use this account/.test(reqCard().textContent) && /Gmail · Calendar — Read only/.test(reqCard().textContent));
  ok("request: says only that agent in that project will be allowed", /Only helper in Borrow-demo will be allowed to use it/.test(reqCard().textContent));
  ok("request: shown above Accounts, with Connect and allow + Dismiss; nothing sent on its own", root._kids.indexOf(all().find((n) => n.classList?.contains("gw-requests"))) < root._kids.indexOf(accountRow("or@example.com")?.parentNode?.parentNode) && control("request-approve-r1")?.textContent === "Connect and allow this agent" && control("request-approve-r1").disabled === false && !!control("request-dismiss-r1") && requests().length === sentBefore);
  ok("request: plain text only", !all().some((n) => n.tagName === "IMG"));
  router["connect-approve"] = (data) => { state = withReq({ status: "waiting", authorizationId: "ra1" }, { authorization: { id: "ra1", status: "waiting", email: "office@borrowanything.app", client: "default", url: "https://accounts.google.com/req" } }); return { ok: true, ...state }; };
  control("request-approve-r1")._fire("click"); await sleep();
  ok("request: approving sends connect-approve with the request id only", JSON.stringify(asked("connect-approve").at(-1), ["action", "id"]) === JSON.stringify({ action: "connect-approve", id: "r1" }) && Object.keys(asked("connect-approve").at(-1)).sort().join() === "action,id,requestId");
  ok("request: the usual Google sign-in follows; the request card points to it, no buttons", /Approve access for office@borrowanything\.app/.test(text()) && !!control("auth-open") && /Finish the Google sign-in below/.test(reqCard().textContent) && !control("request-approve-r1") && chips().includes("Signing in"));
  state = withReq({ status: "connected", authorizationId: "ra1" }, { authorization: { id: "ra1", status: "connected", email: "office@borrowanything.app", client: "default" } });
  updated(state); await sleep();
  ok("request: after Google confirms, the card says the agent can use it now; no second Connected notice", /Connected office@borrowanything\.app/.test(reqCard().textContent) && /helper in Borrow-demo can use it now/.test(reqCard().textContent) && !all().some((n) => n.classList?.contains("gw-result")));
  router["connect-dismiss"] = () => { state = withReq(null); return { ok: true, ...state }; };
  control("request-dismiss-r1")._fire("click"); await sleep();
  ok("request: Dismiss sends connect-dismiss and the card goes once the server drops it", asked("connect-dismiss").at(-1)?.id === "r1" && !reqCard() && !all().some((n) => n.classList?.contains("gw-requests")));
  updated(withReq({ status: "failed", message: "access_denied" })); await sleep();
  ok("request: a failed sign-in says why and that the agent got no access", /Sign-in didn’t finish: access_denied\. helper wasn’t given access\./.test(reqCard().textContent) && /helper wasn’t given access/.test(reqCard().textContent) && !control("request-approve-r1") && !!control("request-dismiss-r1"));
  updated(withReq({ status: "pending", projectId: null, projectName: "" }, { authorization: { id: "x", status: "waiting", email: "x@example.com", url: "https://accounts.google.com/x" } })); await sleep();
  ok("request: no project → just the agent; approve waits while another sign-in is in progress", /helper asks to use this account/.test(reqCard().textContent) && control("request-approve-r1").disabled === true && /Finish or cancel the sign-in in progress first/.test(reqCard().textContent));
  updated(withReq({ status: "pending" }, { clients: [] }, { accounts: [] })); await sleep();
  ok("request: with no sign-in file yet, approve waits for it and the guide is right below", control("request-approve-r1").disabled === true && /Add your custom Google connection under Advanced/.test(reqCard().textContent) && /One-time setup/.test(text()));
  updated(withReq({ status: "pending" })); await sleep();
  router["connect-approve"] = () => ({ ok: false, message: "This request is no longer available." });
  control("request-approve-r1")._fire("click"); await sleep();
  ok("request: a refused approval shows the server's reason on that card", /This request is no longer available/.test(reqCard().textContent));
  router = {}; reply = null; updated(withReq(null)); await sleep();

  control("connect-cancel")._fire("click");
  state = setupSnap({ clients: [{ name: "default" }] }, { accounts: [{ ...connected, valid: false, error: "invalid_grant" }] });
  updated(state); hold = [];
  control("reconnect-or@example.com")._fire("click");
  ok("revoked account: one click starts OAuth and immediately shows progress in the same row", hold.length === 1 && hold[0].action === "auth-start" && hold[0].readonly && /Preparing Google sign-in/.test(accountRow(connected.email).textContent));
  const reconnect = hold.pop(); hold = null;
  state.setup.authorization = { id: "reconnect", status: "waiting", email: connected.email, url: "https://accounts.google.com/authorize" };
  answer(reconnect); await sleep();
  ok("revoked account: its own row shows the Google approval action", accountRow(connected.email).textContent.includes("Open Google sign-in") && !control("auth-open").disabled);
  updated(snap({ accounts: [connected] })); await sleep();
  ok("older backend without setup: no sign-in controls are offered", !control("reconnect-or@example.com") && !control("connect-open") && !control("auth-start"));
  reply = null;
} catch (e) { console.log("THREW", e && e.stack || e); fail++; }
console.log(`\n${fail === 0 ? "✓" : "✗"} ${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
