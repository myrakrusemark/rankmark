// Station: edit it and it still tells. The same reader, with the writer's
// planted bits kept as the reference. The planted frame sits on the right as
// one line of hollow cells in the section colors. As the reader pulls a bit
// out of a word, the bit flies to the planted cell it lines up with (the same
// alignment a keyed detector would use, here by matching the words): the cell
// fills in its color if the bit agrees, red if it flipped, and cells the
// alignment skips go dashed as lost. Under the line, the report fills in as
// the bits arrive: which model wrote this and why, how long the message is,
// the letters that still read, and which parts of the frame broke. A partial
// pattern is evidence even when the full message is gone.

import { agreement } from "../../engine/compare.js";
import { FrameStrip } from "../frame-strip.js";

const toInt = bits => bits.reduce((a, b) => a * 2 + b, 0);
const shortName = id => (id || "").replace(/-Q.*$/, "");
const esc = s => String(s).replace(/[&<>]/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;" }[c])).replace(/"/g, "&quot;");
const fly = FrameStrip.prototype.fly;

export function attachEvidence(readPanel, meterEl) {
  readPanel.reference = null;       // [{id, carrier, bit}] from the write station
  readPanel.frame = null;           // { layout, frameBits, message, rung }
  readPanel.readTokens = [];
  const lineup = document.createElement("div");
  lineup.className = "lineup strip";
  lineup.hidden = true;
  meterEl.parentElement.insertBefore(lineup, meterEl);
  let cells = [];

  // the planted frame as a line of hollow cells, one per bit, colored by section
  const buildLineup = () => {
    const f = readPanel.frame;
    if (!f?.layout || !readPanel.reference) { lineup.hidden = true; return; }
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
  const origLoad = readPanel.load.bind(readPanel);
  readPanel.load = card => { origLoad(card); queueMicrotask(buildLineup); };

  let frontier = -1;   // the furthest planted bit the alignment has reached
  const settle = a => {
    const f = readPanel.frame;
    for (let k = 0; k < cells.length; k++) {
      const st = a.perPlanted[k]?.status;
      cells[k].classList.toggle("ok", st === "ok");
      cells[k].classList.toggle("flip", st === "flip");
      cells[k].classList.toggle("lost", st === "lost" && k < frontier);
    }
    const reached = Math.min(frontier, f.frameBits);
    const lost = a.perPlanted.slice(0, Math.max(0, reached)).filter(r => r.status === "lost").length;
    lineup.querySelector("[data-lineup-count]").textContent = `${a.agree} of ${f.frameBits} agree · ${a.survived - a.agree} flipped · ${lost} lost`;
  };

  const origAppend = readPanel.view.append.bind(readPanel.view);
  readPanel.view.append = (e, o) => {
    const el = origAppend(e, o);
    if (e.seed) return el;
    readPanel.readTokens.push({ id: e.id, carrier: !!e.carrier, bit: e.bit ?? null, el });
    if (!e.carrier || !readPanel.reference || !cells.length) return el;
    // line this bit up with the planted frame and send it there
    const a = agreement(readPanel.reference, readPanel.readTokens);
    const j = readPanel.readTokens.length - 1;
    const k = a.readToPlanted[j];
    if (k !== null && k < cells.length) {
      frontier = Math.max(frontier, k);
      const ok = a.perPlanted[k].status === "ok";
      el.classList.add(ok ? "ev-ok" : "ev-flip");
      fly(el, cells[k], e.bit, ok ? cells[k].dataset.kind : "", () => settle(a));
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

function plantedBits(reference) { return reference.filter(t => t.carrier).map(t => t.bit); }

// the panel: model and reasons, length, letters, and the frame's parts. While
// the read is still going, planted bits beyond the alignment's reach are
// pending rather than lost.
function report(a, res, frame, reference, frontier) {
  const name = shortName(frame?.rung);
  const pct = a.agreementPct ?? 0;
  if (!frame?.layout) {
    return `<div class="ev-row"><span>surviving bits that agree with what ${esc(name)} planted</span><b>${a.survived ? pct + "%" : "n/a"}</b><small>chance is 50%</small></div>`;
  }
  const planted = plantedBits(reference);
  const status = k => { const st = a.perPlanted[k]?.status ?? "lost"; return st === "lost" && k > frontier ? "pending" : st; };
  const sec = kind => frame.layout.find(s => s.kind === kind);
  const tally = s => {
    const sts = []; for (let k = s.start; k < s.start + s.len; k++) sts.push(status(k));
    const ok = sts.filter(x => x === "ok").length, flip = sts.filter(x => x === "flip").length, lost = sts.filter(x => x === "lost").length, pending = sts.filter(x => x === "pending").length;
    const readBits = sts.map((x, i) => (x === "ok" ? planted[s.start + i] : x === "flip" ? a.perPlanted[s.start + i].readBit : null));
    return { ok, flip, lost, pending, len: s.len, readBits, sts };
  };
  const out = [];

  const why = [];
  if (res?.card?.rungId) why.push(res.card.rungId === frame.rung ? "the footer line names it" : `the footer line names ${esc(shortName(res.card.rungId))}`);
  const header = sec("header");
  let lenText = "not yet read";
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
    const wantTag = toInt([...Array(3)].map((_, k) => planted[header.start + (6 + k) * rep]));
    if (len !== null) lenText = `${len} byte${len === 1 ? "" : "s"}`;
    else if (h.pending === 0) lenText = "lost";
    if (tag !== null) why.push(tag === wantTag ? `the label's model tag (#${tag}) matches` : `the label's model tag reads #${tag}, not its own`);
  }
  if (a.survived) why.push(`${a.agree} of the ${a.survived} bits that have come back agree with what it planted, where chance would give about ${Math.round(a.survived / 2)}`);
  out.push(`<div class="ev-row top"><span>written by</span><b class="ev-name">${esc(name)}</b></div>`);
  out.push(`<p class="ev-why">${why.length ? why.join("; ") + "." : (res ? "No bit survived this edit, so nothing can be said." : "Reading.")}</p>`);

  const payload = sec("payload");
  if (payload) {
    const p = tally(payload);
    const nBytes = Math.floor(payload.len / 8);
    const letters = [];
    let intact = 0;
    for (let b = 0; b < nBytes; b++) {
      const sts = p.sts.slice(b * 8, b * 8 + 8);
      if (sts.includes("pending")) letters.push(`<span class="pending">·</span>`);
      else if (sts.includes("lost")) letters.push(`<span class="lost" title="some of its bits were lost">·</span>`);
      else {
        const code = toInt(p.readBits.slice(b * 8, b * 8 + 8));
        const ch = code >= 32 && code < 127 ? String.fromCharCode(code) : "?";
        const shown = ch === " " ? "␣" : ch;
        if (sts.every(x => x === "ok")) { intact++; letters.push(`<span class="ok">${esc(shown)}</span>`); }
        else letters.push(`<span class="flip" title="${sts.filter(x => x === "flip").length} of its 8 bits flipped">${esc(shown)}</span>`);
      }
    }
    out.push(`<div class="ev-row"><span>message length</span><b>${esc(lenText)}</b><small>${header ? `label ${tally(header).ok} of ${header.len}` : ""}</small></div>`);
    out.push(`<div class="ev-row"><span>message</span><b class="ev-letters">${letters.join("")}</b><small>${intact} of ${nBytes} letter${nBytes === 1 ? "" : "s"} intact</small></div>`);
  }
  for (const [kind, label] of [["sync", "knock"], ["checksum", "seal"], ["parity", "repair"]]) {
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
    // the verdict rests on how far agreement sits above chance: z of 3 is one in a thousand by luck
    out.push(`<p class="ev-verdict">${res.valid
      ? "The frame validates: every bit agrees and the checksum holds."
      : a.survived === 0 ? "No planted bit survived this edit."
      : a.z >= 3 ? `The checksum fails, so the full message is not vouched for; the bits that survived still say ${esc(name)} wrote this (${pct}% agree; luck gives that less than one time in a thousand).`
      : a.z >= 2 ? `Weak evidence: ${pct}% agree, which luck gives about one time in twenty.`
      : "What survived agrees no better than chance: after this edit the reader is scoring different words than the writer did."}</p>`);
  }
  return out.join("");
}
