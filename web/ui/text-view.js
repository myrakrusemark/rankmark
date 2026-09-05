// The text as it streams: one span per token, an underline where a bit
// lives (dotted for 0, solid for 1), a brief dim pulse on a word that carried
// nothing. Hover or focus any word for its rank, entropy and bit.

let tip = null;
function tooltip() {
  if (tip) return tip;
  tip = document.createElement("div");
  tip.className = "tip";
  tip.setAttribute("role", "tooltip");
  document.body.appendChild(tip);
  return tip;
}

export class TextView {
  constructor(root, { emptyText = "" } = {}) {
    this.root = root;
    this.root.classList.add("text", "empty");
    this.root.dataset.empty = emptyText;
    this.tokens = [];
    this.root.addEventListener("mouseover", e => this.show(e.target));
    this.root.addEventListener("mouseout", () => this.hide());
    this.root.addEventListener("focusin", e => this.show(e.target));
    this.root.addEventListener("focusout", () => this.hide());
  }

  clear() { this.root.innerHTML = ""; this.root.classList.add("empty"); this.tokens = []; }

  setPlain(text) { this.clear(); this.root.classList.remove("empty"); this.root.textContent = text; }

  // append a token event; returns its element
  append(e, { reveal = true } = {}) {
    this.root.classList.remove("empty");
    const s = document.createElement("span");
    s.className = "tok " + (e.carrier ? (e.bit ? "bit1" : "bit0") : "null");
    s.textContent = e.piece;
    s.tabIndex = 0;
    s.dataset.rank = e.rank;
    if (e.entropy !== undefined) s.dataset.entropy = e.entropy;
    if (e.carrier) s.dataset.bit = e.bit;
    const info = e.carrier
      ? `#${e.rank + 1} choice, carries a ${e.bit}`
      : `#${e.rank + 1} choice, carried nothing`;
    s.setAttribute("aria-label", `${e.piece.trim() || "space"}: ${info}`);
    this.root.appendChild(s);
    this.tokens.push(s);
    if (reveal) requestAnimationFrame(() => { s.classList.add("in"); if (!e.carrier) s.classList.add("pulse"); });
    return s;
  }

  markDead(fromIndex) { this.tokens.slice(fromIndex).forEach(t => { if (t.dataset.bit !== undefined) t.classList.add("dead"); }); }

  show(el) {
    if (!(el instanceof HTMLElement) || !el.classList.contains("tok")) return;
    const t = tooltip();
    const h = el.dataset.entropy !== undefined ? ` · entropy ${el.dataset.entropy}` : "";
    const b = el.dataset.bit !== undefined ? ` · bit ${el.dataset.bit}` : " · no bit";
    t.textContent = `#${Number(el.dataset.rank) + 1} choice${h}${b}`;
    const r = el.getBoundingClientRect();
    t.style.left = `${Math.min(r.left, innerWidth - 280)}px`;
    t.style.top = `${r.top - 34}px`;
    t.classList.add("on");
  }
  hide() { tip?.classList.remove("on"); }
}
