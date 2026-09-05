// Cross-machine determinism probe. Serves web/ with the isolation headers,
// drives the engine test page in one browser, and writes one JSON record:
// the logit hash after a fixed prompt, and the text and carrier bits of a
// seeded write plus its read. compare.mjs diffs the records across the matrix.
//
//   BROWSER=chromium|firefox|webkit RUNG=Qwen3-0.6B-Q8_0 OUT_DIR=ci-out node determinism.mjs

import { chromium, firefox, webkit } from "playwright";
import { spawn } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import os from "node:os";

const here = dirname(fileURLToPath(import.meta.url));
const webRoot = join(here, "..", "..");
const browserName = process.env.BROWSER || "chromium";
const rung = process.env.RUNG || "Qwen3-0.6B-Q8_0";
const outDir = process.env.OUT_DIR || join(here, "out");
const PORT = process.env.PORT || "8771";
const PROMPT = "The history of cryptography begins with";
const SEED = 20260904;

const server = spawn(process.execPath, [join(webRoot, "serve.mjs")], {
  env: { ...process.env, PORT }, stdio: ["ignore", "inherit", "inherit"],
});
await new Promise(r => setTimeout(r, 1500));

const engines = { chromium, firefox, webkit };
// PW_CHANNEL=chrome drives the installed Google Chrome instead of Playwright's Chromium
const channel = process.env.PW_CHANNEL || undefined;
const browser = await engines[browserName].launch({ headless: true, channel });
const record = {
  os: `${os.platform()} ${os.release()}`, arch: os.arch(), cpus: os.cpus().length,
  browser: channel ? `${browserName}:${channel}` : browserName, rung, generated: new Date().toISOString(),
};
try {
  const page = await browser.newPage();
  page.on("console", m => { if (m.type() === "error" || m.type() === "warning") console.error(`[page ${m.type()}]`, m.text()); });
  page.on("pageerror", e => console.error("[pageerror]", e.message));
  await page.goto(`http://127.0.0.1:${PORT}/test/engine/index.html`, { waitUntil: "load" });
  await page.waitForFunction(() => !!(window.engine && window.engine.registry), null, { timeout: 60000 });

  record.env = await page.evaluate(() => ({
    ua: navigator.userAgent,
    isolated: !!self.crossOriginIsolated,
    memory64: (() => { try { new WebAssembly.Memory({ address: "i64", initial: 1n, maximum: 2n }); return true; } catch { return false; } })(),
    jspi: typeof WebAssembly.Suspending === "function",
    threads: navigator.hardwareConcurrency ?? null,
  }));
  console.log("env", JSON.stringify(record.env));

  const t0 = Date.now();
  record.load = await page.evaluate(id => window.engine.load(id), rung);
  record.load.wallSeconds = (Date.now() - t0) / 1000;
  console.log("loaded", JSON.stringify(record.load));

  record.logitHash = await page.evaluate(({ id, prompt }) =>
    window.engine.runJob("logitHash", { rung: window.engine.registry.rungs.find(r => r.id === id), prompt }), { id: rung, prompt: PROMPT });
  console.log("logit hash", JSON.stringify(record.logitHash));

  // the same row single-threaded: separates a kernel difference from a scheduling one
  record.logitHash1 = await page.evaluate(({ id, prompt }) =>
    window.engine.runJob("logitHash", { rung: window.engine.registry.rungs.find(r => r.id === id), prompt, threads: 1 }), { id: rung, prompt: PROMPT });
  console.log("logit hash, 1 thread", JSON.stringify(record.logitHash1));

  // the weights this browser actually downloaded, against the registry
  record.weights = await page.evaluate(id => window.engine.hashCachedModel(id), rung);
  console.log("weights", JSON.stringify(record.weights));

  const t1 = Date.now();
  const snap = await page.evaluate(({ id, opts }) => window.engine.snapshot(id, opts),
    { id: rung, opts: { prompt: PROMPT, payloadHex: "a7", profile: 0, temperature: 0.7, seed: SEED, maxNew: 260 } });
  record.write = {
    text: snap.write.text, textHash: snap.write.textHash, fingerprint: snap.fingerprint,
    tokens: snap.write.tokens.length, carriers: snap.write.tokens.filter(t => t.carrier).length,
    bits: snap.write.tokens.map(t => t.carrier ? String(t.bit) : ".").join(""),
    ranks: snap.write.tokens.map(t => t.rank).join(","),
  };
  record.read = { valid: snap.read.valid, payload: snap.read.payload, carriers: snap.read.carriers, frames: snap.read.frames };
  record.roundTripSeconds = (Date.now() - t1) / 1000;
  console.log("write", record.write.tokens, "tokens,", record.write.carriers, "carriers; read valid:", record.read.valid, "payload:", record.read.payload);
  record.ok = true;
} catch (err) {
  record.ok = false;
  record.error = String(err && err.stack || err);
  console.error(record.error);
} finally {
  await browser.close();
  server.kill();
}

mkdirSync(outDir, { recursive: true });
const file = join(outDir, `${os.platform()}-${os.arch()}-${record.browser.replace(":", "-")}.json`);
writeFileSync(file, JSON.stringify(record, null, 1));
console.log("wrote", file);
process.exit(record.ok ? 0 : 1);
