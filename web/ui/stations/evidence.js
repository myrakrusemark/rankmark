import { agreement } from "../../engine/compare.js";
import { FrameStrip } from "../frame-strip.js";
import { messageBits, decodePrefix, encodeMessage } from "../../engine/textcode.js";
import { layoutOf, frameLenBits } from "../../engine/framing.js";

const toInt = bits => bits.reduce((a, b) => a * 2 + b, 0);
const shortName = id => (id || "").replace(/-Q.*$/, "");
const esc = s => String(s).replace(/[&<>]/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;" }[c])).replace(/"/g, "&quot;");
const fly = FrameStrip.prototype.fly;

// the planted packet as the reader sees it coming back: a bit and a status per
// packet position. Framed: position k is the writer's k-th carrier. Echo: the
// position is the slot, and every writer carrier that voted on it counts.
function packetView(a, frame, reference, frontier) {
  const carriers = reference.filter(t => t.carrier);
  const n = frame.frameBits;
  const pbits = new Array(n).fill(0), status = new Array(n).fill("pending"), slotOf = new Array(carriers.length).fill(null);
  if (frame.echo) {
    const oks = new Array(n).fill(0), flips = new Array(n).fill(0), reached = new Array(n).fill(false), seen = new Array(n).fill(false);
    carriers.forEach((c, k) => {
      const j = c.slot; if (j === undefined || j === null) return;
      slotOf[k] = j; pbits[j] = c.bit; seen[j] = true;
      const st = a.perPlanted[k]?.status;
      if (st === "ok") oks[j]++; else if (st === "flip") flips[j]++;
      if (k <= frontier) reached[j] = true;
    });
    for (let j = 0; j < n; j++) {
      status[j] = !seen[j] ? "lost" : oks[j] > 0 && oks[j] >= flips[j] ? "ok" : flips[j] > 0 ? "flip" : reached[j] ? "lost" : "pending";
    }
  } else {
    carriers.slice(0, n).forEach((c, k) => {
      slotOf[k] = k; pbits[k] = c.bit;
      const st = a.perPlanted[k]?.status ?? "lost";
      status[k] = st === "lost" && k > frontier ? "pending" : st;
    });
  }
  return { n, pbits, status, slotOf, carriers };
}

// Compare an edited run with a known original; this is not authorship inference.
export function attachEvidence(readPanel, meterEl) {
  readPanel.reference = null;       // [{id, carrier, bit, slot}] from the write station
  readPanel.frame = null;           // { layout, frameBits, message, rung, echo }
  readPanel.readTokens = [];
  const lineup = document.createElement("div");
  lineup.className = "lineup strip";
  lineup.hidden = true;
  meterEl.parentElement.insertBefore(lineup, meterEl);
  let cells = [];

  // the planted packet as a line of hollow cells, one per bit, colored by section
  const buildLineup = () => {
    const f = readPanel.frame;
    if (!f?.layout || !readPanel.reference) { ghostLineup(); return; }
    lineup.classList.remove("ghost");
    lineup.innerHTML = `<div class="lineup-head"><span>what was planted, lined up with what comes back</span><span data-lineup-count>${f.frameBits} bits</span></div><div class="row"></div>
      <div class="legend"><span><i style="background: var(--seg-payload)"></i>agrees</span><span><i style="background: var(--warn)"></i>flipped</span><span><i style="box-shadow: inset 0 0 0 1.5px var(--line-strong)"></i>lost</span></div>`;
    const row = lineup.querySelector(".row");
    cells = [];
    for (const s of f.layout) for (let i = 0; i < s.len; i++) {
      const c = document.createElement("i");
      c.className = "bit";
      c.dataset.kind = s.kind;
      row.appendChild(c);
      cells.push(c);
    }
    lineup.hidden = false;
  };
  // before anything is planted: the default frame's shape (the message as typed
  // in the write station, the copies profile), hollow
  const ghostLineup = () => {
    const text = document.querySelector("#st-tag")?.value.trim() || "hello";
    const n = Math.max(1, encodeMessage(text).length);
    const layout = layoutOf(n, 3), bits = frameLenBits(n, 3);
    lineup.classList.add("ghost");
    lineup.innerHTML = `<div class="lineup-head"><span>what was planted, lined up with what comes back</span><span data-lineup-count>${bits} bits</span></div><div class="row"></div>`;
    const row = lineup.querySelector(".row");
    cells = [];
    for (const s of layout) for (let i = 0; i < s.len; i++) { const c = document.createElement("i"); c.className = "bit"; c.dataset.kind = s.kind; row.appendChild(c); }
    lineup.hidden = false;
  };
  ghostLineup();
  document.querySelector("#st-tag")?.addEventListener("input", () => { if (lineup.classList.contains("ghost")) ghostLineup(); });
  const origLoad = readPanel.load.bind(readPanel);
  readPanel.load = card => { origLoad(card); queueMicrotask(buildLineup); };

  let frontier = -1;   // the furthest writer carrier the alignment has reached
  const settle = a => {
    const f = readPanel.frame;
    const v = packetView(a, f, readPanel.reference, frontier);
    for (let k = 0; k < cells.length; k++) {
      cells[k].classList.toggle("ok", v.status[k] === "ok");
      cells[k].classList.toggle("flip", v.status[k] === "flip");
      cells[k].classList.toggle("lost", v.status[k] === "lost");
    }
    const agree = v.status.filter(s => s === "ok").length, flipped = v.status.filter(s => s === "flip").length, lost = v.status.filter(s => s === "lost").length;
    lineup.querySelector("[data-lineup-count]").textContent = `${agree} of ${f.frameBits} agree · ${flipped} flipped · ${lost} lost`;
    return v;
  };

  const origAppend = readPanel.view.append.bind(readPanel.view);
  readPanel.view.append = (e, o) => {
    const el = origAppend(e, o);
    if (e.seed) return el;
    readPanel.readTokens.push({ id: e.id, carrier: !!e.carrier, bit: e.bit ?? null, el });
    if (!e.carrier || !readPanel.reference || !cells.length) return el;
    // line this bit up with the planted packet and send it there
    const a = agreement(readPanel.reference, readPanel.readTokens);
    const j = readPanel.readTokens.length - 1;
    const k = a.readToPlanted[j];
    const v = packetView(a, readPanel.frame, readPanel.reference, frontier);
    const target = k !== null ? v.slotOf[k] : null;
    if (k !== null) frontier = Math.max(frontier, k);
    if (target !== null && target !== undefined && target < cells.length) {
      const ok = a.perPlanted[k].status === "ok";
      el.classList.add(ok ? "ev-ok" : "ev-flip");
      fly(el, cells[target], e.bit, ok ? cells[target].dataset.kind : "", () => settle(a));
    } else {
      settle(a);
    }
    meterEl.innerHTML = report(a, null, readPanel.frame, readPanel.reference, frontier);
    meterEl.hidden = false;
    return el;
  };

  const origRun = readPanel.run.bind(readPanel);
  readPanel.run = async opts => {
    readPanel.readTokens = [];
    frontier = -1;
    buildLineup();
    meterEl.hidden = true;
    const res = await origRun(opts);
    if (!res || !readPanel.reference) return res;
    const a = agreement(readPanel.reference, readPanel.readTokens);
    frontier = Infinity;
    a.perToken.forEach((mark, j) => { const t = readPanel.readTokens[j]; if (t && mark) t.el.classList.add(`ev-${mark}`); });
    settle(a);
    meterEl.innerHTML = report(a, res, readPanel.frame, readPanel.reference, Infinity);
    meterEl.hidden = false;
    return res;
  };
}

// the panel: model and reasons, length, letters, and the packet's parts. While
// the read is still going, bits beyond the alignment's reach are pending
// rather than lost.
export function report(a, res, frame, reference, frontier) {
  const name = shortName(frame?.rung);
  const pct = a.agreementPct ?? 0;
  if (!frame?.layout) {
    return `<div class="ev-row"><span>surviving bits that agree with what ${esc(name)} planted</span><b>${a.survived ? pct + "%" : "n/a"}</b><small>among aligned surviving carrier tokens</small></div>`;
  }
  const v = packetView(a, frame, reference, frontier);
  const status = k => v.status[k] ?? "lost";
  const sec = kind => frame.layout.find(s => s.kind === kind);
  const tally = s => {
    const sts = []; for (let k = s.start; k < s.start + s.len; k++) sts.push(status(k));
    const ok = sts.filter(x => x === "ok").length, flip = sts.filter(x => x === "flip").length, lost = sts.filter(x => x === "lost").length, pending = sts.filter(x => x === "pending").length;
    const readBits = sts.map((x, i) => (x === "ok" ? v.pbits[s.start + i] : x === "flip" ? 1 - v.pbits[s.start + i] : null));
    return { ok, flip, lost, pending, len: s.len, readBits, sts };
  };
  const out = [];

  const why = [];
  if (res?.card?.rungId) why.push(res.card.rungId === frame.rung ? "the footer line names it" : `the footer line names ${esc(shortName(res.card.rungId))}`);
  const header = sec("header"), tagSec = sec("tag");
  let lenText = frame.echo ? `${Math.max(1, Math.floor((frame.frameBits - 3) / 8) - 2)} bytes` : "not yet read";
  if (header) {
    const h = tally(header);
    const rep = Math.max(1, Math.round(header.len / 9));
    const field = (from, n) => {
      const bits = [];
      for (let k = 0; k < n; k++) {
        const copies = [];
        for (let c = 0; c < rep; c++) { const b = h.readBits[(from + k) * rep + c]; if (b !== null) copies.push(b); }
        if (!copies.length) return null;
        const ones = copies.filter(x => x).length;
        bits.push(ones * 2 > copies.length ? 1 : ones * 2 < copies.length ? 0 : copies[0]);
      }
      return toInt(bits);
    };
    const len = field(0, 6), tag = field(6, 3);
    const wantTag = toInt([...Array(3)].map((_, k) => v.pbits[header.start + (6 + k) * rep]));
    if (len !== null) lenText = `${len} byte${len === 1 ? "" : "s"}`;
    else if (h.pending === 0) lenText = "lost";
    if (tag !== null) why.push(tag === wantTag ? `the label's model tag (#${tag}) matches` : `the label's model tag reads #${tag}, not its own`);
  }
  if (tagSec) {
    const t = tally(tagSec);
    if (t.readBits.every(b => b !== null)) {
      const tag = toInt(t.readBits), wantTag = toInt(v.pbits.slice(tagSec.start, tagSec.start + tagSec.len));
      why.push(tag === wantTag ? `the model tag (#${tag}) matches` : `the model tag reads #${tag}, not its own`);
    }
  }
  out.push(`<div class="ev-row top"><span>agreement with the original watermark</span><b class="ev-name">${a.survived ? pct + "%" : "n/a"}</b></div>`);
  out.push(`<p class="ev-why">Reference: the run made with ${esc(name)} on this page. ${a.agree} matching, ${a.survived - a.agree} flipped, ${a.planted - a.survived} lost or not yet aligned, out of ${a.planted} planted bits. The percentage counts only the ${a.survived} aligned surviving carriers. ${why.length ? why.join("; ") + "." : ""}</p>`);
  out.push(`<p class="note">This comparison uses the original recording. It is not an authorship probability. The letters below show which parts of the known original message survived.</p>`);

  const payload = sec("payload");
  if (payload) {
    // each letter owns a run of the planted bits (its code); it is intact when all of
    // them came back, flipped when any did wrong, lost when any is gone
    const p = tally(payload);
    const chars = [...(frame.message || "")];
    const { ends } = decodePrefix(messageBits(frame.message || ""));
    const letters = [];
    let intact = 0;
    chars.forEach((ch, k) => {
      const from = k ? ends[k - 1] : 0, to = ends[k] ?? from;
      const sts = p.sts.slice(from, to);
      const shown = ch === " " ? "␣" : ch;
      if (sts.includes("pending")) letters.push(`<span class="pending">·</span>`);
      else if (sts.includes("lost")) letters.push(`<span class="lost" title="some of its bits were lost">·</span>`);
      else if (sts.every(x => x === "ok")) { intact++; letters.push(`<span class="ok">${esc(shown)}</span>`); }
      else letters.push(`<span class="flip" title="${sts.filter(x => x === "flip").length} of its ${sts.length} bits flipped">?</span>`);
    });
    out.push(`<div class="ev-row"><span>message length</span><b>${esc(lenText)}</b><small>${header ? `label ${tally(header).ok} of ${header.len}` : ""}</small></div>`);
    out.push(`<div class="ev-row"><span>message</span><b class="ev-letters">${letters.join("")}</b><small>${intact} of ${chars.length} letter${chars.length === 1 ? "" : "s"} intact</small></div>`);
  }
  for (const [kind, label] of [["sync", "knock"], ["tag", "model tag"], ["checksum", "seal"], ["parity", "repair"]]) {
    const s = sec(kind);
    if (!s) continue;
    const t = tally(s);
    const bits = [];
    if (t.flip) bits.push(`${t.flip} flipped`);
    if (t.lost) bits.push(`${t.lost} lost`);
    if (t.pending) bits.push(`${t.pending} to come`);
    const note = kind === "checksum" && res ? (res.valid ? "checksum holds" : "checksum fails") : "";
    out.push(`<div class="ev-row"><span>${label}</span><b>${t.ok} of ${t.len}</b><small>${bits.join(", ")}${note ? (bits.length ? " · " : "") + note : ""}</small></div>`);
  }
  if (res) {
    out.push(`<p class="ev-verdict">${res.valid
      ? "The reader recovered a packet that passes its checksum and format checks. Repair can succeed even when individual bits or copies are damaged."
      : a.survived === 0 ? "No aligned carrier bit survived this edit; no packet validated."
      : "No packet validated. Some bits may still match the known original, but that does not establish authorship or recover a verified message."}</p>`);
  }
  return out.join("");
}
