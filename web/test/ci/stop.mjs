// The Stop button on the first two stations: start a run, see the button read
// Stop, click it, and see the run end within a few seconds with the button
// back to its label. Headless, in the campaign profile (the 1.7B is cached).
//
//   node web/test/ci/stop.mjs [http://127.0.0.1:8770/]

import { chromium } from "playwright";
import os from "node:os";
import { join } from "node:path";

const url = process.argv[2] || "http://127.0.0.1:8770/";
const ctx = await chromium.launchPersistentContext(join(os.homedir(), ".cache", "rankmark-playwright-profile"), { headless: true, viewport: { width: 1280, height: 900 } });
let fail = 0;
const ok = (c, m) => { console.log(c ? "ok  " : "FAIL", m); if (!c) fail++; };
const until = async (page, fn, ms) => { const t0 = Date.now(); while (Date.now() - t0 < ms) { if (await page.evaluate(fn)) return Date.now() - t0; await page.waitForTimeout(100); } return -1; };
try {
  const page = await ctx.newPage();
  await page.goto(url, { waitUntil: "load" });
  await page.waitForFunction(() => !!window.rankmark, null, { timeout: 60000 });
  // the model is in when the ranked station's button is enabled
  ok((await until(page, () => !document.querySelector("#st-ranked [data-start]").disabled, 180000)) >= 0, "model loaded");

  // ranked choice
  await page.evaluate(() => { const st = document.querySelector("#st-ranked"); st.scrollIntoView({ block: "center" }); st.querySelector("[data-start]").click(); });
  ok((await until(page, () => document.querySelector("#st-ranked [data-start]").textContent === "Stop", 3000)) >= 0, "ranked: button reads Stop while running");
  ok((await until(page, () => (document.querySelector("#st-ranked [data-done]")?.textContent.length ?? 0) > 0, 40000)) >= 0, "ranked: a word landed");
  await page.waitForTimeout(2500);
  const landedBefore = await page.evaluate(() => document.querySelector("#st-ranked [data-done]")?.textContent.length ?? 0);
  await page.evaluate(() => document.querySelector("#st-ranked [data-start]").click());
  const t1 = await until(page, () => document.querySelector("#st-ranked [data-start]").textContent !== "Stop" && !document.querySelector("#st-ranked [data-start]").disabled, 6000);
  ok(t1 >= 0, `ranked: stopped and the button is back (${t1} ms)`);
  await page.waitForTimeout(2500);
  const landedAfter = await page.evaluate(() => document.querySelector("#st-ranked [data-done]")?.textContent.length ?? 0);
  ok(landedAfter <= landedBefore + 12, `ranked: no words kept landing after Stop (${landedBefore} -> ${landedAfter} chars)`);
  ok(await page.evaluate(() => document.querySelector("#st-ranked [data-sentence]").contentEditable === "true"), "ranked: the box is editable again");

  // write
  await page.evaluate(() => { const st = document.querySelector("#st-write"); st.querySelector("[data-tag]").value = "hi"; st.querySelector("[data-tag]").dispatchEvent(new Event("input")); st.querySelector("[data-run]").click(); });
  ok((await until(page, () => document.querySelector("#st-write [data-run]").textContent === "Stop", 3000)) >= 0, "write: button reads Stop while running");
  await page.waitForTimeout(6000);
  await page.evaluate(() => document.querySelector("#st-write [data-run]").click());
  const t2 = await until(page, () => document.querySelector("#st-write [data-run]").textContent === "Write", 6000);
  ok(t2 >= 0, `write: stopped and the button reads Write again (${t2} ms)`);
  ok(await page.evaluate(() => document.querySelector("#st-write [data-head]").textContent === "stopped"), "write: the head says stopped");
  ok(await page.evaluate(() => document.querySelector("#st-write [data-box-edit]").contentEditable === "true"), "write: the box is editable again");
  await page.locator("#st-write").screenshot({ path: process.env.SHOT || "/dev/null" }).catch(() => {});

  // read: any text runs the model over it
  const TEXT = "It was late in the harbor when the last boat came in, and the fog came with it. The men on the pier said nothing, and the lamps along the water went out one by one as the tide turned.";
  await page.evaluate(t => { const st = document.querySelector("#st-read"); st.scrollIntoView({ block: "center" }); st.querySelector("[data-paste]").value = t; st.querySelector("[data-paste]").dispatchEvent(new Event("input")); st.querySelector("[data-run]").click(); }, TEXT);
  ok((await until(page, () => document.querySelector("#st-read [data-run]").textContent === "Stop", 3000)) >= 0, "read: button reads Stop while running");
  await page.waitForTimeout(4000);
  await page.evaluate(() => document.querySelector("#st-read [data-run]").click());
  const t3 = await until(page, () => document.querySelector("#st-read [data-run]").textContent === "Read it back", 6000);
  ok(t3 >= 0, `read: stopped and the button reads Read it back again (${t3} ms)`);

  // edit station: an edit starts a read; its Read button shows only as Stop, then hides again
  await page.evaluate(t => { const st = document.querySelector("#st-evidence"); st.scrollIntoView({ block: "center" }); st.querySelector("[data-paste]").value = t; st.querySelector("[data-paste]").dispatchEvent(new Event("input")); st.querySelector('[data-break="swap"]').click(); }, TEXT);
  ok((await until(page, () => { const b = document.querySelector("#st-evidence [data-run]"); return !b.hidden && b.textContent === "Stop"; }, 4000)) >= 0, "edit: Stop shows while the read runs");
  await page.waitForTimeout(3000);
  await page.evaluate(() => document.querySelector("#st-evidence [data-run]").click());
  const t4 = await until(page, () => document.querySelector("#st-evidence [data-run]").hidden, 6000);
  ok(t4 >= 0, `edit: stopped and the button hid again (${t4} ms)`);
  ok(await page.evaluate(() => !document.querySelector('#st-evidence [data-break="swap"]').disabled), "edit: the edit buttons are back");
} finally {
  await ctx.close();
}
console.log(fail ? `${fail} failed` : "all passed");
process.exit(fail ? 1 : 0);
