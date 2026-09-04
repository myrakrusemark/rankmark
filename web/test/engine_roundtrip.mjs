// End-to-end engine round trip with a deterministic FAKE lens (no model
// download): a fixed pseudo-logit function stands in for the LM. Proves the
// encoder -> frame -> decoder path is internally consistent and that the
// forcing/gating/parse wiring is correct, independent of transformers.js.

import { embed } from "../engine/encoder.js";
import { decode } from "../engine/decoder.js";

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

class FakeLens {
  constructor(name) { this.name = name; }
  // clean bijection for generated ids: id -> char(64+id), char % VOCAB -> id
  encodeText(t) { return [...t].map(c => c.charCodeAt(0) % VOCAB); }
  decodeTokens(ids) { return ids.map(i => String.fromCharCode(64 + (i % VOCAB))).join(""); }
  decodeOne(id) { return String.fromCharCode(64 + (id % VOCAB)); }
  get eosId() { return -1; }        // never emitted
  get bosId() { return 0; }
  completionContext(p) { return [0, ...this.encodeText(p)]; }
  instructContext(p) { return [0, ...this.encodeText(p)]; }
  async run(seedId, maxNew, decide) {
    const ids = [seedId];
    for (let i = 0; i < maxNew; i++) {
      const logits = fakeLogits(ids[ids.length - 1]);
      ids.push(decide(logits));
    }
    return ids;
  }
}

let pass = 0, fail = 0;
function ok(cond, msg) { cond ? pass++ : (fail++, console.error("FAIL " + msg)); }

// --- hide, then reveal with the SAME lens: payload must come back ----------
const lens = new FakeLens("gpt2");
let started = null, doneEv = null;
await embed(lens, { prompt: "seed text here", payloadHex: "2a", profile: 0, tau: 2.0 },
  e => { if (e.type === "start") started = e; if (e.type === "done") doneEv = e; });
ok(started && started.frame_bits > 0, "embed emitted start with frame_bits");
ok(doneEv && doneEv.frames_planted >= 1, `embed planted >=1 frame (got ${doneEv && doneEv.frames_planted})`);

let decDone = null;
await decode(lens, doneEv.text, { tau: 2.0 }, e => { if (e.type === "done") decDone = e; });
ok(decDone && decDone.valid, "decode found a valid frame with the right lens");
ok(decDone && decDone.payload === "2a", `decode recovered payload 0x2a (got 0x${decDone && decDone.payload})`);

// --- reveal with a WRONG lens (different tag/logits): must NOT validate -----
const wrong = new FakeLens("Qwen2.5-0.5B-Instruct");
// perturb its logit field so ranks differ
wrong.encodeText = t => [...t].map(c => (c.charCodeAt(0) * 7 + 3) % VOCAB);
let wrongDone = null;
await decode(wrong, doneEv.text, { tau: 2.0 }, e => { if (e.type === "done") wrongDone = e; });
ok(wrongDone && !wrongDone.valid, "decode rejects the text under the wrong lens");

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
