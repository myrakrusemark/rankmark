// Read: paste marked text, pick the model, and watch the bits come back out
// of the words into the strip until the frame locks or fails to. Break-it
// edits the text in place and reads again.

import { parseMarkCard } from "../engine/fingerprint.js";

export class ReadPanel {
  constructor(root, { engine, picker, callouts, strip, view }) {
    Object.assign(this, { root, engine, picker, callouts, strip, view });
    this.q = s => root.querySelector(s);
    this.original = null;   // the text before any break-it edit
    this.running = false;
    this.q("[data-run]").addEventListener("click", () => this.run());
    this.q("[data-stop]").addEventListener("click", () => this.engine.cancel());
    for (const b of root.querySelectorAll("[data-break]")) b.addEventListener("click", () => this.breakIt(b.dataset.break));
    this.q("[data-lineup]").addEventListener("click", () => this.lineup());
  }

  load(card) {
    this.q("[data-paste]").value = card;
    this.original = card;
  }

  setBusy(on) {
    this.running = on;
    this.q("[data-run]").hidden = on;
    this.q("[data-stop]").hidden = !on;
    this.root.querySelectorAll("[data-break], [data-lineup], select").forEach(el => { el.disabled = on; });
  }

  verdict(kind, html) {
    const v = this.q("[data-verdict]");
    v.className = `verdict ${kind}`;
    v.innerHTML = html;
    v.hidden = false;
  }

  async run({ rung = this.picker.rung, quiet = false } = {}) {
    const raw = this.q("[data-paste]").value;
    if (!raw.trim()) { this.q("[data-paste]").focus(); return null; }
    if (!(await this.picker.consent(rung))) return null;
    if (this.original === null) this.original = raw;
    this.setBusy(true);
    this.view.clear();
    this.strip.growMode();
    this.q("[data-verdict]").hidden = true;
    const head = this.q("[data-head]");
    head.textContent = "";
    let carriers = 0, sawPull = false, locked = false;
    try {
      const res = await this.engine.run("decode", { rung, text: raw, opts: {} }, {
        onProgress: p => { head.textContent = `downloading ${Math.round(100 * p.loaded / p.total)}%`; },
        onReady: () => { head.textContent = `${rung.id.replace(/-Q.*$/, "")} is reading`; },
        onEvent: e => {
          if (e.type === "notice" && !quiet) {
            if (e.altered) this.verdict("warn", "This text differs from what was written: the footer's hash does not match. Whatever follows is about the edited text.");
            else if (e.fpMismatch) this.verdict("warn", `Written with <b>${e.cardLens}</b>, read with <b>${rung.id}</b>. Only the writer's model can see its own bits.`);
          }
          if (e.type === "token") {
            const el = this.view.append(e);
            if (e.carrier) {
              carriers++;
              this.strip.pull(e.bit, el);
              if (!sawPull && !quiet) { sawPull = true; this.callouts.once("pulled", el); }
            }
          }
          if (e.type === "partial") this.strip.paintSpans(e.spans);
          if (e.type === "frame" && !locked) { locked = true; this.strip.lockSpans(e.spans); if (!quiet) this.callouts.once("locked", this.strip.root); }
        },
      });
      if (res.cancelled) { head.textContent = "stopped"; return null; }
      head.textContent = `${this.view.tokens.length} words, ${carriers} carry bits`;
      if (res.valid) {
        this.strip.lockSpans(res.spans || []);
        const tag = hexToText(res.payload);
        this.verdict("ok", `A frame planted with <b>${rung.id.replace(/-Q.*$/, "")}</b> validates in this text.<span class="tag">${tag}</span>`);
      } else if (!this.q("[data-verdict]").classList.contains("warn") || this.q("[data-verdict]").hidden) {
        this.verdict("no", `No frame validates under <b>${rung.id.replace(/-Q.*$/, "")}</b>. That means one of: unmarked text, another model wrote it, or the words were changed after writing.`);
      }
      return res;
    } catch (err) {
      head.textContent = `could not read: ${err.message}`;
      return null;
    } finally {
      this.setBusy(false);
    }
  }

  // edit the text in place, then read again
  async breakIt(kind) {
    if (this.running) await this.engine.cancel();
    const ta = this.q("[data-paste]");
    const card = parseMarkCard(ta.value);
    let text = card ? card.text : ta.value;
    const foot = card ? ta.value.slice(text.length) : "";
    if (kind === "undo") { if (this.original !== null) ta.value = this.original; this.strip.reset?.(); return this.run(); }
    if (kind === "sentence") {
      const parts = text.split(/(?<=[.!?])\s+/);
      if (parts.length > 2) { parts.splice(1, 1); text = parts.join(" "); }
    }
    if (kind === "start") text = text.slice(text.indexOf(" ", Math.floor(text.length * 0.2)) + 1);
    if (kind === "end") text = text.slice(0, text.lastIndexOf(" ", Math.floor(text.length * 0.8)));
    if (kind === "swap") {
      const words = text.split(" ");
      for (let k = 0; k < 5 && words.length > 6; k++) {
        const i = 1 + Math.floor(Math.random() * (words.length - 3));
        [words[i], words[i + 1]] = [words[i + 1], words[i]];
      }
      text = words.join(" ");
    }
    ta.value = text + foot;
    const res = await this.run({ quiet: true });
    if (res && !res.valid) { this.strip.kill(); this.callouts.once("dead", this.strip.root); }
    return res;
  }

  // every downloaded model reads the same text
  async lineup() {
    const ids = [...this.picker.cached.keys()];
    const box = this.q("[data-lineup-out]");
    if (ids.length < 2) { box.innerHTML = `<p class="note">Download a second model to line them up. Only the writer's model should validate.</p>`; box.hidden = false; return; }
    box.hidden = false;
    box.innerHTML = `<table><tr><th>model</th><th>bits carried</th><th>verdict</th></tr></table>`;
    const table = box.querySelector("table");
    for (const id of ids) {
      const rung = this.picker.registry.rungs.find(r => r.id === id);
      const res = await this.run({ rung, quiet: true });
      const tr = document.createElement("tr");
      tr.innerHTML = `<td>${id.replace(/-Q.*$/, "")}</td><td>${res ? res.carriers : "?"}</td><td>${res && res.valid ? `validates: ${hexToText(res.payload)}` : "no frame"}</td>`;
      table.appendChild(tr);
    }
  }
}

function hexToText(hexStr) {
  if (!hexStr) return "";
  const bytes = new Uint8Array(hexStr.match(/../g).map(h => parseInt(h, 16)));
  try { return new TextDecoder("utf-8", { fatal: true }).decode(bytes); } catch { return "0x" + hexStr; }
}
