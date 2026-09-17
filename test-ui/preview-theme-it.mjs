import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
const source = readFileSync(new URL('../public/js/ui/preview-bridge.js',import.meta.url),'utf8');
function frame(marker, initial = 'dark') {
  const attributes = marker == null ? {} : {'data-clideck-theme':marker};
  const events = {}, parent = {postMessage() {}};
  const root = {hasAttribute:k=>k in attributes, setAttribute:(k,v)=>{attributes[k]=v;},appendChild() {}};
  const document = {documentElement:root,readyState:'loading',createElement:()=>({}),addEventListener() {}};
  const window = {parent,addEventListener:(k,fn)=>{events[k]=fn;}};
  runInNewContext(source,{window,document,initialPreviewTheme:initial});
  return {attributes,send:(theme,sender=parent)=>events.message({source:sender,data:{ck:'theme',theme}})};
}
let count=0;function check(name,fn){fn();count++;console.log('PASS '+name);}
check('marked document gets resolved theme synchronously before DOMContentLoaded',()=>assert.equal(frame('auto').attributes['data-clideck-theme'],'dark'));
check('host theme wins over an explicit document starting mode',()=>assert.equal(frame('dark','light').attributes['data-clideck-theme'],'light'));
const opted=frame('auto');
check('later parent theme changes update the same attribute',()=>{opted.send('light');assert.equal(opted.attributes['data-clideck-theme'],'light');});
check('a frame cannot spoof a parent theme message',()=>{opted.send('dark',{});assert.equal(opted.attributes['data-clideck-theme'],'light');});
check('invalid theme values are ignored',()=>{opted.send('auto');opted.send('<style>');assert.equal(opted.attributes['data-clideck-theme'],'light');});
check('unmarked HTML is unchanged initially and on theme messages',()=>{const plain=frame(null);plain.send('light');assert.deepEqual(plain.attributes,{});});
console.log(`${count}/${count} passed`);
