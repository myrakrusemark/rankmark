// Refresh missing self-model comparisons, keeping every reader on the same passage.
// Start web/serve.mjs first; completed groups are skipped on a restart.
import { chromium } from 'playwright';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { readFileSync, writeFileSync } from 'node:fs';
const file = new URL('../../data/measurements.json', import.meta.url);
const ctx = await chromium.launchPersistentContext(process.env.PROFILE || join(homedir(), '.cache', 'rankmark-playwright-profile'), {headless:true});
try {
 const page = await ctx.newPage();
 page.on('console', m => { if (/lineup|ERROR/.test(m.text())) console.log(m.text()); });
 await page.goto(`http://127.0.0.1:${process.env.PORT || '8770'}/test/engine/index.html`);
 await page.waitForFunction(() => window.engine?.registry);
 const original = JSON.parse(readFileSync(file));
 for (const [id, old] of Object.entries(original.lineups)) {
  if (old.results.some(r => r.reader === id)) { console.log('SKIP measured', id); continue; }
  console.log('START', id, new Date().toISOString());
  const measured = await page.evaluate(async ({id,ids,seed,n}) => window.engine.lineup(id, ids, seed, n), {id,ids:[id,...Object.keys(original.lineups).filter(x => x !== id)],seed:old.seed,n:original.lineupTokens});
  measured.measuredAt = new Date().toISOString();
  const latest = JSON.parse(readFileSync(file));
  latest.lineups[id] = measured;
  latest.updated = new Date().toISOString();
  writeFileSync(file, JSON.stringify(latest,null,1));
  console.log('SAVED', id);
 }
 await page.evaluate(() => window.engine.unload());
} finally { await ctx.close(); }
