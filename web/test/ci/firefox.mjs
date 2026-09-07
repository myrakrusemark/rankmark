// The page in Playwright's Firefox, fresh profile: the script must start and
// the arrival card must show a model loading. Firefox with a content blocker
// once aborted engine/fingerprint.js by its name, so the page never started;
// this catches the class. For her own settings, run it against a copy of her
// profile (see the memory note) with PROFILE=<dir>.
//
//   node web/test/ci/firefox.mjs [http://127.0.0.1:8770/]

import { firefox } from "playwright";

const url = process.argv[2] || "http://127.0.0.1:8770/";
const opts = { headless: true, viewport: { width: 1280, height: 900 } };
const ctx = process.env.PROFILE ? await firefox.launchPersistentContext(process.env.PROFILE, opts) : await (await firefox.launch(opts)).newContext(opts);
let fail = 0;
const ok = (c, m) => { console.log(c ? "ok  " : "FAIL", m); if (!c) fail++; };
try {
  const page = await ctx.newPage();
  const failed = [];
  page.on("requestfailed", r => failed.push(`${r.url().replace(url, "/")} ${r.failure()?.errorText}`));
  page.on("pageerror", e => failed.push(`pageerror ${String(e).slice(0, 200)}`));
  await page.goto(url, { waitUntil: "load" });
  const t0 = Date.now();
  while (Date.now() - t0 < 20000 && !(await page.evaluate(() => !!window.rankmark))) await page.waitForTimeout(250);
  ok(await page.evaluate(() => !!window.rankmark), "the page's script started");
  ok(await page.evaluate(() => crossOriginIsolated), "cross-origin isolated");
  ok(failed.length === 0, `no failed requests${failed.length ? ": " + failed.join("; ") : ""}`);
  await page.waitForTimeout(3000);
  const card = await page.evaluate(() => { const c = document.querySelector("#autoload"); return c && !c.hidden ? c.textContent.replace(/\s+/g, " ").trim().slice(0, 120) : null; });
  ok(card && /downloading|loading|ready/.test(card), `the arrival card shows a model: ${card}`);
} finally {
  await (ctx.browser?.() ?? ctx).close();
}
console.log(fail ? `${fail} failed` : "all passed");
process.exit(fail ? 1 : 0);
