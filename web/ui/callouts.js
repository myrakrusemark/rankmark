// Callouts: one card at a time, anchored to the thing it explains, shown the
// first time that thing happens and never again once dismissed. Each links to
// the matching part of "How this works".

const KEY = "rankmark.callouts";
function seen() { try { return new Set(JSON.parse(localStorage.getItem(KEY) || "[]")); } catch { return new Set(); } }
function remember(id) { try { const s = seen(); s.add(id); localStorage.setItem(KEY, JSON.stringify([...s])); } catch { /* storage may be blocked */ } }

export const COPY = {
  first: { text: "Every word here is a choice the model ranked. Hover one to see which choice it was.", more: "#how-ranked" },
  skipped: { text: "This word carried nothing. The model was too sure of it for a bit to hide in the choice.", more: "#how-gate" },
  carrier0: { text: "This word carries a 0: the model's first and second choices were about as good, and it took the first.", more: "#how-parity" },
  carrier1: { text: "This word carries a 1: a near tie again, and it took the second choice.", more: "#how-parity" },
  knock: { text: "The knock is in: a fixed pattern of bits a reader can find at any offset, so it never needs to know where the frame starts.", more: "#how-frame" },
  seal: { text: "Sealed. The checksum now covers the whole frame, and only the model that wrote it will see the bits line up.", more: "#how-frame" },
  done: { text: "Your tag is in the words. Read it back with the same model, or cut the text and watch what survives.", more: "#how-read" },
  pulled: { text: "Reading pulls each word's bit back out. Words the writer was unsure about are the ones that carry.", more: "#how-read" },
  locked: { text: "The frame validates: the checksum came out right, so these bits were planted by this model.", more: "#how-key" },
  dead: { text: "Cut the start and every later rank shifts, because each word was ranked against everything before it. Cut the end and the frame survives.", more: "#how-break" },
};

export class Callouts {
  constructor(layer) {
    this.layer = layer;         // positioned container the cards live in
    this.seen = seen();
    this.current = null;
    this.enabled = true;
  }
  reset() { this.seen = new Set(); try { localStorage.removeItem(KEY); } catch { /* ignore */ } }

  once(id, anchorEl) {
    if (!this.enabled || this.seen.has(id) || !COPY[id]) return;
    this.seen.add(id);
    this.dismiss();
    const c = COPY[id];
    const card = document.createElement("div");
    card.className = "callout";
    card.setAttribute("role", "note");
    card.innerHTML = `<div>${c.text}</div><div class="row"><button type="button">Got it</button><a href="${c.more}">How this works</a></div>`;
    card.querySelector("button").addEventListener("click", () => { remember(id); this.dismiss(); });
    this.layer.appendChild(card);
    this.place(card, anchorEl);
    requestAnimationFrame(() => card.classList.add("on"));
    this.current = card;
  }

  place(card, anchorEl) {
    const L = this.layer.getBoundingClientRect();
    const a = anchorEl?.getBoundingClientRect();
    let top = 12, left = 12;
    if (a && a.width) {
      top = a.bottom - L.top + 8;
      left = Math.max(8, Math.min(a.left - L.left, L.width - 316));
    }
    card.style.top = `${top}px`;
    card.style.left = `${left}px`;
  }

  dismiss() {
    if (!this.current) return;
    const c = this.current;
    this.current = null;
    c.classList.remove("on");
    setTimeout(() => c.remove(), 260);
  }
}
