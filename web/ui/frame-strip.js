// The frame strip: one cell per bit of the frame being written or read, in
// segments (knock, label, your tag, seal, repair). Bits travel between the
// strip and the words: out of the strip when a word is chosen, back into it
// when a word is read. The strip is the one place motion carries meaning.

const LABEL = { sync: "knock", header: "label", payload: "your tag", checksum: "seal", parity: "repair", woven: "tag, seal and repair, woven" };
const prefersReduced = () => matchMedia("(prefers-reduced-motion: reduce)").matches;

export class FrameStrip {
  constructor(root) {
    this.root = root;
    this.root.classList.add("strip");
    this.root.innerHTML = `<div class="row"></div><div class="labels"></div><div class="seal"></div>`;
    this.row = root.querySelector(".row");
    this.labels = root.querySelector(".labels");
    this.cells = [];
    this.frameBits = 0;
    this.filled = 0;
  }

  setLayout(layout, frameBits) {
    this.frameBits = frameBits;
    this.filled = 0;
    this.root.classList.remove("sealed", "locked");
    this.root.classList.toggle("wrap", frameBits > 110);
    this.row.innerHTML = "";
    this.labels.innerHTML = "";
    this.cells = [];
    for (const seg of layout) {
      for (let i = 0; i < seg.len; i++) {
        const c = document.createElement("i");
        c.className = "bit";
        c.dataset.kind = seg.kind;
        c.title = `bit ${seg.start + i}: ${LABEL[seg.kind] ?? seg.kind}`;
        this.row.appendChild(c);
        this.cells.push(c);
      }
      const l = document.createElement("span");
      l.style.flex = `${seg.len} 1 0`;
      l.textContent = LABEL[seg.kind] ?? seg.kind;
      this.labels.appendChild(l);
    }
    this.markNext();
  }

  reset() { for (const c of this.cells) c.className = "bit"; this.filled = 0; this.root.classList.remove("sealed", "locked"); this.markNext(); }

  markNext() {
    for (const c of this.cells) c.classList.remove("next");
    const i = this.filled % this.frameBits;
    if (this.cells[i] && this.filled < this.frameBits) this.cells[i].classList.add("next");
  }

  // writing: the next bit leaves its cell and lands under the word
  plant(bit, tokenEl) {
    const i = this.filled % this.frameBits;
    const cell = this.cells[i];
    if (!cell) return;
    if (this.filled >= this.frameBits) {
      // a further copy: the strip refills from the start
      if (i === 0) for (const c of this.cells) c.classList.remove("spent", "v0", "v1");
    }
    this.fly(cell, tokenEl, bit, () => {
      cell.classList.add(bit ? "v1" : "v0", "spent");
      tokenEl?.classList.add("in");
    });
    this.filled++;
    if (this.filled === this.frameBits) this.root.classList.add("sealed");
    this.markNext();
  }

  // reading: the strip has no layout yet, it grows one cell per carrier and the
  // bit under the word is pulled back into it
  growMode() {
    this.frameBits = Infinity;
    this.filled = 0;
    this.root.classList.remove("sealed", "locked");
    this.root.classList.add("wrap");
    this.row.innerHTML = "";
    this.labels.innerHTML = "";
    this.cells = [];
  }
  pull(bit, tokenEl) {
    const cell = document.createElement("i");
    cell.className = "bit";
    cell.dataset.kind = "";
    this.row.appendChild(cell);
    this.cells.push(cell);
    this.fly(tokenEl, cell, bit, () => cell.classList.add(bit ? "v1" : "v0"));
  }

  // tentative labelling while reading: recolour cells by kind as the parser
  // guesses the frame arriving at the tail
  paintSpans(spans) {
    for (const c of this.cells) if (!c.classList.contains("locked")) c.dataset.kind = "";
    for (const s of spans) for (let i = 0; i < s.len; i++) { const c = this.cells[s.start + i]; if (c && !c.classList.contains("locked")) c.dataset.kind = s.kind; }
    this.relabel(spans);
  }
  // a checksum-valid frame: its cells lock green and keep their labels
  lockSpans(spans) {
    for (const s of spans) for (let i = 0; i < s.len; i++) { const c = this.cells[s.start + i]; if (c) { c.dataset.kind = s.kind; c.classList.add("locked"); } }
    this.root.classList.add("locked", "sealed");
    this.relabel(spans);
  }
  // wrapped strips cannot align labels under cells; list the segments instead
  relabel(spans) {
    this.labels.innerHTML = "";
    for (const s of spans) {
      const l = document.createElement("span");
      l.textContent = `${LABEL[s.kind] ?? s.kind} ${s.len}`;
      this.labels.appendChild(l);
    }
  }
  // the frame no longer validates after an edit
  kill() { this.root.classList.remove("locked", "sealed"); for (const c of this.cells) if (c.classList.contains("v0") || c.classList.contains("v1")) c.classList.add("dead"); }

  fly(fromEl, toEl, bit, done) {
    if (!fromEl || !toEl || prefersReduced()) { done(); return; }
    const a = fromEl.getBoundingClientRect(), b = toEl.getBoundingClientRect();
    if (!a.width || !b.width) { done(); return; }
    const el = document.createElement("i");
    el.className = "fly " + (bit ? "b1" : "b0");
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
