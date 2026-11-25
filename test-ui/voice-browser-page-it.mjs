import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { installFakeDom } from './fakedom.mjs';
const dom=installFakeDom();
const html=readFileSync(new URL('../plugin-packages/voice-agent/public/voice.html',import.meta.url),'utf8');
for(const match of html.matchAll(/<([a-z][a-z0-9-]*)[^>]*\bid="([^"]+)"/g)){const el=document.createElement(match[1]);el.id=match[2];document.body.append(el);}
const posts=[], parent={postMessage:m=>posts.push(m)};globalThis.parent=parent;
const set=globalThis.setInterval,clear=globalThis.clearInterval;globalThis.setInterval=()=>1;globalThis.clearInterval=()=>{};
try{
 new Function(readFileSync(new URL('../plugin-packages/voice-agent/public/voice.js',import.meta.url),'utf8'))();
 const send=(type,data,source=parent)=>dom.winFire('message',{source,data:{type,data}});
 const $=id=>document.getElementById(id);
 const render=value=>send('clideck.message',{event:'voice-ui-state',data:{sessionId:'one',name:'Research',supported:true,focused:true,setup:{ready:true,missing:[],errors:[]},...value}});
 assert.equal(posts[0].type,'clideck.ready');
 send('clideck.init',{context:{sessionId:'one'},theme:'light'});
 assert.equal(posts.at(-1).data.action,'snapshot');
 render({state:'off',enabled:false});assert.equal($('primary').textContent,'Start voice');assert.equal($('connection').textContent,'Microphone off');
 $('primary')._fire('click');assert.equal(posts.at(-1).data.action,'start');
 render({state:'connecting',enabled:true});assert.equal($('primary').textContent,'Cancel connecting');$('primary')._fire('click');assert.equal(posts.at(-1).data.action,'pause');
 render({state:'listening',enabled:true});assert.equal($('primary').textContent,'Pause microphone');assert.equal($('connection').textContent,'Microphone on');assert.equal($('end').hidden,false);
 $('end')._fire('click');assert.equal(posts.at(-1).data.action,'end');
 render({state:'paused',enabled:true});assert.equal($('primary').textContent,'Resume voice');
 render({state:'off',setup:{ready:false,missing:['openai-key'],errors:[]}});assert.equal($('setup').hidden,false);assert.equal($('primary').textContent,'Set up voice');$('primary')._fire('click');assert.equal(posts.at(-1).data.action,'settings');
 render({state:'error',error:'Microphone permission was denied.'});assert.equal($('error').hidden,false);assert.match($('error').textContent,/denied/);
 const previous=$('headline').textContent;send('clideck.message',{event:'voice-ui-state',data:{sessionId:'two',state:'listening'}});assert.equal($('headline').textContent,previous);
 send('clideck.message',{event:'voice-ui-state',data:{sessionId:'one',state:'listening'}},{});assert.equal($('headline').textContent,previous);
 render({state:'off',transcript:[{role:'user',text:'<script>unsafe()</script>'}],request:{state:'uncertain'}});assert.equal($('transcript-section').hidden,false);assert.match($('transcript').textContent,/<script>/);assert.equal($('transcript').querySelector('script'),null);assert.match($('request').textContent,/couldn’t confirm/);
 render({state:'paused',focused:false});assert.equal($('primary').disabled,true);
 render({state:'off',checked:true});assert.equal($('ready-text').textContent,'OpenAI connection checked');
 render({state:'off',featureEnabled:false,focused:false});assert.equal($('primary').textContent,'Enable Talk to sessions');assert.equal($('primary').disabled,false);$('primary')._fire('click');assert.equal(posts.at(-1).data.action,'settings');
 console.log('Voice browser page: setup, controls, focus, source filtering, uncertainty and safe text passed.');
}finally{globalThis.setInterval=set;globalThis.clearInterval=clear;}
