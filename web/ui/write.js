// Write: the model continues your opening text and hides your tag in its
// word choices. The strip on the right holds the frame; each bit leaves it
// for the word that carries it.

import { frameLenBits, PROFILES } from "../engine/framing.js";
import { markCard } from "../engine/fingerprint.js";

const utf8 = new TextEncoder();
const hex = bytes => [...bytes].map(b => b.toString(16).padStart(2, "0")).join("");

export class WritePanel {
  constructor(root, { engine, picker, callouts, strip, view, onDone }) {
    Object.assign(this, { root, engine, picker, callouts, strip, view, onDone });
    this.q = s => root.querySelector(s);
    this.profile = 0;
    this.running = false;
    this.result = null;
    this.q("[data-run]").addEventListener("click", () => this.run());
    this.q("[data-stop]").addEventListener("click", () => this.engine.cancel());
    this.q("[data-tag]").addEventListener("input", () => this.renderTag());
    this.q("[data-temp]")?.addEventListener("input", () => { const o = this.q("[data-temp-out]"); if (o) o.textContent = Number(this.q("[data-temp]").value).toFixed(1); });
    for (const b of root.querySelectorAll(".seg button")) b.addEventListener("click", () => { this.profile = Number(b.dataset.profile); this.renderProfile(); });
    this.renderTag();
    this.renderProfile();
  }

  tagBytes() { return utf8.encode(this.q("[data-tag]").value.trim()); }

  renderTag() {
    const n = this.tagBytes().length;
    const cap = this.picker.rung.tagCapBytes ?? 8;
    const hint = this.q("[data-tag-hint]");
    hint.textContent = n === 0 ? `up to ${cap} bytes with this model` : `${n} byte${n === 1 ? "" : "s"} of ${cap}`;
    hint.classList.toggle("warn", n > cap);
    this.renderProfile();
  }

  renderProfile() {
    const n = Math.max(1, this.tagBytes().length);
    for (const b of this.root.querySelectorAll(".seg button")) {
      const p = Number(b.dataset.profile);
      b.setAttribute("aria-pressed", String(p === this.profile));
      b.querySelector("small").textContent = `${frameLenBits(n, p)} bits`;
    }
  }

  setBusy(on) {
    this.running = on;
    this.q("[data-run]").hidden = on;
    this.q("[data-stop]").hidden = !on;
    this.root.querySelectorAll("input, textarea, select, .seg button").forEach(el => { el.disabled = on; });
    // the one-box layout: the opening box locks while the model writes into it
    const box = this.q("[data-box-edit]");
    if (box) { box.contentEditable = String(!on); if (on) box.blur(); }
  }

  progress(p) {
    const box = this.q(".progress");
    box.classList.add("on");
    const frac = p.total ? p.loaded / p.total : 0;
    box.querySelector("i").style.transform = `scaleX(${frac})`;
    box.querySelector("b").textContent = `${Math.round(frac * 100)}%`;
  }

  async run() {
    const rung = this.picker.rung;
    const bytes = this.tagBytes();
    if (!bytes.length) { this.q("[data-tag]").focus(); return; }
    if (bytes.length > (rung.tagCapBytes ?? 8)) { this.q("[data-tag]").focus(); return; }
    // the opening comes from the one box when there is one, else the textarea
    const box = this.q("[data-box-edit]");
    const prompt = (box ? box.textContent : this.q("[data-prompt]").value).trim();
    if (!prompt) { (box || this.q("[data-prompt]")).focus(); return; }
    if (!(await this.picker.consent(rung))) return;

    const temperature = Number(this.q("[data-temp]")?.value ?? 0.7);
    const seedRaw = (this.q("[data-seed]")?.value ?? "").trim();
    const opts = { prompt, payloadHex: hex(bytes), profile: this.profile, temperature };
    if (seedRaw) opts.seed = Number(seedRaw) >>> 0;

    this.setBusy(true);
    if (box) this.view.prime(prompt); else this.view.clear();
    this.strip.reset();
    const cardEl = this.q("[data-card]"); if (cardEl) cardEl.hidden = true;
    // the copy button shows from the start, disabled until the text is done
    const copyBtn = this.q("[data-copy]");
    if (copyBtn) { copyBtn.dataset.label ??= copyBtn.textContent; copyBtn.hidden = false; copyBtn.disabled = true; copyBtn.textContent = "Generating…"; }
    const head = this.q("[data-head]");
    const meter = this.q("[data-meter]");
    head.textContent = "";
    meter.textContent = "";
    let tokens = 0, carriers = 0, t0 = 0, frameBits = 0, contextTokens = 0, sawCarrier = { 0: false, 1: false }, sawNull = false, sawFirst = false, planted = 0;
    this.tokensOut = [];
    const tagText = this.q("[data-tag]").value.trim();

    try {
      const res = await this.engine.run("embed", { rung, opts }, {
        onProgress: p => this.progress(p),
        onReady: () => { this.q(".progress").classList.remove("on"); head.textContent = `${rung.id.replace(/-Q.*$/, "")} is writing`; t0 = performance.now(); },
        onEvent: e => {
          if (e.type === "start") {
            frameBits = e.frame_bits; contextTokens = e.context_tokens;
            this.strip.setLayout(e.layout, e.frame_bits);
            this.strip.setMessage(tagText);
            this.q("[data-strip-note]").innerHTML = `<b>${e.frame_bits} bits</b> to plant: the knock, a label, your message, its seal${e.layout.some(s => s.kind === "parity" || s.kind === "woven") ? ", and repair data" : ""}.`;
          }
          if (e.type === "token") {
            tokens++;
            this.tokensOut.push({ id: e.id, carrier: e.carrier, bit: e.bit });
            const el = this.view.append(e);
            if (!sawFirst) { sawFirst = true; this.callouts.once("first", el); }
            if (e.carrier) {
              carriers++;
              this.strip.plant(e.bit, el);
              if (!sawCarrier[e.bit]) { sawCarrier[e.bit] = true; this.callouts.once(e.bit ? "carrier1" : "carrier0", el); }
              planted++;
              if (planted === (this.strip.cells.findIndex(c => c.dataset.kind !== "sync"))) this.callouts.once("knock", this.strip.root);
              if (planted === frameBits) this.callouts.once("seal", this.strip.root);
            } else if (!sawNull && tokens > 3) { sawNull = true; this.callouts.once("skipped", el); }
            const s = (performance.now() - t0) / 1000;
            const rate = tokens / Math.max(s, 0.001);
            const need = Math.max(0, Math.ceil((frameBits - planted) / Math.max(carriers / tokens, 0.05)));
            meter.textContent = `${rate.toFixed(1)} words/s · ${Math.min(planted, frameBits)} of ${frameBits} bits · ${planted >= frameBits ? "frame planted, finishing the sentence" : `about ${Math.ceil(need / Math.max(rate, 0.1))} s to go`}`;
          }
        },
      });
      if (res.cancelled) { head.textContent = "stopped"; meter.textContent = ""; if (copyBtn) copyBtn.hidden = true; return; }
      this.result = res;
      head.textContent = `${tokens} words, ${carriers} carry bits, ${res.framesPlanted.toFixed(1)} copies of the frame`;
      meter.textContent = "";
      const card = markCard(res.text, res.lens, res.fingerprint, res.textHash);
      if (cardEl) {
        this.q("[data-card-text]").textContent = res.text;
        this.q("[data-card-foot]").textContent = card.slice(res.text.length + 2);
        cardEl.hidden = false;
      }
      const copy = this.q("[data-copy]");
      if (copy) {
        const label = copy.dataset.label;
        copy.disabled = false;
        copy.textContent = label;
        copy.onclick = async () => { try { await navigator.clipboard.writeText(card); copy.textContent = "Copied"; setTimeout(() => copy.textContent = label, 1500); } catch { /* clipboard blocked */ } };
      }
      const rd = this.q("[data-read]"); if (rd) rd.onclick = () => this.onDone?.({ card, text: res.text, tag: tagText, mode: "read" });
      const br = this.q("[data-break]"); if (br) br.onclick = () => this.onDone?.({ card, text: res.text, tag: tagText, mode: "break" });
      this.onDone?.({ card, text: res.text, tag: tagText, mode: "done", tokens: this.tokensOut, result: res });
      if (cardEl) this.callouts.once("done", cardEl);
    } catch (err) {
      head.textContent = `could not write: ${err.message}`;
      if (copyBtn) copyBtn.hidden = true;
    } finally {
      this.setBusy(false);
      this.q(".progress").classList.remove("on");
    }
  }
}
