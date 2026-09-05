// End-to-end engine round trip with a deterministic FAKE lens (no model
// download): a fixed pseudo-logit function stands in for the LM. Proves the
// encoder -> frame -> decoder path is internally consistent and that the
// forcing/gating/parse/sampling wiring is correct, independent of the engine.

import { embed } from "../engine/encoder.js";
import { decode } from "../engine/decoder.js";
import { fingerprint, fingerprintDiff, markCard, parseMarkCard, textHash } from "../engine/fingerprint.js";

const VOCAB = 64;

// deterministic "logits": depend only on the last token id, so encode and
// decode (teacher-forced to the same ids) see identical distributions.
function fakeLogits(lastId) {
  const row = new Float32Array(VOCAB);
  let x = (lastId * 2654435761) >>> 0;
  for (let i = 0; i < VOCAB; i++) {
    x = (x ^ (x << 13)) >>> 0; x = (x ^ (x >>> 17)) >>> 0; x = (x ^ (x << 5)) >>> 0;
    // spread values so entropy is comfortably above tau most of the time
    row[i] = ((x % 1000) / 1000) * 6;
  }
  return row;
}

// same contract as lens.js: async tokenizer, eogIds set, run() with stopOn
class FakeLens {
  constructor(name) {
    this.name = name;
    this.rung = { id: name, carrierRate: 0.5, engine: { commit: "test" } };
    this.nCtx = 4096;
    this.eogIds = new Set([63]); // one "end" token, banned until a frame is planted
    this.fp = "000000000000";
    this.steps = [];
  }
  // clean bijection for generated ids: id -> char(64+id), char % VOCAB -> id
  async encodeText(t) { return [...t].map(c => c.charCodeAt(0) % VOCAB); }
  async decodeTokens(ids) { return ids.map(i => String.fromCharCode(64 + (i % VOCAB))).join(""); }
  decodeOne(id) { return String.fromCharCode(64 + (id % VOCAB)); }
  get bosId() { return 0; }
  async completionContext(p) { return [0, ...(await this.encodeText(p))]; }
  async run(seedId, maxNew, decide, { stopOn, stopWhen } = {}) {
    const ids = [seedId];
    for (let i = 0; i < maxNew; i++) {
      const logits = fakeLogits(ids[ids.length - 1]);
      const id = decide(logits);
      ids.push(id);
      if (stopOn && stopOn.has(id)) break;
      if (stopWhen && stopWhen(id)) break;
    }
    return ids;
  }
}

let pass = 0, fail = 0;
function ok(cond, msg) { cond ? pass++ : (fail++, console.error("FAIL " + msg)); }

const collect = () => { const ev = {}; return { ev, on: e => { if (e.type === "start") ev.start = e; if (e.type === "done") ev.done = e; if (e.type === "token" && e.id === 63) ev.sawEog = true; } }; };

// --- greedy: hide, then reveal with the SAME lens: payload must come back --
const lens = new FakeLens("gpt2");
let c = collect();
const emb = await embed(lens, { prompt: "seed text here", payloadHex: "2a", profile: 0, tau: 2.0, temperature: 0 }, c.on);
ok(c.ev.start && c.ev.start.frame_bits > 0, "embed emitted start with frame_bits");
ok(c.ev.start.seed === null, "greedy run has no seed");
ok(emb.framesPlanted >= 1, `embed planted >=1 frame (got ${emb.framesPlanted})`);
ok(emb.retokenizes, "generated text re-tokenizes to its ids");
ok(!emb.ids.includes(63), "end-of-generation id never appears in the visible ids");

let dec = await decode(lens, emb.text, { tau: 2.0 }, () => {});
ok(dec.valid, "decode found a valid frame with the right lens");
ok(dec.payload === "2a", `decode recovered payload 0x2a (got 0x${dec.payload})`);
ok(/^[0-9a-f]{12}$/.test(emb.textHash) && emb.textHash === await textHash(emb.text), "embed reports the hash of its text");

// --- sampled: same round trip at temperature 0.7, and a seed reproduces it --
const s1 = await embed(lens, { prompt: "seed text here", payloadHex: "c3", profile: 0, temperature: 0.7, seed: 4242 }, () => {});
const s2 = await embed(lens, { prompt: "seed text here", payloadHex: "c3", profile: 0, temperature: 0.7, seed: 4242 }, () => {});
ok(s1.text === s2.text, "the same seed reproduces the same sampled text");
ok(s1.seed === 4242, "the seed is reported");
dec = await decode(lens, s1.text, { tau: 2.0 }, () => {});
ok(dec.valid && dec.payload === "c3", `sampled text decodes to 0xc3 (got ${dec.payload})`);
const s3 = await embed(lens, { prompt: "seed text here", payloadHex: "c3", profile: 0, temperature: 0.7, seed: 99 }, () => {});
ok(s3.text !== s1.text, "a different seed gives different text");

// --- budget: maxNew follows the carrier rate, capped by the context --------
c = collect();
await embed(lens, { prompt: "x", payloadHex: "2a", profile: 0, temperature: 0 }, c.on);
ok(c.ev.start.max_new === Math.ceil((c.ev.start.frame_bits / 0.5) * 2.0), `max_new from the carrier rate (got ${c.ev.start.max_new})`);
const tiny = new FakeLens("gpt2"); tiny.nCtx = 100;
c = collect();
await embed(tiny, { prompt: "x", payloadHex: "2a", profile: 0, temperature: 0 }, c.on);
ok(c.ev.start.max_new <= 100, `max_new capped by the context window (got ${c.ev.start.max_new})`);

// --- reveal with a WRONG lens (different tag/logits): must NOT validate -----
const wrong = new FakeLens("Qwen3-1.7B-Q8_0");
// perturb its logit field so ranks differ
wrong.encodeText = async t => [...t].map(c => (c.charCodeAt(0) * 7 + 3) % VOCAB);
wrong.decodeTokens = async ids => ids.map(i => String.fromCharCode(64 + (i % VOCAB))).join("");
dec = await decode(wrong, emb.text, { tau: 2.0 }, () => {});
ok(!dec.valid, "decode rejects the text under the wrong lens");

// --- mark card and fingerprint ------------------------------------------------
const fp = await fingerprint({ engine: "9fb194c", model: "Qwen3-0.6B-Q8_0", sha256: "abc", quant: "Q8_0", threads: 4, flashAttn: false, nCtx: 2048 });
ok(/^[0-9a-f]{12}$/.test(fp), "fingerprint is 12 hex chars");
const fp2 = await fingerprint({ engine: "9fb194c", model: "Qwen3-0.6B-Q8_0", sha256: "abc", quant: "Q8_0", threads: 4, flashAttn: false, nCtx: 2048 });
ok(fp === fp2, "fingerprint is stable");
const fp3 = await fingerprint({ engine: "9fb194c", model: "Qwen3-0.6B-Q8_0", sha256: "abc", quant: "Q8_0", threads: 2, flashAttn: false, nCtx: 2048 });
ok(fp === fp3, "thread count does not change the fingerprint");
const fp4 = await fingerprint({ engine: "9fb194c", model: "Qwen3-0.6B-Q8_0", sha256: "abc", quant: "Q4_K_M", flashAttn: false, nCtx: 2048 });
ok(fp !== fp4, "quantization changes the fingerprint");
ok(fingerprintDiff({ quant: "Q8_0", model: "a" }, { quant: "Q4_K_M", model: "a" }).join() === "quant", "fingerprintDiff names the differing field");
const th = await textHash("Some marked text.");
const card = markCard("Some marked text.", "Qwen3-0.6B-Q8_0", fp, th);
const parsed = parseMarkCard(card);
ok(parsed && parsed.text === "Some marked text." && parsed.rungId === "Qwen3-0.6B-Q8_0" && parsed.fp === fp && parsed.textHash === th, "mark card round-trips with the text hash");
ok(parseMarkCard(markCard("t", "r", fp)).textHash === null, "a card without a text hash still parses");
ok(parseMarkCard("plain text with no footer") === null, "plain text has no card");
ok(parseMarkCard(card + "\n").text === "Some marked text.", "trailing newline after the footer is tolerated");
ok((await textHash("Some marked text!")) !== th, "an edited text hashes differently");

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
