// Embed a payload while generating — the token choices ARE the watermark.
// Port of encoder.py: greedy and same-parity temperature sampling, full
// context (no window in the browser engine).

import { hexToBytes } from "./bits.js";
import { buildFrame, layoutOf, tagOf } from "./framing.js";
import { entropyOf, sortedTokenIds } from "./logits.js";
import { mulberry32, randomSeed, sampleSoftmax } from "./sampling.js";
import { textHash } from "./fingerprint.js";

// encode_step: below the gate emit rank 0 (a null); above it emit the top token
// whose rank parity == nextBit. Banned tokens (the end-of-generation set, until
// one frame is planted) are skipped to the next choice of the same role, so the
// rank the reader recovers keeps its parity. With a sampler, a null samples
// across the top_k window and a carrier samples among top_k tokens of the right
// parity; the reader only ever reads parity, so the round trip is unchanged.
function encodeStep(logits, nextBit, tau, ban, sampler) {
  const entropy = entropyOf(logits);
  const order = sortedTokenIds(logits);
  const isNull = entropy < tau;
  const banned = r => ban !== null && ban.has(order[r]);

  if (!sampler) {
    if (isNull) {
      let rank = 0;
      while (banned(rank)) rank++;
      return { tokenId: order[rank], planted: false, rank, entropy };
    }
    let rank = nextBit;
    while (banned(rank)) rank += 2; // same parity, next-best
    return { tokenId: order[rank], planted: true, rank, entropy };
  }

  const k = Math.min(sampler.topK, order.length);
  let cand = [];
  for (let r = 0; r < k; r++) if (isNull || r % 2 === nextBit) cand.push(r);
  const allowed = cand.filter(r => !banned(r));
  if (allowed.length) cand = allowed;
  const pick = sampleSoftmax(cand.map(r => logits[order[r]]), sampler.temperature, sampler.rng);
  const rank = cand[pick];
  return { tokenId: order[rank], planted: !isNull, rank, entropy };
}

export async function embed(lens, opts, onEvent) {
  const {
    prompt, payloadHex, profile = 0,
    temperature = 0.7, topK = 48,
  } = opts;
  // the gate is a property of the lens: bigger models are more confident and need a lower one
  const tau = opts.tau ?? lens.rung?.tau ?? 2.0;
  const seed = temperature > 0 ? (opts.seed ?? randomSeed()) : null;
  const sampler = temperature > 0 ? { temperature, topK, rng: mulberry32(seed) } : null;

  const payload = hexToBytes(payloadHex);
  const frame = buildFrame(payload, profile, tagOf(lens.name));
  const frameBits = frame.length;
  const nbytes = payload.length;

  const context = await lens.completionContext(prompt);
  if (!context.length) throw new Error("prompt tokenized to nothing");
  const eog = lens.eogIds;

  // budget from the measured carrier rate (one frame plus slack), capped by the
  // context window; the ban keeps the run going until a frame is planted
  const rate = lens.rung?.carrierRate || 0.12;
  const need = Math.ceil((frameBits / rate) * 1.3);
  const cap = Math.max(64, (lens.nCtx ?? 2048) - context.length - 8);
  const maxNew = Math.min(opts.maxNew || need, cap);

  let planted = 0, carriers = 0, nextIdx = 0;
  onEvent({
    type: "start", frame_bits: frameBits, max_new: maxNew, seed, temperature, tau,
    layout: layoutOf(nbytes, profile), context_tokens: context.length,
  });

  // context[0] is the prefill seed; context[1..] are force-replayed as single
  // steps (ungated, not part of the watermark) so encode's KV cache is built the
  // exact way decode's is. Only after the context is replayed does the channel
  // start planting bits.
  const replay = context.slice(1);
  let ri = 0;

  const decide = logits => {
    if (ri < replay.length) return replay[ri++]; // still feeding the context
    const nextBit = frame[nextIdx % frameBits];
    const ban = planted < frameBits ? eog : null;
    const choice = encodeStep(logits, nextBit, tau, ban, sampler);
    if (choice.planted) { planted++; nextIdx++; carriers++; }
    onEvent({
      type: "token",
      id: choice.tokenId,
      piece: lens.decodeOne(choice.tokenId),
      rank: choice.rank,
      entropy: Math.round(choice.entropy * 1000) / 1000,
      carrier: choice.planted,
      bit: choice.rank % 2,
    });
    if (choice.planted) {
      const frac = (carriers % frameBits) / frameBits;
      const copies = Math.floor(carriers / frameBits);
      onEvent({ type: "progress", carriers, frameBits, copies, frac, nbytes });
    }
    return choice.tokenId;
  };

  // once a whole frame is in, end the passage at the next sentence boundary
  // rather than running out the budget; a few words past the seal keep the
  // last bits off the very end of the text
  let sinceFrame = 0;
  const stopWhen = id => {
    if (planted < frameBits) return false;
    sinceFrame++;
    return sinceFrame >= 6 && /[.!?]["')\]]?\s*$/.test(lens.decodeOne(id));
  };
  const allIds = await lens.run(context[0], replay.length + maxNew, decide, { stopOn: eog, stopWhen });
  const plain = await lens.encodeText(prompt);
  const bosLen = context.length - plain.length; // 1 if BOS was prepended
  const visibleIds = allIds.slice(bosLen).filter(t => !eog.has(t));
  const text = await lens.decodeTokens(visibleIds);

  const retokenizes = arraysEqual(await lens.encodeText(text), visibleIds);
  const hash = await textHash(text);
  const framesPlanted = planted / frameBits;
  const result = {
    text,
    ids: visibleIds,
    framesPlanted,
    retokenizes,
    seed,
    temperature,
    fingerprint: lens.fp,
    textHash: hash,
    lens: lens.name,
  };
  onEvent({
    type: "done",
    text,
    frames_planted: Math.round(framesPlanted * 100) / 100,
    retokenizes_cleanly: retokenizes,
    seed,
    fingerprint: lens.fp,
    text_hash: hash,
    lens: lens.name,
  });
  return result;
}

function arraysEqual(a, b) {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}
