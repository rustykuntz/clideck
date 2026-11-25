// Canonical conversation history UI: requester-only paging, chronological prepend, lazy top-scroll load,
// and pointer/keyboard focus restoration. Runs the actual store + ws + history module in the fake DOM.
import { installFakeDom, installFakeWs } from "./fakedom.mjs";
const dom = installFakeDom();
const ws = installFakeWs();

const trigger = document.createElement("button"); trigger.id = "th-history"; document.body.appendChild(trigger);
const terminal = document.createElement("textarea"); terminal.id = "term-focus"; document.body.appendChild(terminal);

const { store } = await import("../public/js/store.js");
const { connectWs } = await import("../public/js/ws.js");
const { initHistory } = await import("../public/js/ui/history.js");

let pass = 0, fail = 0;
const ok = (name, condition) => {
  if (condition) { pass++; console.log("  ok   " + name); }
  else { fail++; console.log("  FAIL " + name); }
};
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

try {
  connectWs(); await sleep(5);
  store.applyEvent({ type: "session.created", sessionId: "A", cwd: "/a", name: "Codex", live: true, pid: 1 });
  initHistory(() => terminal);

  ws.clear(); trigger._fire("click", { detail: 1 });
  ok("opening history requests only the newest page", (() => {
    const m = ws.last("transcript.page");
    return m && m.sessionId === "A" && m.limit === 30 && m.before === undefined;
  })());
  store.applyEvent({
    type: "transcript.page.result", requestId: ws.last("transcript.page")?.requestId, query: ws.last("transcript.page")?.query, sessionId: "A", before: null, success: true, cursor: 50, hasMore: true,
    turns: [
      { ts: 2, role: "user", text: "second question" },
      { ts: 3, role: "agent", text: "second answer" },
    ],
  });
  await sleep(5);
  ok("newest page renders in chronological order", (() => {
    const rows = document.querySelectorAll(".hist-turn");
    return rows.length === 2
      && rows[0].querySelector(".hist-text").textContent === "second question"
      && rows[1].querySelector(".hist-text").textContent === "second answer";
  })());

  ws.clear();
  const list = document.querySelector(".hist-list"); list.scrollTop = 0; list._fire("scroll");
  ok("scrolling to the top requests the previous cursor", (() => {
    const m = ws.last("transcript.page"); return m && m.before === 50 && m.limit === 30;
  })());
  store.applyEvent({
    type: "transcript.page.result", requestId: ws.last("transcript.page")?.requestId, query: ws.last("transcript.page")?.query, sessionId: "A", before: 50, success: true, cursor: null, hasMore: false,
    turns: [{ ts: 1, role: "user", text: "first question" }],
  });
  await sleep(5);
  ok("older page prepends without duplicating newer turns", (() => {
    const rows = document.querySelectorAll(".hist-turn");
    return rows.length === 3
      && rows[0].querySelector(".hist-text").textContent === "first question"
      && rows[2].querySelector(".hist-text").textContent === "second answer";
  })());
  ok("end of history is explicit", document.querySelector(".hist-more").textContent === "Beginning of conversation");

  dom.docFire("keydown", { key: "Escape", preventDefault() {}, stopPropagation() {} });
  ok("pointer-opened history returns focus to the terminal", document.activeElement === terminal);
  await sleep(200);

  trigger._fire("click", { detail: 0 });
  store.applyEvent({ type: "transcript.page.result", requestId: ws.last("transcript.page")?.requestId, query: ws.last("transcript.page")?.query, sessionId: "A", before: null, success: true, cursor: null, hasMore: false, turns: [] });
  document.querySelector(".hist-close")._fire("click");
  ok("keyboard-opened history returns focus to its trigger", document.activeElement === trigger);

  // ══ scroll-driven lazy loading — there is NO button; scrolling is the only affordance ══
  // reopen (the focus test above closed it) and seed a page that still has older history behind it
  await sleep(220);                       // let the previous overlay finish its close animation and detach
  ws.clear(); trigger._fire("click", { detail: 1 });
  store.applyEvent({ type: "transcript.page.result", requestId: ws.last("transcript.page")?.requestId, query: ws.last("transcript.page")?.query, sessionId: "A", before: null, success: true, cursor: 50,
    hasMore: true, turns: [{ ts: 9, role: "user", text: "newest" }] });
  await sleep(5);
  const strip = () => [...document.querySelectorAll(".hist-more")].pop();   // always the LIVE modal's status
  const status = strip();
  ok("the strip is passive status, not a control", status.tag === "div" && status.textContent.indexOf("Load older") === -1);
  ok("resting copy tells you to scroll, it doesn't offer a click", /Scroll up|Beginning of conversation|No saved/.test(status.textContent));

  // scrolling near the top pulls the next page in on its own
  const listEl = [...document.querySelectorAll(".hist-list")].pop();
  ws.clear();
  listEl.scrollTop = 10; listEl._fire("scroll");
  ok("scrolling near the top auto-requests older turns", !!ws.last("transcript.page"));
  ok("status switches to loading while in flight", /Loading older/.test(strip().textContent));

  // a failed page must not dead-end: scrolling again retries
  store.applyEvent({ type: "transcript.page.result", requestId: ws.last("transcript.page")?.requestId, query: ws.last("transcript.page")?.query, sessionId: "A", before: 50, success: false, error: "" });
  await sleep(5);
  ok("a failed page explains itself and points at scrolling", /scroll up to retry/i.test(strip().textContent));
  ws.clear();
  listEl.scrollTop = 5; listEl._fire("scroll");
  ok("scrolling again RETRIES after a failure (no dead end)", !!ws.last("transcript.page"));

  // New query invalidates an in-flight normal page immediately, before debounce.
  const stale=ws.last('transcript.page'), input=document.querySelector('.hist-search-input');
  input.value='needle.*';input._fire('input');
  store.applyEvent({type:'transcript.page.result',...stale,type:'transcript.page.result',success:true,turns:[{role:'agent',text:'STALE'}],hasMore:false});
  ok('typing invalidates old page before debounce',document.querySelectorAll('.hist-turn').length===0);
  await sleep(230);const queryRequest=ws.last('transcript.page');
  ok('search sends literal query and unique request token',queryRequest.query==='needle.*'&&queryRequest.requestId!==stale.requestId&&queryRequest.before===undefined);
  store.applyEvent({...queryRequest,type:'transcript.page.result',success:true,cursor:12,hasMore:true,turns:[{role:'agent',text:'older NEEDLE.* <script>plain</script>'}]});await sleep(5);
  ok('literal matches are highlighted safely',document.querySelector('.hist-text mark')?.textContent==='NEEDLE.*'&&!document.querySelector('.hist-text script'));
  listEl.scrollTop=2;listEl._fire('scroll');const olderMatch=ws.last('transcript.page');
  ok('older match paging keeps query and cursor',olderMatch.query==='needle.*'&&olderMatch.before===12);
  store.applyEvent({...olderMatch,type:'transcript.page.result',success:true,cursor:null,hasMore:false,turns:[{role:'user',text:'First needle.*'}]});await sleep(5);
  ok('older matching turns prepend chronologically',document.querySelectorAll('.hist-turn')[0].querySelector('.hist-text').textContent==='First needle.*');
  listEl.scrollTop=77;ws.clear();
  store.applyEvent({type:'transcript.append',id:'A',role:'agent',text:'new needle.*'});
  ok('new turn preserves reading position without implicit fetch',listEl.scrollTop===77&&!ws.last('transcript.page')&&!document.querySelector('.hist-updates').hidden);
  ok('search notice explicitly offers refresh',document.querySelector('.hist-updates').textContent.includes('Refresh search'));
  document.querySelector('.hist-updates')._fire('click');
  ok('explicit refresh requests newest matching page',ws.last('transcript.page').query==='needle.*'&&ws.last('transcript.page').before===undefined);
  const refreshRequest=ws.last('transcript.page');
  store.setConnected(false);
  ok('offline pending request has clear recovery message',document.querySelector('.hist-more').textContent.includes('Offline'));
  store.setConnected(true);const reconnected=ws.last('transcript.page');
  ok('reconnect retries interrupted request with new token',reconnected.requestId!==refreshRequest.requestId&&reconnected.query==='needle.*');
  store.applyEvent({...refreshRequest,type:'transcript.page.result',success:true,turns:[{role:'agent',text:'STALE AFTER RECONNECT'}],hasMore:false});
  ok('late pre-reconnect response is ignored',document.querySelectorAll('.hist-turn').length===0);
  store.applyEvent({...reconnected,type:'transcript.page.result',success:true,turns:[],cursor:null,hasMore:false});
  ok('no matches is explicit',document.querySelector('.hist-more').textContent==='No matching saved messages');
  document.querySelector('.hist-search-clear')._fire('click');const cleared=ws.last('transcript.page');
  ok('clear returns to normal saved history',cleared.query===''&&input.value==='');
  store.applyEvent({...cleared,type:'transcript.page.result',success:false,error:'Read failed'});
  ok('failure includes explicit Retry even without scrollable content',!!document.querySelector('.hist-retry'));
  document.querySelector('.hist-retry')._fire('click');
  ok('Retry uses a new request token',ws.last('transcript.page').requestId!==cleared.requestId);
  store.applyEvent({type:'transcript.page.result',sessionId:'A',before:null,success:true,turns:[{role:'agent',text:'unfiltered legacy data'}]});
  ok('legacy backend reply explains restart without displaying unfiltered data',document.querySelector('.hist-more').textContent.includes('Restart the CliDeck engine')&&document.querySelectorAll('.hist-turn').length===0);
  input.value='a';input._fire('input');await sleep(230);const dense=ws.last('transcript.page');
  store.applyEvent({...dense,type:'transcript.page.result',success:true,turns:[{role:'agent',text:'a'.repeat(1024*1024)}],hasMore:false,cursor:null});
  ok('dense matching text caps highlights while preserving full text',document.querySelectorAll('.hist-text mark').length===200&&document.querySelector('.hist-text').textContent.length===1024*1024&&!!document.querySelector('.hist-highlight-note'));
  input.value='k';input._fire('input');await sleep(230);const unicode=ws.last('transcript.page');
  store.applyEvent({...unicode,type:'transcript.page.result',success:true,turns:[{role:'agent',text:'Kelvin K'}],hasMore:false,cursor:null});
  ok('Unicode casefold highlights Kelvin sign consistently',document.querySelectorAll('.hist-text mark').length===2);
  // ── whole-conversation copy / download ──
  const copied=[];Object.defineProperty(globalThis.navigator,'clipboard',{configurable:true,value:{writeText:async(t)=>{copied.push(t);}}});
  const acts=[...document.querySelectorAll('.hist-act')];
  ok('header offers Copy conversation and Download conversation',acts.map((b)=>b.getAttribute('aria-label')).join('|')==='Copy conversation|Download conversation');
  acts[0]._fire('click');await sleep(5);
  const p1=ws.last('transcript.page');
  ok('copy reads every saved turn: newest page of 100, unfiltered, own request id',p1.limit===100&&p1.query===undefined&&p1.before===undefined&&/^history-all-/.test(p1.requestId));
  ok('copy button is busy while reading',acts[0].disabled===true);
  store.applyEvent({type:'transcript.page.result',sessionId:'A',before:null,requestId:p1.requestId,success:true,turns:[{role:'user',text:'q2'},{role:'agent',text:'a2'}],cursor:7,hasMore:true});
  await sleep(5);const p2=ws.last('transcript.page');
  ok('then the older page before the cursor',p2.before===7&&p2.limit===100&&p2.requestId!==p1.requestId);
  store.applyEvent({type:'transcript.page.result',sessionId:'A',before:7,requestId:p2.requestId,success:true,turns:[{role:'user',text:'q1'},{role:'agent',text:'a1'}],cursor:null,hasMore:false});
  await sleep(10);
  ok('copies the whole conversation oldest first, labelled',copied.at(-1)==='Codex\n\nYou\nq1\n\nAgent\na1\n\nYou\nq2\n\nAgent\na2\n'&&acts[0].disabled===false);
  ok('export results do not land in the visible list',[...document.querySelectorAll('.hist-text')].every((n)=>!/^q[12]$/.test(n.textContent)));
  const turnCopy=document.querySelector('.hist-turn-copy');
  ok('each message has its own copy button',!!turnCopy&&turnCopy.getAttribute('aria-label')==='Copy message');
  turnCopy._fire('click');await sleep(5);
  ok('copy message copies just that message',copied.at(-1)===document.querySelector('.hist-text').textContent);
  document.querySelector('.hist-close')._fire('click');await sleep(200);
  console.log(`\n${fail === 0 ? "✓" : "✗"} ${pass} passed, ${fail} failed`);
} catch (error) {
  console.log("THREW", error && error.stack || error); fail++;
}
process.exit(fail === 0 ? 0 : 1);
