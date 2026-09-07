import { chromium } from "playwright";
import os from "node:os";
import { join } from "node:path";
const [out, width = "1280", url = "http://127.0.0.1:8770/"] = process.argv.slice(2);
const ctx = await chromium.launchPersistentContext(join(os.homedir(), ".cache", "rankmark-playwright-profile"), { headless: true, viewport: { width: Number(width), height: 900 } });
try {
  await ctx.addInitScript(rung => { try { localStorage.setItem("rankmark.rung", rung); } catch {} }, "Qwen3-1.7B-Q8_0");
  const page = await ctx.newPage();
  const errs = [];
  page.on("pageerror", e => errs.push(String(e)));
  page.on("console", m => { if (m.type() === "error") errs.push(m.text()); });
  await page.goto(url, { waitUntil: "load" });
  await page.waitForFunction(() => !!window.rankmark, null, { timeout: 60000 });
  await page.waitForTimeout(Number(process.env.SETTLE || 5000));
  await page.screenshot({ path: out, fullPage: true });
  const h = await page.evaluate(() => document.documentElement.scrollHeight);
  console.log("saved", out, "height", h, "errors:", errs.length ? errs.join(" | ") : "none");
} finally { await ctx.close(); }
