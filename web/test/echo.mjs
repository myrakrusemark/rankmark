// The echo: packet, slot rule, tally. Same cases as tests/test_echo.py.
import { buildEcho, echoLen, echoHash, EchoSlots, parseEcho, echoLengths } from "../engine/echo.js";
import { bitsToLlrs } from "../engine/ecc.js";
import { tagOf } from "../engine/framing.js";
import { encodeMessage } from "../engine/textcode.js";

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) pass++; else { fail++; console.log("FAIL", m); } };

const payload = encodeMessage("hello");
const tag = tagOf("Qwen3-1.7B-Q8_0");
const packet = buildEcho(payload, tag);
const n = echoLen(payload.length);
ok(packet.length === n && n === 3 + 32 + 16, `packet is ${n} bits for hello`);
ok(echoHash([1, 2, 3, 4]) === echoHash([1, 2, 3, 4]) && echoHash([1, 2, 3, 4]) !== echoHash([1, 2, 3, 5]), "hash is a function of the ids");
ok(echoHash([]) === 2166136261, "empty hash is the FNV offset");

// a synthetic stream of ids: slots follow runs and restart at anchors
const ids = Array.from({ length: 600 }, (_, i) => ((i * 7919 + 13) % 1000) + 1);
const carrierAt = i => ids[i] % 5 !== 0;   // whether a position carries depends on its token, as entropy does
const slots = [], stream = [];
const rule = new EchoSlots(n);
for (let i = 4; i < ids.length; i++) if (carrierAt(i)) { const j = rule.next(ids.slice(i - 4, i)); slots.push(j); stream.push(packet[j]); }
const runs = slots.filter((j, i) => i && j !== (slots[i - 1] + 1) % n).length;
ok(runs > 5 && runs < slots.length / 3, `slots come in runs (${runs} restarts in ${slots.length} votes)`);
const clean = parseEcho(bitsToLlrs(stream), slots, n, tag);
ok(clean.valid && clean.tagOk && [...clean.payload].join(",") === [...payload].join(","), `clean votes decode the payload (valid ${clean.valid}, covered ${clean.covered}/${n}, min votes ${clean.minVotes})`);
ok(clean.minVotes >= 2, `every slot has at least two votes in ${slots.length} (min ${clean.minVotes})`);

// flip a tenth of the votes at scattered positions: majorities hold
const damaged = stream.map((b, i) => ((i * 101) % 10 === 0 ? 1 - b : b));
const d = parseEcho(bitsToLlrs(damaged), slots, n, tag);
ok(d.valid && [...d.payload].join(",") === [...payload].join(","), `a tenth of the votes flipped still decodes (valid ${d.valid}, min votes ${clean.minVotes})`);

// a wrong length never validates by accident here
const other = parseEcho(bitsToLlrs(stream), slots.map(j => j % echoLen(3)), echoLen(3), tag);
ok(!other.valid, "the wrong packet length fails its checksum");
ok(echoLengths().length === 8 && echoLengths()[0] === 27, "eight lengths to try, from 27 bits");

// the reader re-syncs after an edit: slots from an anchor on agree with the writer's
const shifted = ids.slice(0, 200).concat([4242], ids.slice(200));   // one token inserted
const rule2 = new EchoSlots(n); const slots2 = [];
for (let i = 4; i < shifted.length; i++) if (shifted[i] % 5 !== 0) slots2.push({ i, j: rule2.next(shifted.slice(i - 4, i)) });
const before = slots2.filter(s => s.i < 200).map(s => s.j);
ok(before.every((j, i) => j === slots[i]), "slots before the edit are unchanged");
const tail = slots2.slice(-50).map(s => s.j), tailW = slots.slice(-50);
ok(tail.every((j, i) => j === tailW[i]), `the last fifty slots agree again after the edit (${tail.filter((j, i) => j === tailW[i]).length} of 50)`);

console.log(`${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
