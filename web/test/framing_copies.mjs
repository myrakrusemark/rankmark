// The copies profile: a short frame repeated, and a reader that sums the
// confidence of each bit across copies when no copy stands on its own.
import { buildFrame, parseFramesSoft, PROFILES, tagOf, layoutOf } from "../engine/framing.js";
import { bitsToLlrs } from "../engine/ecc.js";

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) pass++; else { fail++; console.log("FAIL", m); } };

const payload = new TextEncoder().encode("hello");
const tag = tagOf("Qwen3-1.7B-Q8_0");
const frame = buildFrame(payload, 3, tag);
ok(frame.length === 13 + 18 + 40 + 16, `copies frame is 87 bits for hello (got ${frame.length})`);
ok(layoutOf(5, 3).map(s => s.kind).join(",") === "sync,header,payload,checksum", "layout has no repair section");
ok(PROFILES[3].sync.every((b, i) => b !== PROFILES[0].sync[i]), "the copies knock is the lean knock inverted");

// three clean copies: each validates alone, none needs combining
const three = [...frame, ...frame, ...frame];
let frames = parseFramesSoft(bitsToLlrs(three), tag);
ok(frames.filter(f => f.profile === "copies").length === 3, `three clean copies parse as three frames (got ${frames.length})`);
ok(frames.every(f => f.combined === 1), "clean copies stand alone");

// a lean frame is not also a copies frame
const lean = buildFrame(payload, 0, tag);
frames = parseFramesSoft(bitsToLlrs([...lean, ...lean]), tag);
ok(frames.every(f => f.profile === "lean"), "a lean frame does not answer to the copies knock");

// damage: two body bits flipped in each copy, at different places; alone each
// copy fails its checksum, together the sum decodes
const damaged = [...three];
const body0 = 13 + 18;
const flips = [[3, 20], [30, 44], [9, 51]];
flips.forEach((pair, c) => { for (const b of pair) { const i = c * frame.length + body0 + b; damaged[i] = 1 - damaged[i]; } });
frames = parseFramesSoft(bitsToLlrs(damaged), tag);
const combined = frames.find(f => f.profile === "copies" && f.combined > 1);
ok(combined, "three damaged copies combine into a frame");
ok(combined && new TextDecoder().decode(combined.payload) === "hello", `the combined payload reads hello (got ${combined && new TextDecoder().decode(combined.payload)})`);
ok(!frames.some(f => f.profile === "copies" && f.combined === 1), "no damaged copy validates alone");

// one false knock among the copies: leaving it out still decodes
const withNoise = [...damaged];
const noiseAt = 3 * frame.length + 5;
for (let i = 0; i < 40; i++) withNoise.push((i * 7) % 3 === 0 ? 1 : 0);
PROFILES[3].sync.forEach((b, i) => { withNoise[noiseAt + i] = b; });
frames = parseFramesSoft(bitsToLlrs(withNoise), tag);
ok(frames.some(f => f.profile === "copies" && f.combined >= 2 && new TextDecoder().decode(f.payload) === "hello"), "a stray knock does not spoil the combination");

console.log(`${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
