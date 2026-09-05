// Replay a recorded run: the same strip and text motion, no model, no
// download. What a phone gets, and what a first visit can watch before
// deciding to download anything.

import { layoutOf } from "../engine/framing.js";

export class Replay {
  constructor({ strip, view, callouts }) { Object.assign(this, { strip, view, callouts }); this.stop = false; }

  cancel() { this.stop = true; }

  async write(snap, head, msPerToken = 70) {
    this.stop = false;
    this.view.clear();
    const layout = layoutOf(snap.opts.payloadHex.length / 2, snap.opts.profile);
    this.strip.setLayout(layout, snap.frameBits);
    head.textContent = `${snap.rung.replace(/-Q.*$/, "")} wrote this on ${snap.generated.slice(0, 10)}; replaying`;
    const note = document.querySelector("#panel-write [data-strip-note]");
    if (note) note.innerHTML = `<b>${snap.frameBits} bits</b> to plant: the knock, a label, the tag, its seal.`;
    let first = false, null1 = false, c0 = false, c1 = false, planted = 0;
    for (const t of snap.write.tokens) {
      if (this.stop) return;
      const el = this.view.append(t);
      if (!first) { first = true; this.callouts.once("first", el); }
      if (t.carrier) {
        this.strip.plant(t.bit, el);
        planted++;
        if (t.bit && !c1) { c1 = true; this.callouts.once("carrier1", el); }
        if (!t.bit && !c0) { c0 = true; this.callouts.once("carrier0", el); }
        if (planted === snap.frameBits) this.callouts.once("seal", this.strip.root);
      } else if (!null1) { null1 = true; this.callouts.once("skipped", el); }
      await wait(msPerToken);
    }
    head.textContent = `${snap.write.tokens.length} words, ${snap.write.tokens.filter(t => t.carrier).length} carry bits`;
  }

  async read(snap, head, msPerToken = 40) {
    this.stop = false;
    this.view.clear();
    this.strip.growMode();
    head.textContent = `${snap.rung.replace(/-Q.*$/, "")} reads it back; replaying`;
    const lockAt = snap.read.frameEvents[0]?.at ?? Infinity;
    let i = 0, pulled = false;
    for (const t of snap.read.tokens) {
      if (this.stop) return;
      const el = this.view.append(t);
      if (t.carrier) { this.strip.pull(t.bit, el); if (!pulled) { pulled = true; this.callouts.once("pulled", el); } }
      i++;
      if (i === lockAt) { this.strip.lockSpans(snap.read.spans || []); this.callouts.once("locked", this.strip.root); }
      await wait(msPerToken);
    }
    if (snap.read.valid) this.strip.lockSpans(snap.read.spans || []);
    head.textContent = `${snap.read.tokens.length} words, ${snap.read.carriers} carry bits`;
    return snap.read;
  }
}

const wait = ms => new Promise(r => setTimeout(r, ms));
