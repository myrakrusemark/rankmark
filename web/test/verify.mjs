// Assert the JS engine reproduces the Python reference vectors bit-for-bit.
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

import { crc16, crc32, bytesToBits } from "../engine/bits.js";
import {
  convEncode, deinterleave, interleave, rsDecode, rsEncode, viterbiDecode, bitsToLlrs,
} from "../engine/ecc.js";
import {
  buildFrame, frameLenBits, parseFramesSoft, tagOf,
} from "../engine/framing.js";

const here = dirname(fileURLToPath(import.meta.url));
const V = JSON.parse(readFileSync(join(here, "vectors.json"), "utf8"));

let pass = 0, fail = 0;
const eq = (a, b) => JSON.stringify(a) === JSON.stringify(b);
function check(name, got, want) {
  if (eq(got, want)) { pass++; }
  else {
    fail++;
    console.error(`FAIL ${name}\n  got : ${JSON.stringify(got)}\n  want: ${JSON.stringify(want)}`);
  }
}

// crc + tag
for (const c of V.crc) {
  const d = Uint8Array.from(c.data);
  check(`crc16(${c.data})`, crc16(d), c.crc16);
  check(`crc32(${c.data})`, crc32(d), c.crc32);
}
for (const [name, tag] of Object.entries(V.tag)) check(`tagOf(${name})`, tagOf(name), tag);

// RS
for (const r of V.rs) {
  check(`rsEncode nsym=${r.nsym}`, [...rsEncode(Uint8Array.from(r.data), r.nsym)], r.encoded);
  const dec = rsDecode(Uint8Array.from(r.corrupted), r.nsym);
  check(`rsDecode nsym=${r.nsym} nerr=${r.nerr}`, dec === null ? null : [...dec], r.decoded);
}

// interleave
for (const it of V.interleave) {
  check(`interleave depth=${it.depth}`, [...interleave(Uint8Array.from(it.data), it.depth)], it.interleaved);
  check(`deinterleave depth=${it.depth}`,
    [...deinterleave(interleave(Uint8Array.from(it.data), it.depth), it.depth)], it.roundtrip);
}

// conv + viterbi
for (const c of V.conv) {
  check("convEncode", convEncode(c.bits), c.coded);
  check("viterbiDecode", viterbiDecode(bitsToLlrs(c.coded), c.bits.length), c.decoded);
}

// full frames
for (const f of V.frame) {
  const built = buildFrame(Uint8Array.from(f.payload), f.profile, f.tag);
  check(`buildFrame p${f.profile} len${f.payload.length}`, built, f.frame);
  check(`frameLenBits p${f.profile}`, frameLenBits(f.payload.length, f.profile), f.frame_len_bits);
  const parsed = parseFramesSoft(bitsToLlrs(built), f.tag)
    .map(fr => ({ offset: fr.offset, payload: [...fr.payload], profile: fr.profile, tag: fr.tag }));
  check(`parse p${f.profile} len${f.payload.length}`, parsed, f.parsed);
}

// repeated stream + wrong-tag rejection
const rp = parseFramesSoft(V.repeat.stream, V.repeat.tag).map(f => ({ offset: f.offset, payload: [...f.payload] }));
check("repeat parse right tag", rp, V.repeat.parsed_right);
const wrong = parseFramesSoft(V.repeat.stream, (V.repeat.tag + 1) & 7).map(f => ({ offset: f.offset }));
check("repeat parse wrong tag", wrong, V.repeat.parsed_wrong_tag);

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
