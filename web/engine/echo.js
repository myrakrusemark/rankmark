// The echo: a message pressed into the text with no frame around it. The
// packet is the model tag, the coded message and a checksum; every carrier
// word votes for one packet bit, chosen by the words just before it, so any
// surviving stretch of text still counts and nothing has to be found first.
// Slots come in runs: a hash of the previous k token ids either opens a new
// run at the slot it names (about one word in eight) or continues the run one
// slot on. Runs keep the coverage even; anchors put writer and reader back in
// step after an edit. Mirrors echo.py; the two must stay bit-exact.

import { bitsToBytes, bytesToBits, crc16, intToBits, bitsToInt } from "./bits.js";

export const ECHO = { tagBits: 3, crcBytes: 2, k: 4, anchorEvery: 8, maxBytes: 8 };

export function echoLen(payloadLen) { return ECHO.tagBits + 8 * (payloadLen + ECHO.crcBytes); }

// the packet bits: tag, message bytes, checksum
export function buildEcho(payload, tag) {
  if (!(payload.length >= 1 && payload.length <= ECHO.maxBytes)) throw new Error(`echo payload must be 1..${ECHO.maxBytes} bytes`);
  const c = crc16(payload);
  return [...intToBits(tag, ECHO.tagBits), ...bytesToBits(payload), ...bytesToBits(Uint8Array.of((c >> 8) & 0xff, c & 0xff))];
}

// FNV-1a over token ids, 32-bit, the same arithmetic in both languages
export function echoHash(ids) {
  let h = 2166136261;
  for (const id of ids) h = Math.imul(h ^ (id >>> 0), 16777619) >>> 0;
  return h;
}

// the slot rule, one state per bit stream and packet length. It advances only
// at carriers, so a run of slots is a run of votes: peek() says which slot a
// word would vote on, and commit() takes the step once the word turns out to
// carry. Runs then tile the packet instead of scattering over it.
export class EchoSlots {
  constructor(n) { this.n = n; this.start = null; this.offset = 0; }
  peek(prevIds) {
    const h = echoHash(prevIds);
    const anchor = this.start === null || ((h >>> 8) % ECHO.anchorEvery) === 0;
    const start = anchor ? (h >>> 11) % this.n : this.start;
    const offset = anchor ? 0 : this.offset + 1;
    return { slot: (start + offset) % this.n, start, offset };
  }
  commit(step) { this.start = step.start; this.offset = step.offset; return step.slot; }
  next(prevIds) { return this.commit(this.peek(prevIds)); }
}

// tally the votes: the summed confidence per slot decides each bit; the tag
// and the checksum say whether the packet is real
export function parseEcho(llrs, slots, n, lensTag = null) {
  const sum = new Array(n).fill(0), votes = new Array(n).fill(0);
  for (let i = 0; i < llrs.length; i++) { const j = slots[i]; if (j === null || j === undefined) continue; sum[j] += llrs[i]; votes[j]++; }
  const bits = sum.map(x => (x < 0 ? 1 : 0));
  const tag = bitsToInt(bits.slice(0, ECHO.tagBits));
  const body = bitsToBytes(bits.slice(ECHO.tagBits));
  const payloadLen = body.length - ECHO.crcBytes;
  const payload = body.slice(0, payloadLen), got = body.slice(payloadLen);
  const c = crc16(payload);
  const valid = payloadLen >= 1 && got[0] === ((c >> 8) & 0xff) && got[1] === (c & 0xff);
  return {
    valid, payload: valid ? payload : null, tag, tagOk: lensTag === null || tag === lensTag,
    votes, minVotes: votes.length ? Math.min(...votes) : 0, covered: votes.filter(v => v > 0).length, bits,
  };
}

// the packet lengths a reader tries: one per message length it might carry
export function echoLengths() { return Array.from({ length: ECHO.maxBytes }, (_, i) => echoLen(i + 1)); }

// what the strip draws: the packet in bit order
export function echoLayout(payloadLen) {
  return [
    { kind: "header", start: 0, len: ECHO.tagBits },
    { kind: "payload", start: ECHO.tagBits, len: 8 * payloadLen },
    { kind: "checksum", start: ECHO.tagBits + 8 * payloadLen, len: 8 * ECHO.crcBytes },
  ];
}
