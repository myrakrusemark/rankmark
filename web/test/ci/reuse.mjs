// A read reuses the scores of every sentence pair it has seen before, and
// runs the model only on the rest. This checks the reused read gives the same
// ranks, carriers and bits as a fresh full read, token for token, on the same
// text, an edited text, and a cut text; and that it computed only the changed
// sentences. Headless, in the campaign profile (the 1.7B is cached).
//
//   node web/test/ci/reuse.mjs [http://127.0.0.1:8770/]

import { chromium } from "playwright";
import os from "node:os";
import { join } from "node:path";

const url = process.argv[2] || "http://127.0.0.1:8770/";
const TEXT = "It was late in the harbor when the last boat came in, and the fog came with it. The men on the pier said nothing, and the lamps along the water went out one by one as the tide turned. A dog barked somewhere behind the warehouses. Nobody answered it. By morning the boats were gone again, and the harbor master wrote the night down in his book as if nothing had happened.";
const ctx = await chromium.launchPersistentContext(join(os.homedir(), ".cache", "rankmark-playwright-profile"), { headless: true, viewport: { width: 1280, height: 900 } });
let fail = 0;
const ok = (c, m) => { console.log(c ? "ok  " : "FAIL", m); if (!c) fail++; };
const same = (a, b) => a.length === b.length && a.every((x, i) => x === b[i]);
try {
  const page = await ctx.newPage();
  await page.goto(url, { waitUntil: "load" });
  await page.waitForFunction(() => !!window.rankmark, null, { timeout: 60000 });
  const t0 = Date.now();
  while (Date.now() - t0 < 180000 && await page.evaluate(() => document.querySelector("#st-write [data-run]").disabled)) await page.waitForTimeout(200);
  // a read straight from the engine: the token events as strings, and the result
  const read = (text, opts) => page.evaluate(async ({ text, opts }) => {
    const ev = [];
    const rung = window.rankmark.registry.rungs.find(r => r.id === localStorage.getItem("rankmark.rung")) || window.rankmark.registry.rungs[1];
    const res = await window.rankmark.engine.run("decode", { rung, text, opts }, { onEvent: e => { if (e.type === "token") ev.push(`${e.id}:${e.carrier ? "c" + e.bit : "-"}:${e.rank}`); } });
    return { ev, reuse: res.reuse, carriers: res.carriers };
  }, { text, opts: { pace: 0, ...opts } });
  const timed = async (label, text, opts) => { const t = Date.now(); const r = await read(text, opts); r.ms = Date.now() - t; console.log(`     ${label}: ${r.ev.length} tokens, ${r.carriers} carriers, reuse ${JSON.stringify(r.reuse)}, ${r.ms} ms`); return r; };

  const fresh = await timed("fresh full read", TEXT, { cache: false });
  const first = await timed("first cached read", TEXT, {});
  ok(same(fresh.ev, first.ev), "a cache-filling read matches the full read token for token");
  const again = await timed("read again", TEXT, {});
  ok(same(fresh.ev, again.ev) && again.reuse.computed === 0, "the same text again computes nothing and matches");

  // an edit inside the third sentence: two words swapped
  const EDITED = TEXT.replace("barked somewhere", "somewhere barked");
  const editedFresh = await timed("edited, fresh", EDITED, { cache: false });
  const editedCached = await timed("edited, reused", EDITED, {});
  ok(same(editedFresh.ev, editedCached.ev), "the edited text reads the same with reuse as fresh");
  ok(editedCached.reuse.computed > 0 && editedCached.reuse.computed < editedFresh.ev.length / 2, `only the touched sentences were computed (${editedCached.reuse.computed} of ${editedFresh.ev.length} tokens)`);

  // the end cut off: nothing before the cut changes
  const CUT = TEXT.slice(0, TEXT.lastIndexOf(" ", Math.floor(TEXT.length * 0.8)));
  const cutFresh = await timed("cut, fresh", CUT, { cache: false });
  const cutCached = await timed("cut, reused", CUT, {});
  ok(same(cutFresh.ev, cutCached.ev), "the cut text reads the same with reuse as fresh");
  ok(cutCached.reuse.computed <= cutCached.reuse.cached, `the cut cost at most the last sentence (${cutCached.reuse.computed} computed, ${cutCached.reuse.cached} known)`);
} finally {
  await ctx.close();
}
console.log(fail ? `${fail} failed` : "all passed");
process.exit(fail ? 1 : 0);
