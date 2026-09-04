// Embed a payload while generating — the token choices ARE the watermark.
// Port of encoder.py (greedy path; full-context, no window for the web demo).

import { hexToBytes } from "./bits.js";
import { buildFrame, frameLenBits, tagOf } from "./framing.js";
import { entropyOf, sortedTokenIds } from "./logits.js";

// greedy encode_step: below the gate emit rank 0 (a null); above it emit the
// top token whose rank parity == nextBit. A banned token (EOS before a frame
// completes) is skipped to the next choice of the same role.
function encodeStep(logits, nextBit, tau, banToken) {
  const entropy = entropyOf(logits);
  const order = sortedTokenIds(logits);
  const isNull = entropy < tau;
  if (isNull) {
    const rank = order[0] === banToken ? 1 : 0;
    return { tokenId: order[rank], planted: false, rank, entropy };
  }
  let rank = nextBit;
  while (order[rank] === banToken) rank += 2; // same parity, next-best
  return { tokenId: order[rank], planted: true, rank, entropy };
}

export async function embed(lens, opts, onEvent) {
  const { prompt, payloadHex, profile = 0, tau = 2.0, instruct = false } = opts;
  const payload = hexToBytes(payloadHex);
  const frame = buildFrame(payload, profile, tagOf(lens.name));
  const frameBits = frame.length;
  const nbytes = payload.length;

  // tokenizer calls are awaited: a worker-backed lens answers them asynchronously
  const context = instruct ? await lens.instructContext(prompt) : await lens.completionContext(prompt);
  if (!context.length) throw new Error("prompt tokenized to nothing");
  const eos = lens.eosId;

  // size the run for ~2 copies past a little slack; the EOS ban keeps it going
  // until at least one full frame is planted
  const maxNew = opts.maxNew || Math.min(1200, Math.round(frameBits * 2.4) + 32);

  let planted = 0, carriers = 0, nextIdx = 0;
  onEvent({ type: "start", frame_bits: frameBits });

  // context[0] is the prefill seed; context[1..] are force-replayed as single
  // steps (ungated, not part of the watermark) so encode's KV cache is built the
  // exact way decode's is. Only after the context is replayed does the channel
  // start planting bits.
  const replay = context.slice(1);
  let ri = 0;

  const decide = logits => {
    if (ri < replay.length) return replay[ri++]; // still feeding the context
    const nextBit = frame[nextIdx % frameBits];
    const ban = planted < frameBits ? eos : null;
    const choice = encodeStep(logits, nextBit, tau, ban);
    if (choice.planted) { planted++; nextIdx++; carriers++; }
    onEvent({
      type: "token",
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

  const allIds = await lens.run(context[0], replay.length + maxNew, decide);
  const genIds = allIds.slice(context.length).filter(t => t !== eos);

  let text, visibleIds;
  if (instruct) {
    visibleIds = genIds;
    text = await lens.decodeTokens(genIds);
  } else {
    const plain = await lens.encodeText(prompt);
    const bosLen = context.length - plain.length; // 1 if BOS was prepended
    visibleIds = allIds.slice(bosLen).filter(t => t !== eos);
    text = await lens.decodeTokens(visibleIds);
  }

  const retokenizes = arraysEqual(await lens.encodeText(text), visibleIds);
  const framesPlanted = planted / frameBits;
  onEvent({
    type: "done",
    text,
    frames_planted: Math.round(framesPlanted * 100) / 100,
    retokenizes_cleanly: retokenizes,
  });
  return { text, framesPlanted, retokenizes };
}

function arraysEqual(a, b) {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}
