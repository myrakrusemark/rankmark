// Headless check of the essay's stations: load the page in the campaign
// profile (models cached at this origin), let the arrival card load the
// small model, run the write station, then the read station, and report what
// the strip and the words show. Screenshots go to OUT_DIR. Never run these
// checks in the headed MCP Chrome: that is Myra's window.
//
//   node web/test/ci/stations.mjs
//   OPENING="..." MESSAGE=hi TEMP=0.7 OUT_DIR=/tmp/shots node web/test/ci/stations.mjs

import { chromium } from "playwright";
import { spawn } from "node:child_process";
import { mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import os from "node:os";

const here = dirname(fileURLToPath(import.meta.url));
const webRoot = join(here, "..", "..");
const PROFILE = process.env.PROFILE || join(os.homedir(), ".cache", "rankmark-playwright-profile");
const PORT = process.env.PORT || "8776";
const OUT_DIR = process.env.OUT_DIR || join(os.tmpdir(), "rankmark-stations");
const OPENING = process.env.OPENING || "It was late in the harbor when the last boat came in, and";
const MESSAGE = process.env.MESSAGE || "hello";
const TEMP = process.env.TEMP || "0.7";

const stamp = () => new Date().toISOString().slice(11, 19);
const log = (...a) => console.log(stamp(), ...a);
mkdirSync(OUT_DIR, { recursive: true });

const server = spawn(process.execPath, [join(webRoot, "serve.mjs")], { env: { ...process.env, PORT }, stdio: ["ignore", "inherit", "inherit"] });
await new Promise(r => setTimeout(r, 1500));
const ctx = await chromium.launchPersistentContext(PROFILE, { headless: true, viewport: { width: 1280, height: 900 } });
try {
  // the small rung, whatever this profile picked before
  await ctx.addInitScript(rung => { try { localStorage.setItem("rankmark.rung", rung); } catch { /* ignore */ } }, process.env.RUNG || "Qwen3-0.6B-Q8_0");
  const page = await ctx.newPage();
  page.on("pageerror", e => log("[pageerror]", e.message));
  page.on("console", m => { if (m.type() === "error") log("[console]", m.text().slice(0, 200)); });
  await page.goto(`http://127.0.0.1:${PORT}/`, { waitUntil: "load" });
  await page.waitForFunction(() => !!window.rankmark, null, { timeout: 60000 });

  log("waiting for the arrival card's model");
  const loaded = async () => page.evaluate(async () => (await window.rankmark.engine.info())?.model || null);
  for (let i = 0; i < 300 && !(await loaded()); i++) await page.waitForTimeout(1000);
  log("model in:", await loaded());

  // MAXNEW=40 caps the write so the stalled-frame path shows
  if (process.env.MAXNEW) await page.evaluate(n => { const e = window.rankmark.engine, run = e.run.bind(e); e.run = (cmd, args, hooks) => run(cmd, cmd === "embed" ? { ...args, opts: { ...args.opts, maxNew: n } } : args, hooks); }, Number(process.env.MAXNEW));

  // write station
  await page.evaluate(({ opening, message, temp }) => {
    const st = document.querySelector("#st-write");
    st.scrollIntoView({ block: "start" });
    st.querySelector("[data-box-edit]").textContent = opening;
    st.querySelector("[data-tag]").value = message;
    st.querySelector("[data-tag]").dispatchEvent(new Event("input"));
    const t = st.querySelector("[data-temp]"); if (t) { t.value = temp; t.dispatchEvent(new Event("input")); }
    st.querySelector("[data-run]").click();
  }, { opening: OPENING, message: MESSAGE, temp: TEMP });
  await page.waitForFunction(() => !document.querySelector("#st-write [data-stop]").hidden, null, { timeout: 30000 });
  await page.waitForTimeout(8000);
  await page.screenshot({ path: join(OUT_DIR, "write-running.png") });
  log("read box while writing:", JSON.stringify(await page.evaluate(() => ({ chars: document.querySelector("#st-read [data-paste]").value.length, head: document.querySelector("#st-read [data-head]").textContent }))));
  await page.waitForFunction(() => document.querySelector("#st-write [data-stop]").hidden, null, { timeout: 600000 });
  const write = await page.evaluate(() => {
    const st = document.querySelector("#st-write");
    const bySeg = {};
    for (const t of st.querySelectorAll("#st-write-text .tok[data-seg]")) bySeg[t.dataset.seg] = (bySeg[t.dataset.seg] || 0) + 1;
    return {
      head: st.querySelector("[data-head]").textContent,
      sections: [...st.querySelectorAll("#st-write-strip .fseg")].map(s => `${s.dataset.kind} ${s.querySelectorAll(".bit.v0,.bit.v1").length}/${s.querySelectorAll(".bit").length}`),
      tokensBySeg: bySeg,
      sealed: st.querySelector("#st-write-strip").classList.contains("sealed"),
      text: st.querySelector("#st-write-text").textContent.slice(0, 300),
    };
  });
  log("write:", JSON.stringify(write));
  log("notice:", JSON.stringify(await page.evaluate(() => { const n = document.querySelector("#st-write [data-notice]"); return { hidden: n.hidden, text: n.textContent.slice(0, 120), copyHidden: document.querySelector("#st-write [data-copy]").hidden }; })));
  if (process.env.MAXNEW) { await page.screenshot({ path: join(OUT_DIR, "write-stalled.png") }); log("stalled run done"); await page.evaluate(() => window.rankmark.engine.unload()); await ctx.close(); server.kill(); process.exit(0); }
  log("read box when done:", JSON.stringify(await page.evaluate(() => { const v = document.querySelector("#st-read [data-paste]").value; return { chars: v.length, footer: v.slice(v.lastIndexOf("\n") + 1, v.lastIndexOf("\n") + 40), head: document.querySelector("#st-read [data-head]").textContent }; })));
  await page.screenshot({ path: join(OUT_DIR, "write-done.png") });

  // read station: the card was carried over by onDone
  await page.evaluate(() => { const rd = document.querySelector("#st-read"); rd.scrollIntoView({ block: "start" }); rd.querySelector("[data-run]").click(); });
  await page.waitForTimeout(6000);
  await page.screenshot({ path: join(OUT_DIR, "read-running.png") });
  await page.waitForFunction(() => { const rd = document.querySelector("#st-read"); const stop = rd.querySelector("[data-stop]"); return (!stop || stop.hidden) && rd.querySelector(".verdict")?.textContent.trim(); }, null, { timeout: 600000 });
  await page.waitForTimeout(1500);
  const read = await page.evaluate(() => {
    const rd = document.querySelector("#st-read");
    const bySeg = {};
    for (const t of rd.querySelectorAll("#st-read-text .tok[data-seg]")) bySeg[t.dataset.seg] = (bySeg[t.dataset.seg] || 0) + 1;
    return {
      verdict: rd.querySelector(".verdict")?.textContent.trim().slice(0, 140),
      sections: [...rd.querySelectorAll("#st-read-strip .fseg")].map(s => `${s.dataset.kind} ${s.querySelectorAll(".bit").length}`),
      tokensBySeg: bySeg,
      locked: rd.querySelector("#st-read-strip").classList.contains("locked"),
    };
  });
  log("read:", JSON.stringify(read));
  await page.screenshot({ path: join(OUT_DIR, "read-done.png") });
  log("screenshots in", OUT_DIR);
  await page.evaluate(() => window.rankmark.engine.unload());
} catch (err) {
  log("ERROR", String(err && err.stack || err));
  process.exitCode = 1;
} finally {
  await ctx.close();
  server.kill();
}
