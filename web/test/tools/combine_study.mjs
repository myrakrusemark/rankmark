// Offline study of the parser on LLRs dumped by web/test/ci/edits.mjs
// (DUMP=path): for each edit variant, what the parser finds as shipped, and
// what it would find with a looser knock or lengths taken by majority. No
// model runs: the bits are already on disk.
//
//   node web/test/tools/combine_study.mjs dump-p3-c3.json

import { readFileSync } from "node:fs";
import { PROFILES, parseFramesSoft, tagOf } from "../../engine/framing.js";
import { llrsToBits, repDecodeSoft } from "../../engine/ecc.js";
import { bitsToInt } from "../../engine/bits.js";

const dump = JSON.parse(readFileSync(process.argv[2], "utf8"));
const p = PROFILES[dump.profile];
const tag = tagOf(dump.rung);
const text = s => new TextDecoder().decode(s);

// every knock match under a given tolerance, with the header each one reads
function candidates(llrs, tol) {
  const hard = llrsToBits(llrs);
  const out = [];
  const syncLen = p.sync.length, hdrLen = 9 * p.headerRep;
  for (let off = 0; off <= llrs.length - syncLen - hdrLen; off++) {
    let errs = 0;
    for (let i = 0; i < syncLen; i++) if (hard[off + i] !== p.sync[i]) errs++;
    if (errs > tol) continue;
    const hdr = llrsToBits(repDecodeSoft(llrs.slice(off + syncLen, off + syncLen + hdrLen), p.headerRep));
    out.push({ off, errs, len: bitsToInt(hdr.slice(0, 6)), tag: bitsToInt(hdr.slice(6)) });
  }
  return out;
}

console.log(`${dump.rung}, profile ${dump.profile}, ${dump.copies} copies${dump.window ? `, window ${dump.window}` : ""}: ${dump.written.length} tokens`);
for (const [name, r] of Object.entries(dump.results)) {
  const frames = parseFramesSoft(r.llrs, tag).filter(f => f.tagOk);
  const shipped = frames.length ? `${frames.map(f => `${text(f.payload)}@${f.offset}${f.combined > 1 ? "x" + f.combined : ""}`).join(" ")}` : "none";
  const c1 = candidates(r.llrs, 1), c2 = candidates(r.llrs, 2), c3 = candidates(r.llrs, 3);
  const show = cs => cs.map(c => `@${c.off}(${c.errs}e,len ${c.len},tag ${c.tag})`).join(" ");
  console.log(`\n${name}: ${r.llrs.length} bits, shipped parser: ${shipped}`);
  console.log(`  knocks tol1: ${show(c1) || "none"}`);
  if (c2.length !== c1.length) console.log(`  knocks tol2: ${show(c2)}`);
  if (c3.length !== c2.length) console.log(`  knocks tol3: ${show(c3)}`);
  // the true copy starts, from the writer's bits: every frameBits-th carrier
  const frameBits = p.sync.length + 9 * p.headerRep + 8 * (5 + p.crcBytes + p.rsNsym);
  const starts = []; for (let k = 0; k * frameBits < dump.written.filter(t => t.carrier).length; k++) starts.push(k * frameBits);
  console.log(`  copies as written start at planted bits ${starts.join(", ")} (${frameBits} bits each)`);
}
