// Decode: re-read text through a lens, recover ranks, gate, parse frames.
// Teacher-forces the known tokens through the SAME single-step path encode
// used, so the ranks line up. Port of decoder.py + the server's streaming events.

import { bytesToHex } from "./bits.js";
import {
  frameSpans, llrOf, parseFramesSoft, partialSpans, tagOf,
} from "./framing.js";
import { entropyOf, rankOf } from "./logits.js";
import { echoLengths, EchoSlots, parseEcho, ECHO } from "./echo.js";

export async function decode(lens, text, opts, onEvent) {
  const tau = opts.tau ?? lens.rung?.tau ?? 2.0;
  const lensTag = tagOf(lens.name);
  const ids = await lens.encodeText(text);
  if (!ids.length) {
    onEvent({ type: "done", valid: false, spans: [], carriers: 0, lens: lens.name });
    return { valid: false };
  }

  const bos = lens.bosId;
  // seed is one prefill token; every following token is forced and scored via a
  // single step — the same shape encode used, so the ranks line up
  const seed = bos !== null ? bos : ids[0];
  const targets = bos !== null ? ids : ids.slice(1);
  // the first visible word is the seed: never scored, so the page can show it unmarked
  if (bos === null) onEvent({ type: "seed", id: seed, piece: lens.decodeOne(seed) });

  const llrs = [];
  let reportedFrames = 0;
  let sinceParse = 0;
  let t = 0;
  // the echo: a slot rule per possible packet length, advanced at every token;
  // each carrier's slot is kept in step with its LLR
  const allIds = [seed, ...targets];
  const echoes = echoLengths().map(n => ({ n, rule: new EchoSlots(n), slots: [] }));

  const parseAll = () => {
    const frames = parseFramesSoft(llrs, lensTag).filter(f => f.tagOk);
    for (const e of echoes) {
      const r = parseEcho(llrs, e.slots, e.n, lensTag);
      if (r.valid && r.tagOk) frames.push({ offset: -1, payload: r.payload, profile: "echo", tag: r.tag, tagOk: true, syncErrors: 0, combined: 1, echo: { n: e.n, votes: r.votes, minVotes: r.minVotes, covered: r.covered, slots: e.slots.slice() } });
    }
    return frames;
  };

  const finalize = () => {
    const frames = parseAll();
    const spans = frames.flatMap(frameSpans);
    const best = frames[0];
    onEvent({
      type: "done",
      valid: frames.length > 0,
      payload: best ? bytesToHex(best.payload) : null,
      combined: best ? (best.combined ?? 1) : null,
      echo: best?.echo ?? null,
      llrs: Array.from(llrs),   // the bit confidences, for offline study of the parser
      spans,
      carriers: llrs.length,
      frames: frames.length,
      fingerprint: lens.fp,
      lens: lens.name,
    });
    return frames;
  };

  const decide = logits => {
    const tid = targets[t++];
    const prev = allIds.slice(Math.max(0, t - ECHO.k), t);   // the k ids before this token
    const slotsNow = echoes.map(e => e.rule.next(prev));
    const entropy = entropyOf(logits);
    const rank = rankOf(logits, tid);
    if (entropy >= tau) {
      const bit = rank % 2;
      llrs.push(llrOf(rank, entropy, tau));
      echoes.forEach((e, i) => e.slots.push(slotsNow[i]));
      onEvent({ type: "token", id: tid, carrier: true, bit, piece: lens.decodeOne(tid), rank });
      // cheap: repaint the forming frame every carrier; full parse periodically
      onEvent({ type: "partial", spans: partialSpans(llrs) });
      if (++sinceParse >= 6) {
        sinceParse = 0;
        const frames = parseAll();
        if (frames.length > reportedFrames) {
          reportedFrames = frames.length;
          const last = frames[frames.length - 1];
          onEvent({
            type: "frame", combined: last.combined ?? 1, echo: last.echo ?? null,
            spans: frames.flatMap(frameSpans),
            payload: bytesToHex(last.payload),
          });
        }
      }
    } else {
      onEvent({ type: "token", id: tid, carrier: false, piece: lens.decodeOne(tid), rank });
    }
    return tid; // force the real next token
  };

  await lens.run(seed, targets.length, decide);
  const frames = finalize();
  return {
    valid: frames.length > 0,
    llrs: Array.from(llrs),
    payload: frames[0] ? bytesToHex(frames[0].payload) : null,
    combined: frames[0] ? (frames[0].combined ?? 1) : null,
    echo: frames[0]?.echo ?? null,
    carriers: llrs.length,
    frames: frames.length,
    fingerprint: lens.fp,
    lens: lens.name,
  };
}
