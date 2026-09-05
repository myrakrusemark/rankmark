// False-frame sieve: how often does noise pass the gate? Random carrier bits
// (fair, biased, and runs) through the frame parser for every profile, so the
// page can show a measured false-accept rate next to each verdict.
//
//   node web/test/tools/sieve.mjs [trials=100000] [carriers=400] > web/data/sieve.json

import { PROFILES, parseFramesSoft, frameLenBits, tagOf } from "../../engine/framing.js";
import { llrOf } from "../../engine/framing.js";
import { mulberry32 } from "../../engine/sampling.js";

const trials = Number(process.argv[2] || 100000);
const carriers = Number(process.argv[3] || 400);
const tag = tagOf("Qwen3-0.6B-Q8_0");
const rng = mulberry32(20260904);

// soft bits the way the decoder makes them: rank parity at a plausible entropy
const bitLlr = (bit, entropy) => llrOf(bit ? 1 : 0, entropy, 2.0);

const sources = {
  fair: () => rng() < 0.5,
  biased70: () => rng() < 0.7,          // a reader that favors rank 0
  runs: (() => { let b = 0; return () => { if (rng() < 0.15) b ^= 1; return !!b; }; })(),
};

const out = { generated: new Date().toISOString(), trials, carriers, tag, profiles: {} };
for (const [pid, profile] of Object.entries(PROFILES)) {
  const bits = frameLenBits(1, Number(pid));
  const res = { name: profile.name, frameBitsFor1Byte: bits, sources: {} };
  for (const [name, draw] of Object.entries(sources)) {
    let hits = 0;
    for (let t = 0; t < trials; t++) {
      const llrs = new Array(carriers);
      for (let i = 0; i < carriers; i++) llrs[i] = bitLlr(draw(), 2.5 + rng() * 3);
      if (parseFramesSoft(llrs, tag).some(f => f.tagOk)) hits++;
    }
    res.sources[name] = { falseFrames: hits, rate: hits / trials };
  }
  out.profiles[pid] = res;
  console.error(`profile ${pid} (${profile.name}): ${JSON.stringify(res.sources)}`);
}
console.log(JSON.stringify(out, null, 1));
