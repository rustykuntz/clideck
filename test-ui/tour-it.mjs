// IT — the guided walkthrough and the unseen-feature tips (config.onboarding).
//
// The load-bearing rule is a THREE-state one, and two of the states look alike from a distance:
//   onboarding ABSENT  → an existing or unknown install. Never auto-run the tour. A quiet tip at most.
//   completed === false → a genuinely fresh install (the engine seeds it). This is the ONLY auto-tour.
//   completed === true  → done. A tip at most.
// Treating "absent" as "false" would walk every existing user through a tour they did not ask for, which is
// exactly the failure this suite exists to catch — so each state is asserted on its own.
//
// ⚠️ ANCHORS ARE ABOUT THE RECT. A hidden node measures 0×0, and fakedom's default rect IS 0×0 — so a stop is
// unanchored here unless the test gives its anchor a box. That makes the fallback the DEFAULT path under test
// and the anchored path the one that has to be set up, which is the right way round for this feature.
import { installFakeDom, installFakeWs } from "./fakedom.mjs";
const dom = installFakeDom();
Object.defineProperty(globalThis, "navigator", { configurable: true, value: { platform: "MacIntel", userAgent: "", clipboard: {} } });
const ws = installFakeWs();
for (const id of ["settings-btn", "theme-btn", "proj-btn", "new-btn", "th-name", "prompts-btn", "team-help-btn"]) { const el = document.createElement("button"); el.id = id; document.body.appendChild(el); }
// The tab strip the preview stop points at. It lives inside the hidden right pane in the real app, which is why
// its DEFAULT here (no box) is the case that matters: a first-run user has no session and must still be taught.
{ const el = document.createElement("div"); el.id = "pane-tabs"; document.body.appendChild(el); }

const { connectWs } = await import("../public/js/ws.js");
const { store } = await import("../public/js/store.js");
const { initTour, startTour, closeTour, maybeShowTip, openAskHelp, isTourOpen, __tourForTest, TIP_ABOUT_ME, TIP_GUIDED_TOUR } = await import("../public/js/ui/tour.js");

const checks = [];
const ok = (name, pass) => { checks.push([name, !!pass]); console.log((pass ? "  ok   " : "  FAIL ") + name); };
const sleep = (ms = 8) => new Promise((r) => setTimeout(r, ms));
const config = (onboarding) => store.applyEvent({ type: "config", config: { projects: [], commands: [], ...(onboarding === undefined ? {} : { onboarding }) } });
const card = () => document.querySelector(".tour-pop");
const q = (cls) => document.querySelector("." + cls);
const acts = () => ({ skip: q("tour-quiet"), back: q("tour-btn:not(.tour-quiet)"), next: q("tour-primary") });
const backBtn = () => [...document.querySelectorAll(".tour-btn")].find((b) => b.textContent === "Back");
const onboardingSent = () => { const m = ws.last("config.update"); return m && m.config ? m.config.onboarding : undefined; };
const box = (el) => { el._rect = { left: 100, top: 100, width: 40, height: 30 }; return el; };

try {
  connectWs(); await sleep();

  // ── gating ──────────────────────────────────────────────────────────────
  initTour();
  config(undefined);                       // key ABSENT
  await sleep(1750);
  ok("an ABSENT onboarding key gets the tour invitation, not an automatic tour",
    __tourForTest()?.mode === "tip" && __tourForTest()?.id === TIP_GUIDED_TOUR);
  q("tour-quiet")._fire("click");
  config(store.onboarding);
  await sleep(1750);
  ok("dismissing the invitation and receiving another config shows no second tip this load", !isTourOpen());

  // The decision is made once per load, so each further case drives the entry point directly — which is also
  // what stops this suite from depending on the order its own cases run in.
  store.setOnboarding({ completed: false });
  ok("completed:false is the state the engine seeds a fresh install with", store.onboarding.completed === false && !store.onboardingCompleted);
  store.setOnboarding({ completed: true, seenTips: [TIP_ABOUT_ME] });
  ok("completed:true reads as done", store.onboardingCompleted === true);
  ok("seenTips is projected as a list", store.seenTips.length === 1 && store.seenTips[0] === TIP_ABOUT_ME);
  config(undefined);
  ok("an absent key projects as NULL, distinguishable from an empty object", store.onboarding === null && store.onboardingCompleted === false);

  // ── the seven stops ───────────────────────────────────────────────────────
  // ⚠️ There is NO About me stop. Or cut it (09-09): the pane explains itself with four words beside its own
  // title, and a walkthrough that spends a sixth of itself saying "this is a name field" is a walkthrough
  // people skip. about-me-it.mjs owns that note now.
  startTour({});
  ok("the tour opens a card", !!card() && isTourOpen());
  ok("it starts at stop 1 of 7", __tourForTest().index === 0 && __tourForTest().total === 7);
  const order = [];
  for (let i = 0; i < 7; i++) { order.push(__tourForTest().id); if (i < 6) acts().next._fire("click"); }
  // Saved prompts follow session creation; teamwork and previews still precede settings.
  ok("the seven stops are the seven the brief asks for, in order",
    order.join(",") === "projects,session,prompts,ask,preview,notifications,agents", order.join(","));
  ok("…and saved prompts follow starting a session, then asking comes before settings",
    order.indexOf("prompts") === order.indexOf("session") + 1 && order.indexOf("ask") === order.indexOf("prompts") + 1 && order.indexOf("preview") === order.indexOf("ask") + 1
    && order.indexOf("preview") < order.indexOf("notifications"));
  ok("…and About me is not one of them", !order.includes("about"));
  ok("the last stop's primary action reads Done, not Next", acts().next.textContent === "Done");
  ok("Back is present and usable once past the first stop", !!backBtn() && backBtn().hidden === false);

  // Back really walks back, and the counter follows.
  backBtn()._fire("click");
  ok("Back returns to the previous stop", __tourForTest().index === 5 && __tourForTest().id === "notifications");
  ok("the eyebrow counts the stop the user is on", q("tour-eyebrow").textContent === "Getting started · 6 of 7");
  startTour({});
  ok("a restarted tour hides Back on stop 1", backBtn() === undefined || backBtn().hidden === true);

  // ── the settings stops open the real pane ───────────────────────────────
  // ⚠️ A retiring Settings overlay is REMOVED ON A TIMER, and its sections still answer document.querySelector
  // while it goes. Querying inside that window hands the test a node the tour is no longer looking at, so the
  // box it sets is measured on nobody. Let the old one go first.
  closeTour(); await sleep(240);
  startTour({ from: 5 });
  ok("stop 6 opens the real Settings surface at Notifications", !!document.querySelector(".set-overlay") && !!document.querySelector('[data-sec="delivery"]'));
  // ⚠️ With every rect 0×0 the stop is unanchored, so "anchored is false" here would be true no matter WHICH
  // node the stop names. Give the Delivery section a box and the claim becomes about the anchor resolving to
  // that section — the pixels are the browser gate's job.
  const deliverySec = document.querySelector('[data-sec="delivery"]');
  ok("with no measurable box the stop falls back rather than spotlighting a corner", __tourForTest().anchored === false);
  deliverySec._rect = { left: 200, top: 120, width: 400, height: 260, right: 600, bottom: 380 };
  startTour({ from: 5 });
  ok("…and once that section has a box, stop 6 anchors to IT", __tourForTest().anchored === true && q("tour-spot").style.left === "194px" && q("tour-spot").style.width === "412px");
  ok("the notification stop names BOTH cues in one sentence — idle, and one agent sending work to another",
    /goes idle/i.test(q("tour-body").textContent) && /another agent/i.test(q("tour-body").textContent));
  acts().next._fire("click");
  ok("stop 7 switches the same surface to CLI Agents", !!document.querySelector('[data-sec="builtin"]'));
  // Walking BACK out of the settings stops has to put the app away again, or the team stops are explained over
  // a pane that covers the very thing they point at.
  backBtn()._fire("click"); backBtn()._fire("click");
  await sleep(240);
  ok("walking back to the preview stop closes Settings again", !document.querySelector(".set-overlay") && __tourForTest().id === "preview");

  // ── fallback copy for an anchor that is not there ───────────────────────
  // ⚠️ Both team stops point at the right pane, which does not EXIST until there is a session — the first-run
  // user meets the fallback wording, so it has to teach the idea on its own.
  ok("with no session the preview stop is unanchored", __tourForTest().anchored === false);
  ok("…and still names the kinds of output that open in a tab",
    /markdown/i.test(q("tour-body").textContent) && /video/i.test(q("tour-body").textContent) && /PDF/.test(q("tour-body").textContent));
  ok("…and says you can open one yourself by dropping onto the tab strip",
    /drop/i.test(q("tour-body").textContent) && /tab strip/i.test(q("tour-body").textContent));
  closeTour(); await sleep(240);
  startTour({ from: 3 });
  ok("the ask stop is out in the app, not behind Settings", !document.querySelector(".set-overlay"));
  ok("with no live session, the ask stop is unanchored", __tourForTest().anchored === false);
  // ⚠️ MEANING, NOT WORDING. These used to pin whole clauses verbatim, which made every copy edit a test
  // failure and taught nobody anything. Or shortened this stop from 58 words to 28 on 09-10; what has to
  // survive is the CLAIM, so each check below names one claim and nothing about how it is phrased.
  ok("…and says something useful anyway, not the anchored wording",
    /Open two agent sessions/.test(q("tour-body").textContent));
  // ⚠️ This is the stop the whole app is FOR, and it is the one nobody understood. It has to say three things
  // in plain words: choose an agent, say what to ask, and the agents handle the exchange.
  ok("the ask stop renders @@ as an inline keyboard token", q("tour-body").querySelector("kbd.tour-key")?.textContent === "@@");
  ok("…explains choosing the other agent and what to ask", /choose the other/.test(q("tour-body").textContent) && /tell your agent what to ask it/.test(q("tour-body").textContent));
  ok("…without assuming the user has a reviewer role", !/reviewer/i.test(q("tour-body").textContent));
  // Across vendors — and NOT a promise that any of it happens by itself: the sentence is something you TELL an
  // agent. ⚠️ "they can also ask YOU a question" was CUT by Or on 09-09 and must not come back. It was briefly
  // reinstated in a shorter form and removed again: the title and the you-address the example is written in
  // already say the user is part of the team.

  ok("…and the retired 'they can ask YOU a question' clause has NOT crept back", !/question to you/i.test(q("tour-body").textContent));
  ok("an unanchored stop is flagged so the spotlight can drop its ring", q("tour").classList.contains("tour-unanchored"));
  closeTour(); await sleep(240);
  box(document.getElementById("th-name"));
  box(document.getElementById("pane-tabs"));
  startTour({ from: 3 });
  ok("give the session name a real box and the ask stop anchors", __tourForTest().anchored === true);
  ok("…and switches to the anchored wording, which no longer tells you to start anything",
    !/Open two agent sessions/.test(q("tour-body").textContent) && /^Type @@ /.test(q("tour-body").textContent.trim()));
  ok("the anchored wording keeps the shortcut token and lets the user choose",
    /choose another agent/.test(q("tour-body").textContent) && q("tour-key")?.textContent === "@@");
  ok("the active-session wording says the reply comes back", /agents handle the request and reply/.test(q("tour-body").textContent));
  acts().next._fire("click");
  ok("…and the preview stop anchors to the tab strip once there is one", __tourForTest().id === "preview" && __tourForTest().anchored === true);
  ok("its wording asks for the output in words a user would use, and says where it lands",
    /Markdown report/i.test(q("tour-body").textContent) && /inside CliDeck/i.test(q("tour-body").textContent));
  backBtn()._fire("click");
  ok("the spotlight tracks that box", q("tour-spot").style.left === "94px" && q("tour-spot").style.width === "52px");
  ok("the unanchored flag is gone", !q("tour").classList.contains("tour-unanchored"));

  // The Prompts stop teaches reuse and yields Escape to the actual library.
  startTour({ from: 2 });
  ok("saved prompts have their own stop after starting a session", __tourForTest().id === "prompts" && /project introductions/.test(q("tour-body").textContent) && /\/\//.test(q("tour-body").textContent));
  box(document.getElementById("prompts-btn")); startTour({ from: 2 });
  ok("saved prompts anchor to the existing library button", __tourForTest().anchored && q("tour-spot").style.left === "94px");
  const { openPromptLibrary } = await import("../public/js/ui/prompts.js");
  openPromptLibrary(); await sleep();
  dom.docFire("keydown", { key: "Escape", preventDefault() {}, stopPropagation() {} });
  await sleep(200);
  ok("Escape closes Prompts while keeping the tour on its stop", __tourForTest()?.id === "prompts" && !document.querySelector(".pl-overlay"));

  // Help is explicitly requested, one card, and entirely separate from persistence.
  closeTour(); await sleep(240);
  const helpLink = box(document.getElementById("team-help-btn"));
  for (const completed of [false, true]) {
    store.setOnboarding({ completed, seenTips: ["future-tip"] });
    const before = JSON.stringify(store.onboarding); ws.clear();
    helpLink.focus(); helpLink._fire("click");
    ok(`help opens only Ask (completed=${completed})`, __tourForTest()?.mode === "help" && __tourForTest()?.id === "ask" && __tourForTest()?.total === 1);
    ok("help is not labelled New and focuses its visible dismiss button", q("tour-eyebrow").textContent === "CliDeck Ask" && document.activeElement === q("tour-quiet") && q("tour-primary").hidden);
    if (completed) q("tour-quiet")._fire("click");
    else dom.docFire("keydown", { key: "Escape", preventDefault() {}, stopPropagation() {} });
    ok("help dismissal returns focus to its link", !isTourOpen() && document.activeElement === helpLink);
    ok("help never completes onboarding or marks a feature tip seen", JSON.stringify(store.onboarding) === before && ws.last("config.update") === null);
    await sleep(240);
  }
  document.getElementById("th-name")._rect = { left: 0, top: 0, width: 0, height: 0 };
  openAskHelp();
  ok("linked help without a session explains starting two agents", /Open two agent sessions/.test(q("tour-body").textContent));
  closeTour(); await sleep(240);
  startTour();
  ok("Projects explains direct tasks and replies without the user relaying messages", /across providers/.test(q("tour-body").textContent) && /share a folder/.test(q("tour-body").textContent) && /tasks and replies/.test(q("tour-body").textContent) && /without you relaying messages/.test(q("tour-body").textContent));

  // ── persistence ─────────────────────────────────────────────────────────
  ws.clear();
  // Walk to the end rather than assuming which stop is last — the order moved once already (09-09).
  while (acts().next.textContent !== "Done") acts().next._fire("click");
  acts().next._fire("click");                     // Done
  ok("Done closes the tour", !isTourOpen());
  ok("Done records completed:true", onboardingSent() && onboardingSent().completed === true);
  ok("Done also acknowledges the tips the tour just covered, so nothing repeats it tomorrow",
    onboardingSent().seenTips.includes(TIP_ABOUT_ME) && onboardingSent().seenTips.includes(TIP_GUIDED_TOUR));
  ok("the store shows it done immediately, without waiting for the echo", store.onboardingCompleted === true);

  config({ completed: false, seenTips: [] });
  ws.clear();
  startTour({});
  q("tour-quiet")._fire("click");                 // Skip
  ok("Skip is Done — a user who opts out is not walked through it again", onboardingSent() && onboardingSent().completed === true);
  ok("Skip acknowledges the same tips", onboardingSent().seenTips.length === 2);

  config({ completed: false, seenTips: [] });
  ws.clear();
  startTour({});
  dom.docFire("keydown", { key: "Escape", preventDefault() {}, stopPropagation() {} });
  ok("Escape behaves as Skip rather than leaving the tour half-taken", !isTourOpen() && onboardingSent().completed === true);

  // ── tips: only what has not been seen ───────────────────────────────────
  config({ completed: true, seenTips: [] });
  ws.clear();
  const first = maybeShowTip();
  ok("an existing user gets a tip, not a tour", first === TIP_GUIDED_TOUR && __tourForTest().mode === "tip");
  ok("a tip is one stop, and says so", __tourForTest().total === 1 && q("tour-eyebrow").textContent === "New");
  ok("its quiet action reads 'Got it'", q("tour-quiet").textContent === "Got it");
  q("tour-quiet")._fire("click");
  ok("acknowledging sends ONLY the new id — the engine unions, so a delta cannot clobber history",
    onboardingSent() && onboardingSent().seenTips.length === 1 && onboardingSent().seenTips[0] === TIP_GUIDED_TOUR && onboardingSent().completed === undefined);
  ok("the store already reflects it, so the next tip is a different one", store.seenTips.includes(TIP_GUIDED_TOUR));

  const second = maybeShowTip();
  ok("About me follows a seen tour invitation, never repeating it", second === TIP_ABOUT_ME);
  q("tour-quiet")._fire("click");
  ok("with both acknowledged there is nothing to show", maybeShowTip() === null);

  config({ completed: true, seenTips: [TIP_ABOUT_ME, "future-tip"] });
  ok("a seen profile does not suppress an unseen tour invitation", maybeShowTip() === TIP_GUIDED_TOUR);
  ws.clear();
  q("tour-primary")._fire("click");               // the tip's call to action
  ok("a tip's action marks it seen too", store.seenTips.includes(TIP_GUIDED_TOUR) && onboardingSent().seenTips[0] === TIP_GUIDED_TOUR);
  ok("…and the 'Take the tour' tip actually starts the tour", isTourOpen() && __tourForTest().mode === "tour" && __tourForTest().index === 0);
  closeTour(); await sleep(240);

  ok("with everything seen there is nothing to show", maybeShowTip() === null && !isTourOpen());

  // ── replay must not un-see anything ─────────────────────────────────────
  config({ completed: true, seenTips: [TIP_ABOUT_ME, TIP_GUIDED_TOUR, "future-tip"] });
  ws.clear();
  startTour({ replay: true });
  ok("a replay runs the full seven stops regardless of completed", isTourOpen() && __tourForTest().total === 7);
  ok("starting a replay writes NOTHING — history is not touched on the way in", ws.last("config.update") === null);
  for (let i = 0; i < 6; i++) acts().next._fire("click");
  acts().next._fire("click");                     // Done
  ok("finishing a replay still never removes a seen id", store.seenTips.includes(TIP_ABOUT_ME) && store.seenTips.includes(TIP_GUIDED_TOUR) && store.seenTips.includes("future-tip"));
  ok("…and the patch it sends only ever ADDS ids", onboardingSent().seenTips.every((id) => [TIP_ABOUT_ME, TIP_GUIDED_TOUR].includes(id)));
  ok("after a replay there is still no tip to show", maybeShowTip() === null);

  // ── the delayed auto-tour is a RACE, and both ways of losing it are real ─
  // The 420ms gap between deciding and starting is long enough for another tab to finish onboarding, and for
  // the user to press Take the tour themselves. Neither may be stamped on by the timer that fires afterwards.
  closeTour(); await sleep(240);
  {
    const { initTour: freshInit } = await import("../public/js/ui/tour.js?race1");
    config({ completed: false, seenTips: [] });
    freshInit();
    config({ completed: false, seenTips: [] });     // the frame that arms the 420ms timer
    startTour({ replay: true });                    // …and the user gets there first
    acts().next._fire("click"); acts().next._fire("click");
    const reached = __tourForTest().index;
    await sleep(700);
    ok("a manually started tour is NOT restarted by the delayed auto-tour", isTourOpen() && __tourForTest().index === reached);
    closeTour(); await sleep(240);
  }
  {
    const { initTour: freshInit } = await import("../public/js/ui/tour.js?race2");
    config({ completed: false, seenTips: [] });
    freshInit();
    config({ completed: false, seenTips: [] });
    store.setOnboarding({ completed: true, seenTips: [] });   // another tab finished it inside the window
    await sleep(700);
    ok("onboarding completed elsewhere during the delay cancels the auto-tour", !isTourOpen());
  }

  // ── the live controls stay live ─────────────────────────────────────────
  startTour({ from: 5 });                            // the Notifications stop — its controls are right there, and live
  const picker = document.querySelector(".set-body select");    // the idle-sound picker, under the tour's own spotlight
  const at = __tourForTest().index;
  picker.focus();
  dom.docFire("keydown", { key: "ArrowRight", preventDefault() {}, stopPropagation() {} });
  dom.docFire("keydown", { key: "ArrowLeft", preventDefault() {}, stopPropagation() {} });
  ok("an arrow key inside a live settings control belongs to the CONTROL, never to the tour", __tourForTest().index === at);
  q("tour-primary").focus();
  dom.docFire("keydown", { key: "ArrowRight", preventDefault() {}, stopPropagation() {} });
  ok("…but an arrow key on the card itself still walks the tour", __tourForTest().index === at + 1);

  // Escape belongs to whatever opened on top. Finishing the tour underneath an open popover would leave the
  // user holding a menu whose context has silently gone.
  const menu = document.createElement("div"); menu.className = "menu"; document.body.appendChild(menu);
  dom.docFire("keydown", { key: "Escape", preventDefault() {}, stopPropagation() {} });
  ok("Escape with a popover open is deferred, not swallowed by the tour", isTourOpen());
  menu.remove();
  document.body.classList.add("cd-modal-open");
  dom.docFire("keydown", { key: "Escape", preventDefault() {}, stopPropagation() {} });
  ok("…and the same while a modal owns the screen", isTourOpen());
  document.body.classList.remove("cd-modal-open");
  dom.docFire("keydown", { key: "Escape", preventDefault() {}, stopPropagation() {} });
  ok("with nothing on top, Escape finishes", !isTourOpen());

  // ── focus lands somewhere real when the card goes ───────────────────────
  await sleep(240);
  const opener = document.getElementById("settings-btn");
  opener.focus();
  startTour({});
  ok("the card takes focus while it is up", q("tour-primary") === document.activeElement);
  closeTour();
  ok("closing hands focus back to what had it, not to a removed button", document.activeElement === opener);
  await sleep(240);

  // ── it never blocks the app ─────────────────────────────────────────────
  startTour({});
  ok("the tour marks the body so Settings hands it Escape", document.body.classList.contains("tour-active"));
  closeTour(); await sleep(240);
  ok("closing releases that flag", !document.body.classList.contains("tour-active"));
  ok("and takes its card with it", !card());

  // Each module instance represents a new page load; inspect and close that same instance.
  for (const [name, onboarding, mode, id] of [
    ["fresh", { completed: false, seenTips: [] }, "tour", "projects"],
    ["existing", { completed: true, seenTips: [] }, "tip", TIP_GUIDED_TOUR],
    ["later", { completed: true, seenTips: [TIP_GUIDED_TOUR] }, "tip", TIP_ABOUT_ME],
  ]) {
    const page = await import(`../public/js/ui/tour.js?tip-order-${name}`);
    page.initTour();
    config(onboarding);
    await sleep(mode === "tour" ? 600 : 1750);
    ok(`${name} load starts with ${id}`, page.__tourForTest()?.mode === mode && page.__tourForTest()?.id === id);
    page.closeTour(); await sleep(240);
  }

} catch (error) {
  ok("suite ran to completion", false);
  console.log(error && error.stack || error);
}

const failed = checks.filter(([, pass]) => !pass);
console.log(`\n${checks.length - failed.length}/${checks.length} checks passed`);
process.exit(failed.length ? 1 : 0);
