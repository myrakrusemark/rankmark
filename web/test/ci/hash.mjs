// The logit row after the determinism prompt, hashed, from the essay page's
// own engine: compare against the value in docs/engine.md after any change
// to the lens.
//
//   RUNG=Qwen3-1.7B-Q8_0 node web/test/ci/hash.mjs [http://127.0.0.1:8770/]

import { chromium } from "playwright";
import os from "node:os";
import { join } from "node:path";

const url = process.argv[2] || "http://127.0.0.1:8770/";
const RUNG = process.env.RUNG || "Qwen3-1.7B-Q8_0";
const PROMPT = "The history of cryptography begins with";
const ctx = await chromium.launchPersistentContext(join(os.homedir(), ".cache", "rankmark-playwright-profile"), { headless: true, viewport: { width: 1280, height: 900 } });
try {
  await ctx.addInitScript(rung => { try { localStorage.setItem("rankmark.rung", rung); } catch {} }, RUNG);
  const page = await ctx.newPage();
  await page.goto(url, { waitUntil: "load" });
  await page.waitForFunction(() => !!window.rankmark, null, { timeout: 60000 });
  const t0 = Date.now();
  while (Date.now() - t0 < 180000 && await page.evaluate(() => document.querySelector("#st-ranked [data-start]").disabled)) await page.waitForTimeout(200);
  const r = await page.evaluate(({ id, prompt }) => window.rankmark.engine.run("logitHash", { rung: window.rankmark.registry.rungs.find(r => r.id === id), prompt }), { id: RUNG, prompt: PROMPT });
  console.log(JSON.stringify(r));
} finally { await ctx.close(); }
