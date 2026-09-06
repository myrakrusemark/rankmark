// What an edit does to a marked text, per frame profile: one seeded write of
// "hello" per profile, then reads of the same text with one word swapped at a
// quarter, a half and three quarters of the way through, a sentence deleted,
// and the tail cut. Reports validity, carriers and carrier-bit agreement
// against the writer's bits. Headless, campaign profile, 0.6B by default.
//
//   node web/test/ci/edits.mjs            PROFILES=0,1 RUNG=Qwen3-0.6B-Q8_0

import { chromium } from "playwright";
import { spawn } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import os from "node:os";

const here = dirname(fileURLToPath(import.meta.url));
const webRoot = join(here, "..", "..");
const PROFILE = process.env.PROFILE || join(os.homedir(), ".cache", "rankmark-playwright-profile");
const PORT = process.env.PORT || "8776";
const RUNG = process.env.RUNG || "Qwen3-0.6B-Q8_0";
const PROFILES = (process.env.PROFILES || "0,1").split(",").map(Number);
const COPIES = (process.env.COPIES || "1").split(",").map(Number);
const WINDOW = Number(process.env.WINDOW || 0);   // positions the model keeps in view; 0 = all
const DUMP = process.env.DUMP || "";               // save every variant's LLRs and the writer's bits here (JSON)
const PROMPT = "It was late in the harbor when the last boat came in, and";
const stamp = () => new Date().toISOString().slice(11, 19);
const log = (...a) => console.log(stamp(), ...a);

const server = spawn(process.execPath, [join(webRoot, "serve.mjs")], { env: { ...process.env, PORT }, stdio: ["ignore", "inherit", "inherit"] });
await new Promise(r => setTimeout(r, 1500));
const ctx = await chromium.launchPersistentContext(PROFILE, { headless: true });
try {
  const page = await ctx.newPage();
  page.on("pageerror", e => log("[pageerror]", e.message));
  await page.goto(`http://127.0.0.1:${PORT}/test/engine/index.html`, { waitUntil: "load" });
  await page.waitForFunction(() => !!(window.engine && window.engine.registry), null, { timeout: 60000 });

  for (const profile of PROFILES) for (const copies of COPIES) {
    log(`profile ${profile}, ${copies} cop${copies === 1 ? "y" : "ies"}: writing`);
    const out = await page.evaluate(async ({ rungId, profile, prompt, copies, win }) => {
      const { agreement } = await import("/engine/compare.js");
      const rung = { ...window.engine.registry.rungs.find(r => r.id === rungId), window: win };
      const hex = [...new TextEncoder().encode("hello")].map(b => b.toString(16).padStart(2, "0")).join("");
      const written = [];
      const emb = await window.engine.runJob("embed", { rung, opts: { prompt, payloadHex: hex, profile, temperature: 0.7, seed: 4242, copies } }, {
        onEvent: e => { if (e.type === "token") written.push({ id: e.id, carrier: e.carrier, bit: e.bit }); },
      });
      const text = emb.text;
      const words = text.split(" ");
      const swapAt = frac => { const w = [...words]; const i = Math.floor(w.length * frac); w[i] = w[i].length > 3 ? "thing" : "and"; return w.join(" "); };
      const sentences = text.split(/(?<=[.!?])\s+/);
      const dropSentence = sentences.length > 3 ? [...sentences.slice(0, 1), ...sentences.slice(2)].join(" ") : null;
      const variants = {
        original: text,
        "swap at 25%": swapAt(0.25), "swap at 50%": swapAt(0.5), "swap at 75%": swapAt(0.75),
        "second sentence deleted": dropSentence,
        "last 20% cut": text.slice(0, text.lastIndexOf(" ", Math.floor(text.length * 0.8))),
      };
      const results = {};
      for (const [name, v] of Object.entries(variants)) {
        if (!v) continue;
        const read = [];
        const dec = await window.engine.runJob("decode", { rung, text: v, opts: {} }, { onEvent: e => { if (e.type === "token") read.push({ id: e.id, carrier: e.carrier, bit: e.bit ?? null }); } });
        const a = agreement(written, read);
        // where the flips fall, by tenths of the planted bits: with the whole text in
        // view they spread over everything after the edit; a window should pen them in
        const n = a.perPlanted.length, tenths = new Array(10).fill(0), lostBy = new Array(10).fill(0);
        a.perPlanted.forEach((r, k) => { const t = Math.min(9, Math.floor((10 * k) / n)); if (r.status === "flip") tenths[t]++; if (r.status === "lost") lostBy[t]++; });
        results[name] = { valid: dec.valid, combined: dec.combined, payload: dec.payload, carriers: dec.carriers, agree: a.agreementPct, survived: a.survived, planted: a.planted, z: a.z, flipsByTenth: tenths, lostByTenth: lostBy, llrs: dec.llrs, read };
      }
      return { tokens: written.length, carriers: written.filter(t => t.carrier).length, framesPlanted: emb.framesPlanted, frameBits: emb.frameBits ?? null, results, written, text };
    }, { rungId: RUNG, profile, prompt: PROMPT, copies, win: WINDOW });
    log(`profile ${profile}, ${copies} copies${WINDOW ? `, window ${WINDOW}` : ""}: ${out.tokens} tokens, ${out.carriers} carriers, ${out.framesPlanted?.toFixed(2)} frames`);
    for (const [name, r] of Object.entries(out.results)) log(`  ${name.padEnd(26)} valid ${String(r.valid).padEnd(5)}${r.valid && r.combined > 1 ? ` (${r.combined} copies combined)` : ""}  agree ${String(r.agree).padStart(5)}% (${r.survived}/${r.planted})  z ${r.z}  flips by tenth ${r.flipsByTenth.join(" ")}  lost ${r.lostByTenth.join(" ")}`);
    if (DUMP) {
      const { writeFileSync } = await import("node:fs");
      const slim = Object.fromEntries(Object.entries(out.results).map(([k, r]) => [k, { valid: r.valid, combined: r.combined, llrs: r.llrs, read: r.read }]));
      writeFileSync(DUMP.replace(/\.json$/, "") + `-p${profile}-c${copies}${WINDOW ? "-w" + WINDOW : ""}.json`, JSON.stringify({ rung: RUNG, profile, copies, window: WINDOW, written: out.written, text: out.text, results: slim }));
      log("dumped");
    }
  }
  await page.evaluate(() => window.engine.unload());
} catch (err) {
  log("ERROR", String(err && err.stack || err));
  process.exitCode = 1;
} finally {
  await ctx.close();
  server.kill();
}
