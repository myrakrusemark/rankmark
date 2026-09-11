import { chromium } from 'playwright';
import { homedir } from 'node:os';
import { join } from 'node:path';
import assert from 'node:assert/strict';
const ctx = await chromium.launchPersistentContext(join(homedir(), '.cache', 'rankmark-playwright-profile'), {headless:true});
try {
 const page=await ctx.newPage();
 await page.goto('http://127.0.0.1:8770/test/engine/index.html');
 await page.waitForFunction(()=>window.engine?.registry);
 console.log('Starting real Qwen3-0.6B keyed generation');
 const result=await page.evaluate(async()=>{
  const rung=window.engine.registry.rungs.find(r=>r.id==='Qwen3-0.6B-Q8_0');
  const opts={prompt:'It was late in the harbor when the last boat came in, and',payloadHex:'a7',profile:3,temperature:.7,seed:123,copies:1,passphrase:'rankmark test phrase',maxNew:600};
  const written=await window.engine.runJob('embed',{rung,opts});
  console.log('Keyed generation finished',written.framesPlanted);
  const good=await window.engine.runJob('decode',{rung,text:written.text,opts:{passphrase:opts.passphrase,pace:0}});
  console.log('Matching key',good.valid,good.payload);
  const bad=await window.engine.runJob('decode',{rung,text:written.text,opts:{passphrase:'different test phrase',pace:0}});
  return {frames:written.framesPlanted,retokenizes:written.retokenizes,good:good.valid,payload:good.payload,bad:bad.valid};
 });
 console.log(JSON.stringify(result));
 assert.ok(result.retokenizes && result.good && result.payload==='a7' && !result.bad);
} finally {await ctx.close();}
