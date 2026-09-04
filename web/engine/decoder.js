// Decode: re-read text through a lens, recover ranks, gate, parse frames.
// Teacher-forces the known tokens through the SAME KV-cached path encode used,
// so the ranks line up. Port of decoder.py + the server's streaming events.

import { bytesToHex } from "./bits.js";
import {
  frameSpans, llrOf, parseFramesSoft, partialSpans, tagOf,
} from "./framing.js";
import { entropyOf, rankOf } from "./logits.js";

export async function decode(lens, text, opts, onEvent) {
  const { tau = 2.0 } = opts;
  const lensTag = tagOf(lens.name);
  const ids = lens.encodeText(text);
  if (!ids.length) { onEvent({ type: "done", valid: false, spans: [], carriers: 0 }); return { valid: false }; }

  const bos = lens.bosId;
  // seed is one prefill token; every following token is forced and scored via a
  // single step — the same shape encode used, so the ranks line up
  const seed = bos !== null ? bos : ids[0];
  const targets = bos !== null ? ids : ids.slice(1);

  const llrs = [];
  const pieces = [];       // carrier pieces, in carrier order
  let reportedFrames = 0;
  let sinceParse = 0;
  let t = 0;

  const finalize = final => {
    const frames = parseFramesSoft(llrs, lensTag).filter(f => f.tagOk);
    const spans = frames.flatMap(frameSpans);
    if (final) {
      const best = frames[0];
      onEvent({
        type: "done",
        valid: frames.length > 0,
        payload: best ? bytesToHex(best.payload) : null,
        spans,
        carriers: llrs.length,
        frames: frames.length,
        lens: lens.name,
      });
    }
    return frames;
  };

  const decide = logits => {
    const tid = targets[t++];
    const entropy = entropyOf(logits);
    if (entropy >= tau) {
      const rank = rankOf(logits, tid);
      const bit = rank % 2;
      llrs.push(llrOf(rank, entropy, tau));
      pieces.push(lens.decodeOne(tid));
      onEvent({ type: "token", carrier: true, bit, piece: lens.decodeOne(tid), rank });
      // cheap: repaint the forming frame every carrier; full parse periodically
      onEvent({ type: "partial", spans: partialSpans(llrs) });
      if (++sinceParse >= 6) {
        sinceParse = 0;
        const frames = parseFramesSoft(llrs, lensTag).filter(f => f.tagOk);
        if (frames.length > reportedFrames) {
          reportedFrames = frames.length;
          onEvent({
            type: "frame",
            spans: frames.flatMap(frameSpans),
            payload: bytesToHex(frames[frames.length - 1].payload),
          });
        }
      }
    } else {
      onEvent({ type: "token", carrier: false, piece: lens.decodeOne(tid), rank: rankOf(logits, tid) });
    }
    return tid; // force the real next token
  };

  await lens.run(seed, targets.length, decide);
  const frames = finalize(true);
  return {
    valid: frames.length > 0,
    payload: frames[0] ? bytesToHex(frames[0].payload) : null,
    carriers: llrs.length,
    frames: frames.length,
  };
}
