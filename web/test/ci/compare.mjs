// Diff the determinism records from every OS/browser. Bit-exact means the
// logit hash, the text, the carrier bits and the ranks all agree.
//
//   node compare.mjs <dir with *.json>

import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

const dir = process.argv[2] || "ci-out";
const files = readdirSync(dir).filter(f => f.endsWith(".json")).sort();
const records = files.map(f => ({ file: f, ...JSON.parse(readFileSync(join(dir, f), "utf8")) }));

const key = r => r.ok ? `${r.logitHash.hash}|${r.write.textHash}|${r.write.bits}|${r.write.ranks}` : "FAILED";
const groups = new Map();
for (const r of records) {
  const k = key(r);
  if (!groups.has(k)) groups.set(k, []);
  groups.get(k).push(r);
}

console.log(`${records.length} records, ${groups.size} distinct outcome(s)\n`);
for (const r of records) {
  const tag = r.ok ? `hash ${r.logitHash.hash} (1 thread ${r.logitHash1?.hash})  weights ${r.weights?.ok === true ? "ok" : r.weights?.ok === null ? "unhashed" : "BAD"}  text ${r.write.textHash}  ${r.write.carriers}/${r.write.tokens} carriers  read ${r.read.valid ? "valid " + r.read.payload : "NO FRAME"}` : `FAILED: ${(r.error || "").split("\n")[0]}`;
  console.log(`${r.file.padEnd(34)} threads ${String(r.env?.threads ?? "?").padStart(2)}  mem64 ${r.env?.memory64 ? "y" : "n"} jspi ${r.env?.jspi ? "y" : "n"} iso ${r.env?.isolated ? "y" : "n"}  ${tag}`);
}

const okGroups = [...groups.keys()].filter(k => k !== "FAILED");
if (okGroups.length > 1) {
  console.log("\nNOT bit-exact across the matrix:");
  for (const k of okGroups) console.log(" ", groups.get(k).map(r => r.file).join(", "));
  process.exit(1);
}
if (groups.has("FAILED")) {
  console.log("\nsome runs failed; the rest agree");
  process.exit(2);
}
console.log("\nbit-exact across the whole matrix");
