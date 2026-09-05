// Headless screenshot of one element of the local page, from the campaign
// profile (the small model is cached there, so the arrival card settles in
// seconds). For layout checks without touching a headed browser.
//
//   node web/test/ci/shot.mjs '#st-write' /tmp/st-write.png [http://127.0.0.1:8770/]

import { chromium } from "playwright";
import os from "node:os";
import { join } from "node:path";

const [selector, out, url = "http://127.0.0.1:8770/"] = process.argv.slice(2);
if (!selector || !out) { console.error("usage: shot.mjs <selector> <out.png> [url]"); process.exit(2); }
const ctx = await chromium.launchPersistentContext(join(os.homedir(), ".cache", "rankmark-playwright-profile"), { headless: true, viewport: { width: 1280, height: 900 } });
try {
  await ctx.addInitScript(rung => { try { localStorage.setItem("rankmark.rung", rung); } catch { /* ignore */ } }, process.env.RUNG || "Qwen3-0.6B-Q8_0");
  const page = await ctx.newPage();
  await page.goto(url, { waitUntil: "load" });
  await page.waitForFunction(() => !!window.rankmark, null, { timeout: 60000 });
  await page.waitForTimeout(Number(process.env.SETTLE || 4000));
  await page.locator(selector).screenshot({ path: out });
  console.log("saved", out);
} finally {
  await ctx.close();
}
