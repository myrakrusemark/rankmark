// Write: the model continues your opening text and hides your tag in its
// word choices. The strip on the right holds the frame; each word that
// carries a bit sends it into the frame's next cell.

import { frameLenBits, layoutOf, PROFILES } from "../engine/framing.js";
import { markCard } from "../engine/mark.js";
import { encodeMessage, messageBits } from "../engine/textcode.js";

// Keep a Unicode-safe prefix that fits the encoded payload capacity.
export function fitMessage(value, capacity) {
  let result = '';
  for (const character of value) {
    const candidate = result + character;
    if (encodeMessage(candidate.trim()).length > capacity) break;
    result = candidate;
  }
  return result;
}

const hex = bytes => [...bytes].map(b => b.toString(16).padStart(2, "0")).join("");

export class WritePanel {
  constructor(root, { engine, picker, callouts, strip, view, onDone, onText }) {
    Object.assign(this, { root, engine, picker, callouts, strip, view, onDone, onText });
    this.q = s => root.querySelector(s);
    // the pressed profile button if there is one (the tool), else the copies profile (the stations)
    this.profile = Number(root.querySelector('.seg button[aria-pressed="true"]')?.dataset.profile ?? 3);
    this.running = false;
    this.result = null;
    // one button: it starts the write, and while the model writes it reads Stop
    const run = this.q("[data-run]");
    run.dataset.label = run.textContent;
    run.addEventListener("click", () => (this.running ? this.engine.cancel() : this.run()));
    const tagInput = this.q("[data-tag]");
    const constrainTag = () => {
      if (this.tagComposing) return;
      const value = tagInput.value;
      const start = tagInput.selectionStart;
      const end = tagInput.selectionEnd;
      const limit = this.picker.rung.tagCapBytes ?? 8;
      const fitted = fitMessage(value, limit);
      if (fitted !== value) {
        tagInput.value = fitted;
        tagInput.setSelectionRange(Math.min(start ?? fitted.length, fitted.length), Math.min(end ?? fitted.length, fitted.length));
      }
      this.renderTag();
    };
    tagInput.addEventListener("beforeinput", e => {
      if (e.isComposing || !e.inputType.startsWith('insert') || e.data === null) return;
      const start = tagInput.selectionStart ?? tagInput.value.length;
      const end = tagInput.selectionEnd ?? start;
      const proposed = tagInput.value.slice(0, start) + e.data + tagInput.value.slice(end);
      if (encodeMessage(proposed.trim()).length > (this.picker.rung.tagCapBytes ?? 8)) {
        e.preventDefault();
      }
    });
    tagInput.addEventListener("paste", e => {
      if (!e.clipboardData) return;
      e.preventDefault();
      const start = tagInput.selectionStart ?? tagInput.value.length;
      const end = tagInput.selectionEnd ?? start;
      const before = tagInput.value.slice(0, start);
      const after = tagInput.value.slice(end);
      let insertion = '';
      for (const character of e.clipboardData.getData('text/plain').replace(/[\r\n]/g, '')) {
        const candidate = insertion + character;
        if (encodeMessage((before + candidate + after).trim()).length > (this.picker.rung.tagCapBytes ?? 8)) break;
        insertion = candidate;
      }
      if (insertion) tagInput.setRangeText(insertion, start, end, 'end');
      this.renderTag();
    });
    tagInput.addEventListener("compositionstart", () => { this.tagComposing = true; });
    tagInput.addEventListener("compositionend", () => { this.tagComposing = false; constrainTag(); });
    tagInput.addEventListener("input", constrainTag);
    this.q("[data-temp]")?.addEventListener("input", () => { const o = this.q("[data-temp-out]"); if (o) o.textContent = Number(this.q("[data-temp]").value).toFixed(1); });
    for (const b of root.querySelectorAll(".seg button[data-profile]")) b.addEventListener("click", () => { this.profile = Number(b.dataset.profile); this.renderProfile(); this.preview(); });
    // the pickers (temperature, copies): one pressed button per group
    for (const g of root.querySelectorAll(".seg[data-pick]")) {
      for (const b of g.querySelectorAll("button")) b.addEventListener("click", () => {
        for (const o of g.querySelectorAll("button")) o.setAttribute("aria-pressed", String(o === b));
      });
    }
    this.renderTag();
    this.renderProfile();
    this.preview();
  }

  // a picker's value, or null when the panel has no such picker
  pick(name) { return this.q(`.seg[data-pick="${name}"] button[aria-pressed="true"]`)?.dataset.value ?? null; }

  // the frame's shape for the message as typed, empty, until a write fills it
  preview() {
    if (this.running) return;
    const n = Math.max(1, this.tagBytes().length);
    this.strip.setLayout(layoutOf(n, this.profile), frameLenBits(n, this.profile));
    this.strip.setMessage(this.q("[data-tag]").value.trim());
  }

  // the message as the frame carries it: the fixed text code, about a third shorter than UTF-8
  tagBytes() { const t = this.q("[data-tag]").value.trim(); return t ? encodeMessage(t) : new Uint8Array(0); }

  renderTag() {
    const input = this.q("[data-tag]");
    const text = input.value.trim();
    const bits = text ? messageBits(text).length : 0;
    const limit = (this.picker.rung.tagCapBytes ?? 8) * 8;
    const count = [...text].length;
    this.tagInvalid = !text || bits > limit;
    const hint = this.q("[data-tag-hint]");
    hint.textContent = `${count} character${count === 1 ? '' : 's'} · ${bits}/${limit} bits${bits > limit ? ' — too long' : ''}`;
    hint.classList.toggle("warn", bits > limit);
    input.setAttribute("aria-invalid", String(bits > limit));
    input.setCustomValidity(bits > limit ? 'Shorten your message to fit the available space.' : '');
    if (!this.running) this.q("[data-run]").disabled = !!this.offLabel || this.tagInvalid;
    const capacity = this.q("[data-tag-capacity]");
    if (capacity) {
      const fill = document.createElement('span');
      fill.style.width = `${Math.min(100, bits / limit * 100)}%`;
      capacity.replaceChildren(fill);
      capacity.classList.toggle('over', bits > limit);
    }
    this.renderProfile();
    this.preview();
  }

  renderProfile() {
    const n = Math.max(1, this.tagBytes().length);
    for (const b of this.root.querySelectorAll(".seg button[data-profile]")) {
      const p = Number(b.dataset.profile);
      b.setAttribute("aria-pressed", String(p === this.profile));
      b.querySelector("small").textContent = `${frameLenBits(n, p)} bits`;
    }
  }

  // the go button follows the model: off with a note while it loads (or when
  // none is loaded), back to its own label once the model is in
  modelReady(on, label) {
    this.offLabel = on ? null : label;
    if (!this.running) this.setBusy(false);
  }

  setBusy(on) {
    this.running = on;
    const run = this.q("[data-run]");
    run.textContent = on ? "Stop" : (this.offLabel ?? run.dataset.label);
    run.disabled = !on && (!!this.offLabel || this.tagInvalid);
    run.classList.toggle("stop", on);
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

    const temperature = Number(this.pick("temp") ?? this.q("[data-temp]")?.value ?? 0.7);
    const copies = Math.max(1, Number(this.pick("copies") ?? this.q("[data-copies]")?.value ?? 1));
    const seedRaw = (this.q("[data-seed]")?.value ?? "").trim();
    const opts = { prompt, payloadHex: hex(bytes), profile: this.profile, temperature, copies, passphrase: this.q("[data-key]")?.value || "" };
    if (seedRaw) opts.seed = Number(seedRaw) >>> 0;

    this.setBusy(true);
    if (box) this.view.prime(prompt); else this.view.clear();
    this.strip.reset();
    const cardEl = this.q("[data-card]"); if (cardEl) cardEl.hidden = true;
    const notice = this.q("[data-notice]"); if (notice) notice.hidden = true;
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
            this.layout = e.layout;
            this.echo = !!e.echo;
            this.strip.setLayout(e.layout, e.frame_bits);
            this.strip.setMessage(tagText);
            const note = this.q("[data-strip-note]");
            if (note) note.innerHTML = e.echo ? `<b>${e.frame_bits} bits</b> to vote on: the model tag, your message and its seal, each word voting on the bit the words before it name.` : `<b>${e.frame_bits} bits</b> to plant: the knock, a label, your message, its seal${e.layout.some(s => s.kind === "parity" || s.kind === "woven") ? ", and repair data" : ""}.`;
          }
          if (e.type === "token") {
            tokens++;
            this.tokensOut.push({ id: e.id, carrier: e.carrier, bit: e.bit, slot: e.slot });
            const el = this.view.append(e);
            this.onText?.(this.view.root.textContent);
            if (!sawFirst) { sawFirst = true; this.callouts.once("first", el); }
            if (e.carrier) {
              carriers++;
              this.strip.plant(e.bit, el, e.slot);
              if (!sawCarrier[e.bit]) { sawCarrier[e.bit] = true; this.callouts.once(e.bit ? "carrier1" : "carrier0", el); }
              planted++;
              if (planted === (this.strip.cells.findIndex(c => c.dataset.kind !== "sync"))) this.callouts.once("knock", this.strip.root);
              if (planted === frameBits) this.callouts.once("seal", this.strip.root);
            } else if (!sawNull && tokens > 3) { sawNull = true; this.callouts.once("skipped", el); }
            const s = (performance.now() - t0) / 1000;
            const rate = tokens / Math.max(s, 0.001);
            const need = Math.max(0, Math.ceil((frameBits - planted) / Math.max(carriers / tokens, 0.05)));
            const wanted = frameBits * copies;
            const minVotes = this.strip.cells.length ? Math.min(...this.strip.cells.map(c => Number(c.dataset.votes) || 0)) : 0;
            const covered = this.strip.cells.filter(c => Number(c.dataset.votes) > 0).length;
            const done = this.echo ? minVotes >= copies : planted >= wanted;
            const progress = this.echo
              ? (done ? `every bit has ${copies} vote${copies === 1 ? "" : "s"}` : `${covered} of ${frameBits} bits voted on, ${planted} votes`)
              : copies > 1
                ? (done ? `${copies} copies planted` : `copy ${Math.floor(planted / frameBits) + 1} of ${copies}: ${planted % frameBits} of ${frameBits} bits`)
                : `${Math.min(planted, frameBits)} of ${frameBits} bits`;
            const left = Math.max(0, Math.ceil(((this.echo ? wanted * 1.6 : wanted) - planted) / Math.max(carriers / tokens, 0.05)));
            meter.textContent = `${rate.toFixed(1)} words/s · ${progress} · ${done ? "finishing the sentence" : `about ${Math.ceil(left / Math.max(rate, 0.1))} s to go`}`;
          }
        },
      });
      if (res.cancelled) { head.textContent = "stopped"; meter.textContent = ""; if (copyBtn) copyBtn.hidden = true; return; }
      this.result = res;
      meter.textContent = "";
      if (this.echo ? res.framesPlanted < 1 : planted < frameBits) {
        // the model settled into text it could predict and the free choices ran
        // out before the frame closed: say so, and offer another go
        head.textContent = `${tokens} tokens, ${planted} of ${frameBits} bits planted: the frame did not close`;
        if (copyBtn) copyBtn.hidden = true;
        if (notice) {
          notice.innerHTML = `The model drifted into text it could predict almost word for word, so it ran out of free choices to hide bits in after ${planted} of ${frameBits}. There is no finished mark in this text. The small model does this about one run in six; write it again, change the opening, or nudge the temperature up.<div class="btn-row" style="margin-top: 10px"><button type="button" class="btn primary" data-again>Write it again</button></div>`;
          notice.hidden = false;
          notice.querySelector("[data-again]").onclick = () => this.run();
        }
        this.onDone?.({ card: null, text: res.text, tag: tagText, mode: "stalled", tokens: this.tokensOut, result: res, planted, frameBits });
        return;
      }
      head.textContent = `${tokens} tokens, ${carriers} carry bits, ${res.framesPlanted.toFixed(1)} copies of the frame`;
      const card = markCard(res.text, res.lens, res.fingerprint, res.textHash, !!opts.passphrase);
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
      this.onDone?.({ card, text: res.text, tag: tagText, mode: "done", tokens: this.tokensOut, result: res, layout: this.layout, frameBits, rung: rung.id, echo: this.echo });
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
