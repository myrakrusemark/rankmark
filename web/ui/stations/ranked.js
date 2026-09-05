// Station: every word is a ranked choice. A sentence grows one word at a time;
// beside it, the model's top candidates for the next word, ranked, with the
// one it took. The temperature slider redraws the odds of each candidate from
// the recorded scores, and can rerun the sentence live at that setting.

const clamp = (v, a, b) => Math.max(a, Math.min(b, v));

export class RankedChoice {
  constructor(root, { engine, picker, snapshot, consent }) {
    Object.assign(this, { root, engine, picker, consent });
    this.q = s => root.querySelector(s);
    this.steps = snapshot?.ranked?.steps || [];
    this.prompt = snapshot?.ranked?.prompt || "It was late in the harbor when the last boat came in, and";
    this.recordedTemp = snapshot?.ranked?.temperature ?? 0.7;
    this.i = 0;
    this.timer = null;
    this.q("[data-temp]").addEventListener("input", () => this.render());
    this.q("[data-play]").addEventListener("click", () => this.play());
    this.q("[data-next]").addEventListener("click", () => { this.stop(); this.i = Math.min(this.i + 1, this.steps.length); this.render(); });
    this.q("[data-live]")?.addEventListener("click", () => this.live());
    this.q("[data-prompt]").value = this.prompt;
    if (!this.steps.length) this.q("[data-play]").disabled = true;
    this.render();
  }

  temp() { return Number(this.q("[data-temp]").value); }

  stop() { if (this.timer) { clearInterval(this.timer); this.timer = null; } this.q("[data-play]").textContent = "Watch it choose"; }

  play() {
    if (this.timer) { this.stop(); return; }
    if (this.i >= this.steps.length) this.i = 0;
    this.q("[data-play]").textContent = "Pause";
    this.timer = setInterval(() => {
      this.i++;
      this.render();
      if (this.i >= this.steps.length) this.stop();
    }, 900);
  }

  // odds of each candidate at the chosen temperature, from the recorded scores
  odds(top, t) {
    if (t <= 0) return top.map((_, k) => (k === 0 ? 1 : 0));
    const m = Math.max(...top.map(c => c.logit));
    const w = top.map(c => Math.exp((c.logit - m) / t));
    const s = w.reduce((a, b) => a + b, 0);
    return w.map(x => x / s);
  }

  render() {
    const t = this.temp();
    this.q("[data-temp-out]").textContent = t.toFixed(1);
    const sent = this.q("[data-sentence]");
    const list = this.q("[data-list]");
    const cap = this.q("[data-caption]");
    const done = this.steps.slice(0, this.i).map(s => s.piece).join("");
    sent.innerHTML = `<span class="muted">${escapeHtml(this.prompt)}</span>${escapeHtml(done)}<span class="caret"></span>`;
    const step = this.steps[this.i];
    if (!step) {
      list.innerHTML = "";
      cap.textContent = this.steps.length ? "The sentence is written. Play again, or run it live." : "Load a model and run it live to see the list.";
      return;
    }
    const p = this.odds(step.top, t);
    list.innerHTML = step.top.map((c, k) => `
      <li class="${k === step.rank ? "took" : ""}">
        <span class="rank">#${k + 1}</span>
        <span class="piece">${escapeHtml(c.piece.replace(/^ /, "␣"))}</span>
        <span class="bar"><i style="transform: scaleX(${clamp(p[k], 0, 1)})"></i></span>
        <span class="pct">${Math.round(p[k] * 100)}%</span>
      </li>`).join("");
    const chance = Math.round(p[step.rank] * 100);
    cap.textContent = t <= 0
      ? `At 0 it always takes #1. The recorded run (at ${this.recordedTemp}) took #${step.rank + 1}.`
      : `At ${t.toFixed(1)}, #${step.rank + 1} had a ${chance}% chance; the recorded run took it. Entropy here: ${step.entropy} nats.`;
  }

  async live() {
    if (!this.engine) return;
    const rung = this.picker.rung;
    if (!(await this.consent(rung))) return;
    this.stop();
    const btn = this.q("[data-live]");
    btn.disabled = true;
    this.prompt = this.q("[data-prompt]").value.trim() || this.prompt;
    this.steps = [];
    this.i = 0;
    this.render();
    try {
      await this.engine.run("sample", { rung, opts: { prompt: this.prompt, maxNew: 24, temperature: this.temp() } }, {
        onEvent: e => { if (e.type === "token") { this.steps.push({ piece: e.piece, rank: e.rank, entropy: e.entropy, top: e.top }); this.i = this.steps.length; this.render(); } },
      });
      this.recordedTemp = this.temp();
      this.q("[data-play]").disabled = false;
    } finally { btn.disabled = false; }
  }
}

function escapeHtml(s) { return s.replace(/[&<>]/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;" }[c])); }
