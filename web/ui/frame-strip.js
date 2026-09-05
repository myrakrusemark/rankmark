// The frame strip: one cell per bit of the frame being written or read, in
// sections (knock, label, your message, seal, repair), each explained and in
// its own color. Bits travel between the strip and the words: out of the strip
// when a word is chosen, back into it when a word is read, and the word takes
// the color of the section its bit belongs to. The strip is the one place
// motion carries meaning.

const LABEL = {
  sync: "knock", header: "label", payload: "your message", checksum: "seal", parity: "repair",
  woven: "message, seal and repair, woven", read: "bits read", outside: "outside the frame",
};
const NOTE = {
  sync: "A fixed pattern of bits. A reader scans for it, so the frame can start anywhere in the text.",
  header: "How long the message is, and a short fingerprint of the model that wrote it.",
  payload: "Your message itself, eight bits a letter.",
  checksum: "A checksum over the message. One wrong bit and the frame fails, so a reader never reports a match it cannot back.",
  parity: "Parity bits that put right a few bits a reader gets wrong.",
  woven: "Your message, its seal and repair data, interleaved so damage spreads thin.",
  read: "One cell per word that carries a bit, in the order they are read.",
  outside: "Bits from words before or after the frame; the reader ignores them.",
};
const prefersReduced = () => matchMedia("(prefers-reduced-motion: reduce)").matches;

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
  }

  section(kind, count) {
    const s = document.createElement("section");
    s.className = "fseg";
    s.dataset.kind = kind;
    s.innerHTML = `<div class="fseg-head"><b>${LABEL[kind] ?? kind}</b><span data-count>${count} bit${count === 1 ? "" : "s"}</span></div><div class="row"></div><p class="fseg-note">${NOTE[kind] ?? ""}</p>`;
    return s;
  }

  setLayout(layout, frameBits) {
    this.frameBits = frameBits;
    this.filled = 0;
    this.root.classList.remove("sealed", "locked");
    this.segs.innerHTML = "";
    this.cells = [];
    this.pulled = [];
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
    this.markNext();
  }

  reset() { for (const c of this.cells) c.className = "bit"; this.filled = 0; this.root.classList.remove("sealed", "locked"); this.markNext(); }

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
      // a further copy while the sentence finishes: the word takes its color,
      // the planted frame stays lit
      tokenEl?.classList.add("in");
      this.filled++;
      return;
    }
    this.fly(cell, tokenEl, bit, cell.dataset.kind, () => {
      cell.classList.add(bit ? "v1" : "v0", "spent");
      tokenEl?.classList.add("in");
    });
    this.filled++;
    if (this.filled === this.frameBits) this.root.classList.add("sealed");
    this.markNext();
  }

  // reading: the strip has no layout yet; it grows one cell per carrier in a
  // single row and the bit under the word is pulled back into it
  growMode() {
    this.frameBits = Infinity;
    this.filled = 0;
    this.root.classList.remove("sealed", "locked");
    this.segs.innerHTML = "";
    this.cells = [];
    this.pulled = [];
    this.readRow = this.section("read", 0);
    this.segs.appendChild(this.readRow);
  }
  pull(bit, tokenEl) {
    const cell = document.createElement("i");
    cell.className = "bit";
    cell.dataset.kind = "";
    this.readRow.querySelector(".row").appendChild(cell);
    this.cells.push(cell);
    this.pulled.push(tokenEl);
    this.readRow.querySelector("[data-count]").textContent = `${this.cells.length} bit${this.cells.length === 1 ? "" : "s"}`;
    this.fly(tokenEl, cell, bit, "", () => cell.classList.add(bit ? "v1" : "v0"));
  }

  // tentative labelling while reading: recolour cells by kind as the parser
  // guesses the frame arriving at the tail
  paintSpans(spans) {
    if (this.root.classList.contains("locked")) return;
    for (const c of this.cells) c.dataset.kind = "";
    for (const s of spans) for (let i = 0; i < s.len; i++) { const c = this.cells[s.start + i]; if (c) c.dataset.kind = s.kind; }
  }

  // a checksum-valid frame: the read row regroups into the frame's sections,
  // bits outside the frame stay aside, and the words take their colors
  lockSpans(spans) {
    if (!spans.length) { this.root.classList.add("locked", "sealed"); return; }
    const sorted = [...spans].sort((a, b) => a.start - b.start);
    const first = sorted[0].start, last = sorted[sorted.length - 1].start + sorted[sorted.length - 1].len;
    this.segs.innerHTML = "";
    const place = (kind, cells, from) => {
      if (!cells.length) return;
      const s = this.section(kind, cells.length);
      const row = s.querySelector(".row");
      cells.forEach((c, i) => { c.dataset.kind = kind; c.classList.add("locked"); row.appendChild(c); const t = this.pulled[from + i]; if (t && kind !== "outside") t.dataset.seg = kind; });
      this.segs.appendChild(s);
    };
    place("outside", this.cells.slice(0, first), 0);
    for (const s of sorted) place(s.kind, this.cells.slice(s.start, s.start + s.len), s.start);
    place("outside", this.cells.slice(last), last);
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
    const anim = el.animate(
      [{ transform: "translate(0,0)", opacity: 1 }, { transform: `translate(${dx}px, ${dy}px)`, opacity: 0.9 }],
      { duration: 240, easing: "cubic-bezier(0.16, 1, 0.3, 1)", fill: "forwards" },
    );
    anim.onfinish = () => { el.remove(); done(); };
  }
}
