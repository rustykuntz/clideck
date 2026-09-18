import assert from 'node:assert/strict';
import { installFakeDom } from './fakedom.mjs';
const dom = installFakeDom();
globalThis.location = { href: 'http://localhost/' };
for (const id of ['pane-tabs','pane-body']) { const e=document.createElement('div');e.id=id;document.body.appendChild(e); }
const body=document.getElementById('pane-body'), terminal=document.createElement('div');terminal.id='term-panel';body.appendChild(terminal);
const data=new Map(), requests=[], pending=[];
let hold=false;
const response=url=>({ok:true,text:async()=>data.get(new URL(url,location.href).pathname)||'# Document',json:async()=>({type:'bar',series:[],tests:[],passed:1})});
globalThis.fetch=url=>{
  requests.push(url);
  if(url.startsWith('/js/'))return Promise.resolve({text:async()=>''});
  if(hold)return new Promise((resolve,reject)=>pending.push({url,resolve,reject}));
  return Promise.resolve(response(url));
};
const {store}=await import('../public/js/store.js');
const {initContentDock,presentInDock,openWorkspaceTab}=await import('../public/js/ui/content-dock.js');
const {registerPluginViewer}=await import('../public/js/ui/viewer-registry.js');
const tick=async()=>{for(let i=0;i<6;i++)await new Promise(r=>setTimeout(r,0));};
let checks=0;
const check=(name,condition)=>{assert.ok(condition,name);checks++;console.log('PASS '+name);};
const reload=()=>document.querySelector('.cd-dock-refresh');
const active=()=>[...body.children].find(e=>e!==terminal&&!e.hidden);
const show=(kind,id=kind)=>presentInDock({sessionId:'S',contentId:id,kind,name:id,url:'/content/'+id});
store.applyEvent({type:'session.created',sessionId:'S',provider:'shell',live:true,cwd:'/tmp'});initContentDock();
check('terminal has no Reload',!reload());
show('text','other');await tick();const other=active();
data.set('/content/md','# Before');show('markdown','md');await tick();
document.querySelectorAll('.md-seg button')[1]._fire('click');
const count=document.querySelectorAll('.cd-tab').length;
data.set('/content/md','# After');reload()._fire('click');await tick();
check('refresh reads updated Markdown',active().textContent.includes('# After'));
check('Markdown Source choice survives',document.querySelectorAll('.md-seg button')[1].classList.contains('on'));
check('tab identity and count survive',document.querySelectorAll('.cd-tab').length===count&&document.querySelector('.cd-tab.on').textContent.includes('md'));
check('unrelated document and terminal nodes survive',other.parentNode===body&&terminal.parentNode===body);
check('keyboard focus returns to replacement Reload',document.activeElement===reload());
const urls=[];
for(let i=0;i<3;i++){reload()._fire('click');await tick();urls.push(requests.at(-1));}
check('each refresh uses a fresh URL with one bounded query value',new Set(urls).size===3&&urls.every(u=>new URL(u,location.href).searchParams.getAll('r').length===1));
hold=true;reload()._fire('click');const old=pending.shift();reload()._fire('click');const fresh=pending.shift();
fresh.resolve({ok:true,text:async()=>'# Newest'});await tick();old.resolve({ok:true,text:async()=>'# Stale'});await tick();
check('late previous fetch cannot replace current content',active().textContent.includes('Newest')&&!active().textContent.includes('Stale'));
reload()._fire('click');pending.shift().resolve({ok:false,status:404});await tick();
check('failed refresh shows existing error state',!!active().querySelector('.cd-error'));
hold=false;data.set('/content/md','# Recovered');reload()._fire('click');await tick();
check('failed refresh can be retried',active().textContent.includes('Recovered'));
for(const kind of ['text','json','diff','chart','testresults','mermaid','image','pdf','video','html']){
  show(kind);await tick();const previous=active();const button=reload();
  check(kind+' exposes the existing far-right Reload',!!button&&button.parentNode.lastElementChild===button);
  button._fire('click');await tick();
  check(kind+' rebuilds only its document node',active()!==previous&&previous.parentNode===null);
  if(['image','pdf','video'].includes(kind)){
    const el=kind==='image'?active().querySelector('img'):kind==='video'?active().querySelector('video'):active();
    check(kind+' receives refreshed asset URL',new URL(el.src,location.href).searchParams.has('r'));
  }
}
hold=true;show('html','slow');const retired=active().querySelector('iframe'), oldHtml=pending.shift();
reload()._fire('click');const newFrame=active().querySelector('iframe');pending.shift().resolve({ok:true,text:async()=>'<html><body>Fresh HTML</body></html>'});await tick();
oldHtml.reject(new Error('old request failed'));await tick();
check('pending HTML refresh keeps only new bridge frame',newFrame.srcdoc.includes('Fresh HTML')&&!retired.src);
hold=false;
registerPluginViewer('sample',{kind:'report',src:'/plugins/sample/public/viewer.html'});
show('sample/report','plugin');await tick();const oldPlugin=active();let oldPosts=0;const oldWindow={postMessage:()=>oldPosts++};oldPlugin.contentWindow=oldWindow;reload()._fire('click');await tick();const newPlugin=active();
check('plugin document refresh replaces its frame',newPlugin!==oldPlugin&&oldPlugin.parentNode===null);
let envelope;newPlugin.contentWindow={postMessage:m=>{if(m.type==='clideck.init')envelope=m;}};newPlugin._fire('load');
check('plugin receives refreshed asset with same content identity',envelope.data.context.content.id==='plugin'&&envelope.data.context.content.url.includes('?r='));
oldPosts=0;dom.winFire('message',{source:oldWindow,data:{type:'clideck.ready'}});
check('retired plugin frame is disposed',oldPosts===0);
openWorkspaceTab('sample',{id:'workspace',src:'/plugins/sample/public/viewer.html',title:'Workspace'});
check('workspace applications have no Reload',!reload());
document.querySelector('.cd-tab-term')._fire('click');check('terminal remains excluded with document tabs open',!reload()&&terminal.parentNode===body);
console.log(`${checks}/${checks} passed`);
