// Measurement campaign, headless and restartable. Drives the engine page in a
// persistent Chromium profile (so the OPFS model cache survives between runs),
// runs each plan step through page.evaluate, and writes the results file after
// every step; a rerun skips steps already recorded.
//
//   node campaign.mjs            # plan from PLAN env or the default below
//   OUT=web/data/measurements.json PROFILE=~/.cache/rankmark-playwright-profile

import { chromium } from "playwright";
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import os from "node:os";

const here = dirname(fileURLToPath(import.meta.url));
const webRoot = join(here, "..", "..");
const OUT = process.env.OUT || join(webRoot, "data", "measurements.json");
const PROFILE = process.env.PROFILE || join(os.homedir(), ".cache", "rankmark-playwright-profile");
const PORT = process.env.PORT || "8776";
const LINEUP_TOKENS = Number(process.env.LINEUP_TOKENS || 200);
const PLAN = JSON.parse(process.env.PLAN || JSON.stringify([
  { id: "Qwen3-0.6B-Q8_0", n: 1, cuts: true },
  { id: "Qwen3-1.7B-Q8_0", n: 1, cuts: true },
  { id: "Qwen3-4B-Q4_K_M", n: 1, cuts: false },
  { id: "Qwen3-8B-Q4_K_M", n: 1, cuts: false },
]));

const stamp = () => new Date().toISOString().slice(11, 19);
const log = (...a) => console.log(stamp(), ...a);

const out = existsSync(OUT) ? JSON.parse(readFileSync(OUT, "utf8")) : {
  generated: new Date().toISOString(),
  host: `${os.platform()} ${os.arch()} ${os.cpus()[0]?.model ?? ""} x${os.cpus().length}`,
  plan: PLAN, lineupTokens: LINEUP_TOKENS, measurements: {}, lineups: {},
};
const save = () => {
  mkdirSync(dirname(OUT), { recursive: true });
  out.updated = new Date().toISOString();
  writeFileSync(OUT, JSON.stringify(out, null, 1));
};

const server = spawn(process.execPath, [join(webRoot, "serve.mjs")], {
  env: { ...process.env, PORT }, stdio: ["ignore", "inherit", "inherit"],
});
await new Promise(r => setTimeout(r, 1500));

mkdirSync(PROFILE, { recursive: true });
const ctx = await chromium.launchPersistentContext(PROFILE, { headless: true });
try {
  const page = await ctx.newPage();
  page.on("console", m => { const t = m.text(); if (/measure|lineup|download|ERROR|\[/.test(t)) log("[page]", t.slice(0, 200)); });
  page.on("pageerror", e => log("[pageerror]", e.message));
  await page.goto(`http://127.0.0.1:${PORT}/test/engine/index.html`, { waitUntil: "load" });
  await page.waitForFunction(() => !!(window.engine && window.engine.registry), null, { timeout: 60000 });
  out.env = await page.evaluate(() => window.engine.probe());
  out.env.ua = await page.evaluate(() => navigator.userAgent);
  save();

  // MODE=entropy: one short write per rung, carrier rate as a function of the gate
  if (process.env.MODE === "entropy") {
    out.entropy = out.entropy || {};
    for (const p of PLAN) {
      if (out.entropy[p.id]) { log("skip entropy", p.id); continue; }
      log("entropy profile", p.id);
      out.entropy[p.id] = await page.evaluate(id => window.engine.entropyProfile(id, 200), p.id);
      save();
      log("saved", p.id, JSON.stringify(out.entropy[p.id].carrierRateByTau), "tok/s", out.entropy[p.id].tokPerSec);
    }
    await page.evaluate(() => window.engine.unload());
    log("entropy profiles complete");
    await ctx.close();
    server.kill();
    process.exit(0);
  }

  for (const p of PLAN) {
    if (out.measurements[p.id]) { log("skip measured", p.id); continue; }
    log("measure", p.id);
    out.measurements[p.id] = await page.evaluate(p => window.engine.measure(p.id, p.n, { cuts: p.cuts }), p);
    save();
    log("saved", p.id, JSON.stringify(out.measurements[p.id].summary));
  }
  const ids = PLAN.map(p => p.id);
  for (const wId of ids) {
    if (out.lineups[wId]) { log("skip lineup", wId); continue; }
    log("lineup", wId);
    out.lineups[wId] = await page.evaluate(
      ({ wId, readers, n }) => window.engine.lineup(wId, readers, 777, n),
      { wId, readers: ids.filter(x => x !== wId), n: LINEUP_TOKENS });
    save();
    log("saved lineup", wId, JSON.stringify(out.lineups[wId].results.map(r => [r.reader, r.valid, r.bitAgreement])));
  }
  await page.evaluate(() => window.engine.unload());
  log("campaign complete");
} catch (err) {
  log("ERROR", String(err && err.stack || err));
  process.exitCode = 1;
} finally {
  await ctx.close();
  server.kill();
}
