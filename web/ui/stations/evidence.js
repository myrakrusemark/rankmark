// Station: edit it and it still tells. The same reader, with the writer's
// planted bits kept as the reference. After each read, the recovered bits are
// lined up against the planted ones, section by section, and the panel says
// what a reader can still make out: which model wrote it, and why; how long
// the message is; the letters that still read; which parts of the frame broke.
// A partial pattern is evidence even when the full message is gone; that is
// what a keyed detector reports.

import { agreement } from "../../engine/compare.js";

const toInt = bits => bits.reduce((a, b) => a * 2 + b, 0);
const shortName = id => (id || "").replace(/-Q.*$/, "");
const esc = s => String(s).replace(/[&<>]/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;" }[c]));

export function attachEvidence(readPanel, meterEl) {
  readPanel.reference = null;       // [{id, carrier, bit}] from the write station
  readPanel.frame = null;           // { layout, frameBits, message, rung }
  readPanel.readTokens = [];
  const origAppend = readPanel.view.append.bind(readPanel.view);
  readPanel.view.append = (e, o) => { const el = origAppend(e, o); if (!e.seed) readPanel.readTokens.push({ id: e.id, carrier: !!e.carrier, bit: e.bit ?? null, el }); return el; };
  const origRun = readPanel.run.bind(readPanel);
  readPanel.run = async opts => {
    readPanel.readTokens = [];
    meterEl.hidden = true;
    const res = await origRun(opts);
    if (!res || !readPanel.reference) return res;
    const a = agreement(readPanel.reference, readPanel.readTokens);
    a.perToken.forEach((mark, j) => { const t = readPanel.readTokens[j]; if (t && mark) t.el.classList.add(`ev-${mark}`); });
    meterEl.innerHTML = report(a, res, readPanel.frame, readPanel.reference);
    meterEl.hidden = false;
    return res;
  };
}

// the frame's bits as the writer planted them, in order
function plantedBits(reference) { return reference.filter(t => t.carrier).map(t => t.bit); }

function report(a, res, frame, reference) {
  const name = shortName(frame?.rung);
  const pct = a.agreementPct ?? 0;
  if (!frame?.layout) {
    return `<div class="ev-row"><span>surviving bits that agree with what ${esc(name)} planted</span><b>${a.survived ? pct + "%" : "n/a"}</b><small>chance is 50%</small></div>`;
  }
  const planted = plantedBits(reference);
  const sec = kind => frame.layout.find(s => s.kind === kind);
  // per section: how its bits came back, and the bits a reader would take from it
  const tally = s => {
    const rows = a.perPlanted.slice(s.start, s.start + s.len);
    const ok = rows.filter(r => r.status === "ok").length, flip = rows.filter(r => r.status === "flip").length, lost = rows.length - ok - flip;
    const readBits = rows.map((r, i) => (r.status === "lost" ? null : (r.status === "ok" ? planted[s.start + i] : r.readBit)));
    return { ok, flip, lost, len: s.len, readBits, intact: ok === s.len };
  };
  const out = [];

  // who wrote it: the footer names a model, the label carries its tag, and the bits agree with what it planted
  const why = [];
  if (res.card?.rungId) why.push(res.card.rungId === frame.rung ? "the footer line names it" : `the footer line names ${esc(shortName(res.card.rungId))}`);
  const header = sec("header");
  let lenText = "unknown", tagText = null;
  if (header) {
    const h = tally(header);
    const rep = Math.max(1, Math.round(header.len / 9));
    const field = (from, n) => { const bits = []; for (let k = 0; k < n; k++) { const copies = []; for (let c = 0; c < rep; c++) { const b = h.readBits[(from + k) * rep + c]; if (b !== null && b !== undefined) copies.push(b); } if (!copies.length) return null; bits.push(copies.filter(x => x).length * 2 > copies.length ? 1 : (copies.filter(x => x).length * 2 === copies.length ? copies[0] : 0)); } return toInt(bits); };
    const len = field(0, 6), tag = field(6, 3);
    const wantTag = toInt([...Array(3)].map((_, k) => planted[header.start + (6 + k) * rep]));
    if (len !== null) lenText = `${len} byte${len === 1 ? "" : "s"}`;
    if (tag !== null) { tagText = `#${tag}`; why.push(tag === wantTag ? `the label's model tag (${tagText}) matches` : `the label's model tag reads ${tagText}, not its own`); }
  }
  if (a.survived) why.push(`${a.agree} of the ${a.survived} surviving bits agree with what it planted, where chance would give about ${Math.round(a.survived / 2)}`);
  out.push(`<div class="ev-row top"><span>written by</span><b class="ev-name">${esc(name)}</b></div>`);
  out.push(`<p class="ev-why">${why.length ? why.join("; ") + "." : "No bit survived this edit, so nothing can be said."}</p>`);

  // the message: each byte from the bits a reader would take, intact, flipped or lost
  const payload = sec("payload");
  if (payload) {
    const p = tally(payload);
    const nBytes = Math.floor(payload.len / 8);
    const letters = [];
    let intact = 0;
    for (let b = 0; b < nBytes; b++) {
      const bits = p.readBits.slice(b * 8, b * 8 + 8);
      const statuses = a.perPlanted.slice(payload.start + b * 8, payload.start + b * 8 + 8).map(r => r.status);
      if (statuses.includes("lost")) letters.push(`<span class="lost">·</span>`);
      else {
        const ch = String.fromCharCode(toInt(bits));
        const shown = ch === " " ? "␣" : (ch.charCodeAt(0) < 32 || ch.charCodeAt(0) > 126 ? "?" : ch);
        if (statuses.every(s => s === "ok")) { intact++; letters.push(`<span class="ok">${esc(shown)}</span>`); }
        else letters.push(`<span class="flip" title="${8 - statuses.filter(s => s === "ok").length} of its 8 bits flipped">${esc(shown)}</span>`);
      }
    }
    out.push(`<div class="ev-row"><span>message length</span><b>${esc(lenText)}</b><small>${header ? `label ${tally(header).ok} of ${header.len}` : ""}</small></div>`);
    out.push(`<div class="ev-row"><span>message</span><b class="ev-letters">${letters.join("")}</b><small>${intact} of ${nBytes} letter${nBytes === 1 ? "" : "s"} intact</small></div>`);
  }
  for (const [kind, label] of [["sync", "knock"], ["checksum", "seal"], ["parity", "repair"]]) {
    const s = sec(kind);
    if (!s) continue;
    const t = tally(s);
    const note = kind === "checksum" ? (t.intact && res.valid ? "checksum holds" : "checksum fails") : "";
    out.push(`<div class="ev-row"><span>${label}</span><b>${t.ok} of ${t.len}</b><small>${t.lost ? `${t.lost} lost` : ""}${t.lost && t.flip ? ", " : ""}${t.flip ? `${t.flip} flipped` : ""}${note ? (t.lost || t.flip ? " · " : "") + note : ""}</small></div>`);
  }
  out.push(`<p class="ev-verdict">${res.valid
    ? "The frame validates: every bit agrees and the checksum holds."
    : a.survived === 0 ? "No planted bit survived this edit."
    : pct >= 80 ? `The checksum fails, so the full message is not vouched for; the bits that survived still say ${esc(name)} wrote this.`
    : "What survived agrees no better than chance: after this edit the reader is scoring different words than the writer did."}</p>`);
  return out.join("");
}
