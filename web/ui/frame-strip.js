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
  sync: "knock", header: "label", payload: "your message", checksum: "seal", parity: "repair",
  woven: "message, seal and repair, woven", read: "bits read",
};
const NOTE = {
  sync: "A fixed pattern of bits. A reader scans for it, so the frame can start anywhere in the text.",
  header: "How long the message is, and a short tag for the model that wrote it, each bit sent twice.",
  payload: "Your message itself, eight bits a letter.",
  checksum: "A checksum over the message. One wrong bit and the frame fails, so a reader never reports a match it cannot back.",
  parity: "Parity bits that put right a few bits a reader gets wrong.",
  woven: "Your message, its seal and repair data, interleaved so damage spreads thin.",
  read: "One cell per word that carries a bit, in the order they are read.",
};
const SPELLED = ["sync", "header", "payload", "checksum", "parity"];
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
    this.decoder = new TextDecoder();
  }

  setMessage(text) {
    this.message = text || "";
    this.msgBytes = new TextEncoder().encode(this.message);
    this.renderSpell("payload");
  }

  // what a section's bits say so far, as characters and the bit count each needs
  spell(kind, got, total) {
    if (kind === "sync") return [...Array(total)].map((_, i) => ({ text: i < got.length ? String(got[i]) : "·", need: i + 1 }));
    if (kind === "header") {
      const rep = Math.max(1, Math.round(total / 9));
      const hdr = [...Array(9)].map((_, k) => got[k * rep] ?? 0);
      return [
        { text: got.length >= 6 * rep ? `${toInt(hdr.slice(0, 6))} bytes` : "? bytes", need: 6 * rep },
        { text: " · ", sep: true },
        { text: got.length >= 9 * rep ? `model #${toInt(hdr.slice(6, 9))}` : "model #?", need: 9 * rep },
      ];
    }
    if (kind === "checksum" || kind === "parity") {
      const out = [];
      for (let i = 0; i < Math.floor(total / 4); i++) {
        if (i && i % 2 === 0) out.push({ text: " ", sep: true });
        const need = 4 * (i + 1);
        out.push({ text: got.length >= need ? toInt(got.slice(4 * i, need)).toString(16) : "·", need });
      }
      return out;
    }
    if (kind === "payload" && this.message) {
      const litCount = [...this.lit].length;
      return [...this.message].map((ch, i) => ({ text: ch === " " ? "␣" : ch, need: i < litCount ? 0 : Infinity }));
    }
    return null;
  }

  renderSpell(kind) {
    for (const s of this.segs.querySelectorAll(`.fseg[data-kind="${kind}"]`)) {
      const el = s.querySelector(".fseg-letters");
      const got = this.landed[kind] || [];
      const chars = this.spell(kind, got, s.querySelectorAll(".bit").length);
      if (!chars) { el.hidden = true; continue; }
      el.hidden = false;
      el.innerHTML = chars.map(c => c.sep ? `<span class="sep">${c.text}</span>` : `<span class="${got.length >= c.need ? "lit" : "dim"}">${escapeHtml(c.text)}</span>`).join("");
    }
  }
  renderAll() { for (const k of SPELLED) this.renderSpell(k); }

  // a landed bit of one section: remember it, and light what it completes
  land(kind, bit) {
    (this.landed[kind] ||= []).push(bit);
    if (kind === "payload") {
      const n = this.landed.payload.length;
      if (n % 8 === 0) {
        const b = this.msgBytes?.[n / 8 - 1];
        if (b !== undefined) this.lit += this.decoder.decode(new Uint8Array([b]), { stream: true });
      }
    }
    this.renderSpell(kind);
  }

  clearLanded() { this.landed = {}; this.lit = ""; this.decoder = new TextDecoder(); }

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
    for (const c of this.cells) c.className = "bit";
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

  // writing: the next bit leaves its cell and lands under the word, which
  // takes the section's color
  plant(bit, tokenEl) {
    const i = this.filled % this.frameBits;
    const cell = this.cells[i];
    if (!cell) return;
    if (tokenEl) tokenEl.dataset.seg = cell.dataset.kind;
    if (this.filled >= this.frameBits) {
      // a further copy: the bit flies out again and its cell takes a ring; the
      // first frame stays lit underneath
      this.fly(cell, tokenEl, bit, cell.dataset.kind, () => { cell.classList.add("again"); tokenEl?.classList.add("in"); });
      this.filled++;
      return;
    }
    this.fly(cell, tokenEl, bit, cell.dataset.kind, () => {
      cell.classList.add(bit ? "v1" : "v0", "spent");
      tokenEl?.classList.add("in");
      this.land(cell.dataset.kind, bit);
    });
    this.filled++;
    if (this.filled === this.frameBits) this.root.classList.add("sealed");
    this.markNext();
  }

  // reading: the strip has no layout yet; it grows one line of cells, one per
  // carrier, and the bit under the word is pulled back into it. As the parser
  // makes out the frame, cells and words take the section colors, and the
  // message spells out in big type as its bytes come in.
  growMode() {
    this.frameBits = Infinity;
    this.filled = 0;
    this.root.classList.remove("sealed", "locked");
    this.segs.innerHTML = "";
    this.cells = [];
    this.pulled = [];
    this.clearLanded();
    this.readRow = this.section("read", 0);
    this.readRow.querySelector(".fseg-note").remove();
    this.readMsg = document.createElement("div");
    this.readMsg.className = "read-message";
    this.readMsg.hidden = true;
    this.readRow.appendChild(this.readMsg);
    this.segs.appendChild(this.readRow);
  }
  pull(bit, tokenEl) {
    const cell = document.createElement("i");
    cell.className = "bit";
    cell.dataset.kind = "";
    cell.dataset.bit = bit;
    this.readRow.querySelector(".row").appendChild(cell);
    this.cells.push(cell);
    this.pulled.push(tokenEl);
    this.readRow.querySelector("[data-count]").textContent = `${this.cells.length} bit${this.cells.length === 1 ? "" : "s"}`;
    this.fly(tokenEl, cell, bit, "", () => cell.classList.add(bit ? "v1" : "v0"));
  }

  // color cells and words by the frame the parser currently makes out
  colorSpans(spans) {
    for (const c of this.cells) c.dataset.kind = "";
    for (const t of this.pulled) if (t) delete t.dataset.seg;
    for (const s of spans) for (let i = 0; i < s.len; i++) {
      const c = this.cells[s.start + i];
      if (!c) continue;
      c.dataset.kind = s.kind;
      const t = this.pulled[s.start + i];
      if (t) t.dataset.seg = s.kind;
    }
  }

  // the message so far, from the bytes of the payload span that are complete
  spellRead(spans, message = "") {
    const p = spans.find(s => s.kind === "payload");
    if (!p) { this.readMsg.hidden = true; return; }
    const nBytes = Math.floor(p.len / 8);
    let text = message;
    if (!text) {
      const bytes = [];
      for (let b = 0; b < nBytes; b++) {
        const bits = [];
        for (let i = 0; i < 8; i++) { const c = this.cells[p.start + b * 8 + i]; if (!c) break; bits.push(Number(c.dataset.bit)); }
        if (bits.length < 8) break;
        bytes.push(toInt(bits));
      }
      text = new TextDecoder().decode(new Uint8Array(bytes), { stream: true });
    }
    const pending = Math.max(0, nBytes - new TextEncoder().encode(text).length);
    this.readMsg.hidden = false;
    this.readMsg.innerHTML = [...text].map(ch => `<span class="lit">${escapeHtml(ch === " " ? "␣" : ch)}</span>`).join("")
      + Array.from({ length: pending }, () => `<span class="dim">·</span>`).join("");
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
      this.colorSpans(spans);
      for (const c of this.cells) c.classList.add("locked");
      this.spellRead(spans, message);
    }
    this.root.classList.add("locked", "sealed");
  }

  // the frame no longer validates after an edit
  kill() { this.root.classList.remove("locked", "sealed"); for (const c of this.cells) if (c.classList.contains("v0") || c.classList.contains("v1")) c.classList.add("dead"); }

  fly(fromEl, toEl, bit, kind, done) {
    if (!fromEl || !toEl || prefersReduced()) { done(); return; }
    const a = fromEl.getBoundingClientRect(), b = toEl.getBoundingClientRect();
    if (!a.width || !b.width) { done(); return; }
    const el = document.createElement("i");
    el.className = "fly " + (bit ? "b1" : "b0");
    el.dataset.kind = kind;
    el.style.left = `${a.left + a.width / 2 - 5}px`;
    el.style.top = `${a.top + a.height - 4}px`;
    document.body.appendChild(el);
    const dx = (b.left + b.width / 2 - 5) - (a.left + a.width / 2 - 5);
    const dy = (b.top + b.height - 4) - (a.top + a.height - 4);
    // slow enough to follow with the eye; several bits may be in the air at once
    const anim = el.animate(
      [{ transform: "translate(0,0)", opacity: 1 }, { transform: `translate(${dx}px, ${dy}px)`, opacity: 0.9 }],
      { duration: FLIGHT_MS, easing: "cubic-bezier(0.45, 0.05, 0.25, 1)", fill: "forwards" },
    );
    anim.onfinish = () => { el.remove(); done(); };
  }
}

function escapeHtml(s) { return s.replace(/[&<>]/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;" }[c])); }
