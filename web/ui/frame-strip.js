// The frame strip: one cell per bit of the frame being written or read, in
// sections (knock, label, your message, seal, repair), each explained and in
// its own color. Under each bar the section spells out what its bits say as
// they land: the knock as its ones and zeros, the label as the length and the
// model tag, the message as letters, the seal and the repair as hex digits.
// Bits travel between the strip and the words: out of the strip when a word is
// chosen, back into it when a word is read, and the word takes the color of
// the section its bit belongs to. The strip is the one place motion carries
// meaning.

const LABEL = {
  sync: "knock", header: "label", tag: "model tag", payload: "your message", checksum: "seal", parity: "repair",
  woven: "message, seal and repair, woven", read: "bits read",
};
const NOTE = {
  sync: "A fixed pattern of bits. The reader scans for it, so the frame can start anywhere in the text.",
  header: "How long the message is, and a short tag for the model that wrote it, with repeated bits to help the reader recover a damaged label.",
  tag: "A three-bit tag for the model that wrote it. In the echo every word votes for one bit of the packet, chosen by the words before it, so nothing has to be found first.",
  payload: "Your message itself, in a fixed code of about five bits a letter.",
  checksum: "A checksum checks the recovered message after any repair. It catches many errors, but accidental matches remain possible; it does not prove authorship.",
  parity: "Parity bits that put right a few bits a reader gets wrong.",
  woven: "Your message, its seal and repair data, interleaved so damage spreads thin.",
  read: "One cell per token that carries a bit, in the order they are read.",
};
import { messageBits, decodePrefix } from "../engine/textcode.js";

const SPELLED = ["sync", "header", "tag", "payload", "checksum", "parity"];
const prefersReduced = () => matchMedia("(prefers-reduced-motion: reduce)").matches;
const toInt = bits => bits.reduce((a, b) => a * 2 + b, 0);
const FLIGHT_MS = 720;

export class FrameStrip {
  constructor(root) {
    this.root = root;
    this.root.classList.add("strip");
    this.root.innerHTML = `<div class="segs"></div><div class="seal"></div>`;
    this.segs = root.querySelector(".segs");
    this.cells = [];
    this.pulled = [];   // reading: the word each cell came from, in order
    this.frameBits = 0;
    this.filled = 0;
    this.landed = {};   // per section, the bit values in so far
    this.message = "";  // the letters under the message bar, lit as their bytes land
    this.lit = "";
  }

  setMessage(text) {
    this.message = text || "";
    this.renderSpell("payload");
  }

  // what a section's bits say so far, as characters, each with the bit range it
  // needs; `got` is sparse (the echo lands bits out of order)
  spell(kind, got, total) {
    const have = (a, b) => { for (let i = a; i < b; i++) if (got[i] === undefined) return false; return true; };
    if (kind === "sync") return [...Array(total)].map((_, i) => ({ text: have(i, i + 1) ? String(got[i]) : "·", from: i, to: i + 1 }));
    if (kind === "header") {
      const rep = Math.max(1, Math.round(total / 9));
      const hdr = [...Array(9)].map((_, k) => got[k * rep] ?? 0);
      return [
        { text: have(0, 6 * rep) ? `${toInt(hdr.slice(0, 6))} bytes` : "? bytes", from: 0, to: 6 * rep },
        { text: " · ", sep: true },
        { text: have(6 * rep, 9 * rep) ? `model #${toInt(hdr.slice(6, 9))}` : "model #?", from: 6 * rep, to: 9 * rep },
      ];
    }
    if (kind === "tag") return [{ text: have(0, total) ? `model #${toInt([...Array(total)].map((_, i) => got[i]))}` : "model #?", from: 0, to: total }];
    if (kind === "checksum" || kind === "parity") {
      const out = [];
      for (let i = 0; i < Math.floor(total / 4); i++) {
        if (i && i % 2 === 0) out.push({ text: " ", sep: true });
        out.push({ text: have(4 * i, 4 * i + 4) ? toInt([got[4 * i], got[4 * i + 1], got[4 * i + 2], got[4 * i + 3]]).toString(16) : "·", from: 4 * i, to: 4 * i + 4 });
      }
      return out;
    }
    if (kind === "payload" && this.message) {
      // each letter owns the run of bits its code occupies
      const { ends } = decodePrefix(messageBits(this.message));
      return [...this.message].map((ch, i) => ({ text: ch === " " ? "␣" : ch, from: i ? ends[i - 1] : 0, to: ends[i] ?? Infinity }));
    }
    return null;
  }

  renderSpell(kind) {
    for (const s of this.segs.querySelectorAll(`.fseg[data-kind="${kind}"]`)) {
      const el = s.querySelector(".fseg-letters");
      const got = this.landed[kind] || [];
      const chars = this.spell(kind, got, s.querySelectorAll(".bit").length);
      if (!chars) { el.hidden = true; continue; }
      const have = (a, b) => { for (let i = a; i < b; i++) if (got[i] === undefined) return false; return true; };
      el.hidden = false;
      el.innerHTML = chars.map(c => c.sep ? `<span class="sep">${c.text}</span>` : `<span class="${have(c.from, c.to) ? "lit" : "dim"}">${escapeHtml(c.text)}</span>`).join("");
    }
  }
  renderAll() { for (const k of SPELLED) this.renderSpell(k); }

  // a landed bit of one section at its position: remember it, light what it completes
  land(kind, bit, pos) {
    (this.landed[kind] ||= [])[pos] = bit;
    this.renderSpell(kind);
  }

  clearLanded() { this.landed = {}; this.lit = ""; }

  section(kind, count) {
    const s = document.createElement("section");
    s.className = "fseg";
    s.dataset.kind = kind;
    s.innerHTML = `<div class="fseg-head"><b>${LABEL[kind] ?? kind}</b><span data-count>${count} bit${count === 1 ? "" : "s"}</span></div><div class="row"></div><div class="fseg-letters" hidden></div><p class="fseg-note">${NOTE[kind] ?? ""}</p>`;
    return s;
  }

  setLayout(layout, frameBits) {
    this.frameBits = frameBits;
    this.filled = 0;
    this.root.classList.remove("sealed", "locked");
    this.segs.innerHTML = "";
    this.cells = [];
    this.pulled = [];
    this.clearLanded();
    for (const seg of layout) {
      const s = this.section(seg.kind, seg.len);
      const row = s.querySelector(".row");
      for (let i = 0; i < seg.len; i++) {
        const c = document.createElement("i");
        c.className = "bit";
        c.dataset.kind = seg.kind;
        c.dataset.pos = i;
        c.title = `bit ${seg.start + i}: ${LABEL[seg.kind] ?? seg.kind}`;
        row.appendChild(c);
        this.cells.push(c);
      }
      this.segs.appendChild(s);
    }
    this.renderAll();
    this.markNext();
  }

  reset() {
    for (const c of this.cells) { c.className = "bit"; delete c.dataset.votes; }
    this.filled = 0;
    this.clearLanded();
    this.root.classList.remove("sealed", "locked");
    this.renderAll();
    this.markNext();
  }

  markNext() {
    for (const c of this.cells) c.classList.remove("next");
    const i = this.filled % this.frameBits;
    if (this.cells[i] && this.filled < this.frameBits) this.cells[i].classList.add("next");
  }

  // writing: the word sends its bit, a 1 or a 0, into the next cell, which
  // lights when it lands; the word takes the section's color
  // slot: the echo names the cell a word votes on; framed profiles fill in order
  plant(bit, tokenEl, slot) {
    const i = slot ?? (this.filled % this.frameBits);
    const cell = this.cells[i];
    if (!cell) return;
    if (tokenEl) tokenEl.dataset.seg = cell.dataset.kind;
    const votes = (Number(cell.dataset.votes) || 0) + 1;
    cell.dataset.votes = votes;
    if (votes > 1) {
      // a further vote or copy: the bit flies in again and its cell takes a ring;
      // the first landing stays lit underneath
      this.fly(tokenEl, cell, bit, cell.dataset.kind, () => { cell.classList.add("again"); tokenEl?.classList.add("in"); });
      this.filled++;
      if (slot !== undefined) this.sealIfCovered();
      return;
    }
    this.fly(tokenEl, cell, bit, cell.dataset.kind, () => {
      cell.classList.add(bit ? "v1" : "v0", "spent");
      tokenEl?.classList.add("in");
      this.land(cell.dataset.kind, bit, Number(cell.dataset.pos));
    });
    this.filled++;
    if (slot === undefined) { if (this.filled === this.frameBits) this.root.classList.add("sealed"); this.markNext(); }
    else this.sealIfCovered();
  }
  // the echo seals when every cell has a vote
  sealIfCovered() { if (this.cells.every(c => Number(c.dataset.votes) > 0)) this.root.classList.add("sealed"); }

  // reading: the strip does not know the frame yet. It starts as one frame's
  // worth of hollow cells in the colors the reader expects (the layout for the
  // message as typed), a guess; each carrier's bit is pulled from its word into
  // the next cell and takes the guessed color, the row growing past the guess
  // if the text carries more. As the parser makes out the frame, cells and
  // words take the parser's colors instead, and the message spells out in big
  // type as its bytes come in. At lock the colors are final and cells outside
  // the frame go grey.
  growMode(expected = null) {
    this.frameBits = Infinity;
    this.filled = 0;
    this.expected = expected;
    this.root.classList.remove("sealed", "locked");
    this.segs.innerHTML = "";
    this.cells = [];
    this.pulled = [];
    this.clearLanded();
    this.readRow = this.section("read", 0);
    this.readRow.querySelector(".fseg-note").remove();
    this.readRow.querySelector("[data-count]").textContent = "";
    this.readMsg = document.createElement("div");
    this.readMsg.className = "read-message";
    this.readMsg.hidden = true;
    this.readRow.appendChild(this.readMsg);
    this.segs.appendChild(this.readRow);
    const row = this.readRow.querySelector(".row");
    const n = expected ? expected.reduce((a, s) => a + s.len, 0) : 48;
    for (let i = 0; i < n; i++) { const c = document.createElement("i"); c.className = "bit ghost"; c.dataset.kind = this.guessKind(i); row.appendChild(c); }
  }
  // the section the reader expects at read position i: one frame's layout, repeating
  guessKind(i) {
    if (!this.expected) return "";
    const total = this.expected.reduce((a, s) => a + s.len, 0);
    const j = i % total;
    return this.expected.find(s => j >= s.start && j < s.start + s.len)?.kind ?? "";
  }
  pull(bit, tokenEl) {
    const row = this.readRow.querySelector(".row");
    const i = this.cells.length;
    const kind = this.guessKind(i);
    let cell = row.querySelector(".ghost");
    if (cell) cell.classList.remove("ghost");
    else { cell = document.createElement("i"); cell.className = "bit"; row.appendChild(cell); }
    cell.dataset.kind = kind;
    cell.dataset.est = kind;
    cell.dataset.bit = bit;
    if (tokenEl && kind) tokenEl.dataset.seg = kind;
    this.cells.push(cell);
    this.pulled.push(tokenEl);
    this.readRow.querySelector("[data-count]").textContent = `${this.cells.length} bit${this.cells.length === 1 ? "" : "s"}`;
    this.fly(tokenEl, cell, bit, kind, () => cell.classList.add(bit ? "v1" : "v0"));
  }

  // color cells and words by the frame the parser currently makes out; outside
  // its spans, the reader's guess while reading, grey once the frame is final
  colorSpans(spans, { guess = true } = {}) {
    this.cells.forEach((c, i) => { c.dataset.kind = guess ? (c.dataset.est ?? "") : ""; });
    this.pulled.forEach((t, i) => { if (!t) return; const k = guess ? this.cells[i]?.dataset.est : ""; if (k) t.dataset.seg = k; else delete t.dataset.seg; });
    for (const s of spans) for (let i = 0; i < s.len; i++) {
      const c = this.cells[s.start + i];
      if (!c) continue;
      c.dataset.kind = s.kind;
      const t = this.pulled[s.start + i];
      if (t) t.dataset.seg = s.kind;
    }
  }

  // the message so far, decoded from the bits of the payload span that are in
  spellRead(spans, message = "") {
    const p = spans.find(s => s.kind === "payload");
    if (!p) { this.readMsg.hidden = true; return; }
    let text = message, done = !!message;
    if (!text) {
      const bits = [];
      for (let i = 0; i < p.len; i++) { const c = this.cells[p.start + i]; if (!c) break; bits.push(Number(c.dataset.bit)); }
      ({ text, done } = decodePrefix(bits));
    }
    this.readMsg.hidden = false;
    this.readMsg.innerHTML = [...text].map(ch => `<span class="lit">${escapeHtml(ch === " " ? "␣" : ch)}</span>`).join("")
      + (done ? "" : `<span class="dim">…</span>`);
  }

  // tentative labelling while reading, on every carrier
  paintSpans(spans) {
    if (this.root.classList.contains("locked")) return;
    this.colorSpans(spans);
    this.spellRead(spans);
  }

  // a checksum-valid frame: the colors are final, the message is the one the
  // checksum vouches for
  lockSpans(spans, message = "") {
    if (spans.length) {
      this.colorSpans(spans, { guess: false });
      for (const c of this.cells) c.classList.add("locked");
      this.spellRead(spans, message);
    }
    this.root.classList.add("locked", "sealed");
  }

  // an echo that validates: each read cell and its word take the color of the
  // section its slot falls in, and the message spells out
  lockEcho(layout, slots, message = "") {
    const kindOf = j => layout.find(s => j >= s.start && j < s.start + s.len)?.kind ?? "";
    for (const c of this.cells) c.dataset.kind = "";
    for (const t of this.pulled) if (t) delete t.dataset.seg;
    slots.forEach((j, i) => {
      const kind = kindOf(j);
      const c = this.cells[i]; if (c) { c.dataset.kind = kind; c.classList.add("locked"); }
      const t = this.pulled[i]; if (t && kind) t.dataset.seg = kind;
    });
    if (message) {
      this.readMsg.hidden = false;
      this.readMsg.innerHTML = [...message].map(ch => `<span class="lit">${escapeHtml(ch === " " ? "␣" : ch)}</span>`).join("");
    }
    this.root.classList.add("locked", "sealed");
  }

  // the frame no longer validates after an edit
  kill() { this.root.classList.remove("locked", "sealed"); for (const c of this.cells) if (c.classList.contains("v0") || c.classList.contains("v1")) c.classList.add("dead"); }

  // the bit in flight is its digit, from under the word to the middle of the cell
  fly(fromEl, toEl, bit, kind, done) {
    if (!fromEl || !toEl || prefersReduced()) { done(); return; }
    const a = fromEl.getBoundingClientRect(), b = toEl.getBoundingClientRect();
    if (!a.width || !b.width) { done(); return; }
    const el = document.createElement("i");
    el.className = "fly " + (bit ? "b1" : "b0");
    el.dataset.kind = kind;
    el.textContent = bit ? "1" : "0";
    document.body.appendChild(el);
    const w = el.offsetWidth, h = el.offsetHeight;
    const x0 = a.left + a.width / 2 - w / 2, y0 = a.top + a.height - h / 2;
    el.style.left = `${x0}px`;
    el.style.top = `${y0}px`;
    const dx = (b.left + b.width / 2 - w / 2) - x0;
    const dy = (b.top + b.height / 2 - h / 2) - y0;
    // slow enough to follow with the eye; several bits may be in the air at once
    const anim = el.animate(
      [{ transform: "translate(0,0)", opacity: 1 }, { transform: `translate(${dx}px, ${dy}px)`, opacity: 0.9 }],
      { duration: FLIGHT_MS, easing: "cubic-bezier(0.45, 0.05, 0.25, 1)", fill: "forwards" },
    );
    anim.onfinish = () => { el.remove(); done(); };
  }
}

function escapeHtml(s) { return s.replace(/[&<>]/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;" }[c])); }
