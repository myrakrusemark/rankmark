// The v2 self-clocking frame: [ SYNC | HEADER | ECC(PAYLOAD || CRC) ] repeated.
// Port of framing.py. build/parse must be bit-exact with the Python side.

import {
  bitsToBytes, bitsToInt, bytesToBits, concatBytes, crc16, crc32, intToBits,
} from "./bits.js";
import {
  bitsToLlrs, convEncode, CONV_TAIL, deinterleave, HARD_LLR, interleave,
  llrsToBits, repDecodeSoft, repEncode, rsDecode, rsEncode, viterbiDecode,
} from "./ecc.js";

const MAGIC = 0xb65d;

const BARKER_13 = [1, 1, 1, 1, 1, 0, 0, 1, 1, 0, 1, 0, 1];
const MSEQ_31 = [1, 0, 0, 0, 0, 1, 0, 1, 0, 1, 1, 1, 0, 1, 1,
                 0, 0, 0, 1, 1, 1, 1, 1, 0, 0, 1, 1, 0, 1, 0, 0];

const LEN_BITS = 6;
const TAG_BITS = 3;
const HEADER_BITS = LEN_BITS + TAG_BITS;

// profile id -> geometry (mirrors PROFILES in framing.py)
export const PROFILES = {
  0: { name: "lean",     sync: BARKER_13, syncTol: 1, headerRep: 2, crcBytes: 2, rsNsym: 2, conv: false, depth: 1 },
  1: { name: "standard", sync: MSEQ_31,   syncTol: 3, headerRep: 3, crcBytes: 4, rsNsym: 4, conv: true,  depth: 4 },
  2: { name: "robust",   sync: MSEQ_31,   syncTol: 5, headerRep: 5, crcBytes: 6, rsNsym: 8, conv: true,  depth: 8 },
};
export const DEFAULT_PROFILE = 1;

export function tagOf(modelName) {
  return crc16(new TextEncoder().encode(modelName)) & ((1 << TAG_BITS) - 1);
}

function checksum(payload, crcBytes) {
  if (crcBytes === 2) return Uint8Array.of((crc16(payload) >> 8) & 0xff, crc16(payload) & 0xff);
  const c = crc32(payload);
  const crc = Uint8Array.of((c >>> 24) & 0xff, (c >>> 16) & 0xff, (c >>> 8) & 0xff, c & 0xff);
  return crcBytes === 4 ? crc : concatBytes(Uint8Array.of((MAGIC >> 8) & 0xff, MAGIC & 0xff), crc);
}

function bodyCodedBits(payloadLen, p) {
  const nbits = 8 * (payloadLen + p.crcBytes + p.rsNsym);
  return p.conv ? 2 * (nbits + CONV_TAIL) : nbits;
}

export function frameLenBits(payloadLen, profileId) {
  const p = PROFILES[profileId];
  return p.sync.length + HEADER_BITS * p.headerRep + bodyCodedBits(payloadLen, p);
}

export function buildFrame(payload, profileId, tag) {
  const p = PROFILES[profileId];
  if (!(payload.length >= 1 && payload.length <= (1 << LEN_BITS) - 1))
    throw new Error(`payload must be 1..${(1 << LEN_BITS) - 1} bytes`);

  const coded = rsEncode(concatBytes(payload, checksum(payload, p.crcBytes)), p.rsNsym);
  const body = interleave(coded, p.depth);
  let bodyBits = bytesToBits(body);
  if (p.conv) bodyBits = convEncode(bodyBits);

  const header = [...intToBits(payload.length, LEN_BITS), ...intToBits(tag, TAG_BITS)];
  return [...p.sync, ...repEncode(header, p.headerRep), ...bodyBits];
}

function decodeBody(llrs, payloadLen, p) {
  const nbits = 8 * (payloadLen + p.crcBytes + p.rsNsym);
  const bits = p.conv ? viterbiDecode(llrs, nbits) : llrsToBits(llrs);
  if (bits === null) return null;
  const decoded = rsDecode(deinterleave(bitsToBytes(bits), p.depth), p.rsNsym);
  if (decoded === null) return null;
  const payload = decoded.slice(0, payloadLen);
  const gotCrc = decoded.slice(payloadLen);
  const wantCrc = checksum(payload, p.crcBytes);
  if (gotCrc.length !== wantCrc.length) return null;
  for (let i = 0; i < wantCrc.length; i++) if (gotCrc[i] !== wantCrc[i]) return null;
  return payload;
}

// Scan every offset under every profile; return checksum-valid frames.
export function parseFramesSoft(llrs, lensTag = null) {
  const hard = llrsToBits(llrs);
  const frames = [];
  for (const p of Object.values(PROFILES)) {
    const syncLen = p.sync.length;
    const hdrLen = HEADER_BITS * p.headerRep;
    for (let off = 0; off <= llrs.length - syncLen - hdrLen; off++) {
      let errs = 0;
      for (let i = 0; i < syncLen; i++) if (hard[off + i] !== p.sync[i]) errs++;
      if (errs > p.syncTol) continue;
      const hdrSoft = repDecodeSoft(llrs.slice(off + syncLen, off + syncLen + hdrLen), p.headerRep);
      const hdr = llrsToBits(hdrSoft);
      const payloadLen = bitsToInt(hdr.slice(0, LEN_BITS));
      const tag = bitsToInt(hdr.slice(LEN_BITS));
      if (payloadLen === 0) continue;
      const start = off + syncLen + hdrLen;
      const end = start + bodyCodedBits(payloadLen, p);
      if (end > llrs.length) continue;
      const payload = decodeBody(llrs.slice(start, end), payloadLen, p);
      if (payload === null) continue;
      frames.push({
        offset: off, payload, profile: p.name, tag,
        tagOk: lensTag === null || tag === lensTag, syncErrors: errs,
      });
    }
  }
  return frames;
}

export const parseFramesHard = (bits, lensTag = null) => parseFramesSoft(bitsToLlrs(bits), lensTag);

function frameLayout(payloadLen, p) {
  const parts = [["sync", p.sync.length], ["header", HEADER_BITS * p.headerRep]];
  if (p.conv || p.depth > 1) {
    parts.push(["woven", bodyCodedBits(payloadLen, p)]);
  } else {
    parts.push(["payload", 8 * payloadLen], ["checksum", 8 * p.crcBytes], ["parity", 8 * p.rsNsym]);
  }
  return parts;
}

// the segments of a frame about to be written, from bit 0: what the strip draws
export function layoutOf(payloadLen, profileId) {
  const layout = frameLayout(payloadLen, PROFILES[profileId]);
  const total = layout.reduce((s, [, n]) => s + n, 0);
  return spansFrom(layout, 0, total);
}

function spansFrom(layout, offset, limit) {
  const spans = [];
  let cur = offset;
  for (const [kind, n] of layout) {
    if (cur >= limit) break;
    spans.push({ kind, start: cur, len: Math.min(n, limit - cur) });
    cur += n;
  }
  return spans;
}

export function frameSpans(frame) {
  const p = Object.values(PROFILES).find(q => q.name === frame.profile);
  const layout = frameLayout(frame.payload.length, p);
  const total = layout.reduce((s, [, n]) => s + n, 0);
  return spansFrom(layout, frame.offset, frame.offset + total);
}

// Tentative labelling of the frame currently arriving at the tail (exact sync
// only). Display-only — parseFramesSoft stays the source of truth.
export function partialSpans(llrs) {
  const hard = llrsToBits(llrs);
  const n = hard.length;
  let best = null;
  for (const p of Object.values(PROFILES)) {
    const syncLen = p.sync.length;
    for (let off = n - syncLen; off >= 0; off--) {
      let match = true;
      for (let i = 0; i < syncLen; i++) if (hard[off + i] !== p.sync[i]) { match = false; break; }
      if (match) { if (best === null || off > best.off) best = { off, p }; break; }
    }
  }
  if (best === null) return [];
  const { off, p } = best;
  const hdrLen = HEADER_BITS * p.headerRep;
  const hdrStart = off + p.sync.length;
  if (hdrStart + hdrLen > n)
    return spansFrom([["sync", p.sync.length], ["header", hdrLen]], off, n);
  const hdr = llrsToBits(repDecodeSoft(llrs.slice(hdrStart, hdrStart + hdrLen), p.headerRep));
  const payloadLen = bitsToInt(hdr.slice(0, LEN_BITS));
  if (!(payloadLen >= 1 && payloadLen <= (1 << LEN_BITS) - 1))
    return spansFrom([["sync", p.sync.length], ["header", hdrLen]], off, n);
  return spansFrom(frameLayout(payloadLen, p), off, n);
}

export function llrOf(rank, entropy, tau) {
  let conf = rank <= 1 ? HARD_LLR : rank < 10 ? 1.0 : 0.3;
  conf *= Math.max(0.25, Math.min(1.0, Math.abs(entropy - tau)));
  return rank % 2 === 0 ? conf : -conf;
}

export { HEADER_BITS, LEN_BITS, TAG_BITS };
