import assert from 'node:assert/strict';
import { ReadPanel } from '../ui/read.js';
const rungs = [{id:'a'}, {id:'b'}, {id:'c'}];
let chosen;
let selection = 'current';
const panel = Object.create(ReadPanel.prototype);
Object.assign(panel, {
 q: s => s === '[data-reader]' ? { value: selection } : null,
 ta: { value: 'marked text' },
 picker: { rung: rungs[0], registry: {rungs}, consent: async r => {chosen=r.id; return false;} },
});
await panel.run(); assert.equal(chosen,'a');
selection='b'; await panel.run(); assert.equal(chosen,'b');
selection='all'; let all=false; panel.lineup=async()=>{all=true;};
await panel.run(); assert.ok(all);

const previousDocument=globalThis.document;
try {
 const element=()=>({children:[],append(...nodes){this.children.push(...nodes);},textContent:''});
 globalThis.document={createElement:element};
 for(const stop of [false,true]) {
  const body=element(); const box={querySelector:()=>body};
  const batch=Object.create(ReadPanel.prototype); const seen=[];
  Object.assign(batch, {ta:{value:'marked'},q:()=>box,picker:{registry:{rungs},probe:{rungs:[{id:'a',ok:true},{id:'b',ok:false},{id:'c',ok:true}]}},setBusy(){},run:async({rung})=>{seen.push(rung.id); if(stop)batch.batchCancelled=true; return {valid:false};}});
  await batch.lineup();
  assert.deepEqual(seen,stop?['a']:['a','c']);
  assert.equal(batch.batchRunning,false);
  assert.equal(body.children[0].children[1].textContent,stop?'Stopped':'No message recovered');
 }
} finally {globalThis.document=previousDocument;}
console.log('Reader selection, supported-model batch, and cancellation checks passed.');
