// Plain generation, no frame: the model continues a prompt while every step
// reports its ranked candidates and which one was taken. This is the ranked
// choice visualizer's engine. Same single-step path as the watermark.

import { entropyOf, sortedTokenIds } from "./logits.js";
import { mulberry32, randomSeed, sampleSoftmax } from "./sampling.js";
import { topOf } from "./encoder.js";

export async function sample(lens, opts, onEvent) {
  const { prompt, maxNew = 24, temperature = 0.7, topK = 48 } = opts;
  const seed = temperature > 0 ? (opts.seed ?? randomSeed()) : null;
  const rng = seed !== null ? mulberry32(seed) : null;
  const context = await lens.completionContext(prompt);
  if (!context.length) throw new Error("prompt tokenized to nothing");
  const replay = context.slice(1);
  let ri = 0;
  onEvent({ type: "start", seed, temperature, context_tokens: context.length });
  const decide = logits => {
    if (ri < replay.length) return replay[ri++];
    const order = sortedTokenIds(logits);
    let rank = 0;
    if (rng) {
      const k = Math.min(topK, order.length);
      const cand = [];
      for (let r = 0; r < k; r++) cand.push(r);
      rank = cand[sampleSoftmax(cand.map(r => logits[order[r]]), temperature, rng)];
    }
    const id = order[rank];
    onEvent({ type: "token", id, piece: lens.decodeOne(id), rank, entropy: Math.round(entropyOf(logits) * 1000) / 1000, top: topOf(logits, lens, 8) });
    return id;
  };
  const ids = await lens.run(context[0], replay.length + maxNew, decide, { stopOn: lens.eogIds });
  const gen = ids.slice(context.length).filter(t => !lens.eogIds.has(t));
  const text = await lens.decodeTokens(gen);
  onEvent({ type: "done", text, seed });
  return { text, ids: gen, seed };
}
