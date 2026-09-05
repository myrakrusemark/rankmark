// Station: every word is a ranked choice. A sentence grows one word at a time;
// on the right, the model's top candidates for the next word with their odds
// at the chosen temperature. When the word is chosen its row lights up and the
// word flies into the sentence. The recorded run plays without a model; "run
// it live" samples the opening with the loaded model and lands each word as
// the engine picks it.

const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
const wait = ms => new Promise(r => setTimeout(r, ms));
const prefersReduced = () => matchMedia("(prefers-reduced-motion: reduce)").matches;

export class RankedChoice {
  constructor(root, { engine, picker, snapshot, consent }) {
    Object.assign(this, { root, engine, picker, consent });
    this.q = s => root.querySelector(s);
    this.steps = snapshot?.ranked?.steps || [];
    this.prompt = snapshot?.ranked?.prompt || "It was late in the harbor when the last boat came in, and";
    this.recordedTemp = snapshot?.ranked?.temperature ?? 0.7;
    this.i = 0;           // words landed in the sentence
    this.shown = null;    // the step whose list is on the right
    this.chosen = false;  // whether that list has its pick lit
    this.playing = false;
    this.busy = false;
    this.q("[data-temp]").addEventListener("input", () => this.renderList());
    this.q("[data-play]").addEventListener("click", () => this.play());
    this.q("[data-next]").addEventListener("click", () => this.next());
    this.q("[data-live]")?.addEventListener("click", () => this.live());
    this.q("[data-prompt]").value = this.prompt;
    this.enable(!!this.steps.length);
    this.renderSentence();
    this.showList(0, false);
  }

  temp() { return Number(this.q("[data-temp]").value); }
  enable(on) { this.q("[data-play]").disabled = !on; this.q("[data-next]").disabled = !on; }

  // odds of each candidate at the chosen temperature, from the recorded scores
  odds(top, t) {
    if (t <= 0) return top.map((_, k) => (k === 0 ? 1 : 0));
    const m = Math.max(...top.map(c => c.logit));
    const w = top.map(c => Math.exp((c.logit - m) / t));
    const s = w.reduce((a, b) => a + b, 0);
    return w.map(x => x / s);
  }

  renderSentence() {
    const done = this.steps.slice(0, this.i).map(s => s.piece).join("");
    this.q("[data-sentence]").innerHTML = `<span class="muted">${escapeHtml(this.prompt)}</span><span data-done>${escapeHtml(done)}</span><span class="caret"></span>`;
  }

  showList(k, chosen) { this.shown = k; this.chosen = chosen; this.renderList(); }

  renderList() {
    const t = this.temp();
    this.q("[data-temp-out]").textContent = t.toFixed(1);
    const list = this.q("[data-list]"), cap = this.q("[data-caption]"), head = this.q("[data-list-head]");
    const step = this.steps[this.shown];
    if (!step) {
      list.innerHTML = "";
      list.classList.remove("chosen");
      head.textContent = "the model's top 8 for the next word";
      cap.textContent = this.steps.length ? "The sentence is written. Play again, or run it live." : "Run it live to see the list.";
      return;
    }
    const p = this.odds(step.top, t);
    head.textContent = `word ${this.shown + 1}: the model's top ${step.top.length}`;
    list.classList.toggle("chosen", this.chosen);
    list.innerHTML = step.top.map((c, k) => `
      <li class="${this.chosen && k === step.rank ? "took" : ""}">
        <span class="rank">#${k + 1}</span>
        <span class="piece">${escapeHtml(c.piece.replace(/^ /, "␣"))}</span>
        <span class="bar"><i style="transform: scaleX(${clamp(p[k], 0, 1)})"></i></span>
        <span class="pct">${Math.round(p[k] * 100)}%</span>
      </li>`).join("");
    const ent = Number(step.entropy).toFixed(2);
    let text;
    if (!this.chosen) text = `Which word comes next? At ${t.toFixed(1)}, #1 has a ${Math.round(p[0] * 100)}% chance. Entropy here: ${ent} nats.`;
    else if (t <= 0) text = `At 0 it always takes #1. This run (at ${this.recordedTemp}) took #${step.rank + 1}.`;
    else text = `At ${t.toFixed(1)}, #${step.rank + 1} had a ${Math.round(p[step.rank] * 100)}% chance, and it took it. Entropy here: ${ent} nats.`;
    if (this.chosen && this.i >= this.steps.length && !this.playing && !this.busy) text += " The sentence is written; play again, or run it live.";
    cap.textContent = text;
  }

  // land word k: show its list, light the pick after a beat, fly it into the sentence
  async choose(k, beat = 600, flyMs = 320) {
    const step = this.steps[k];
    if (!step) return;
    this.busy = true;
    try {
      if (this.shown !== k || this.chosen) this.showList(k, false);
      if (beat) await wait(beat);
      this.showList(k, true);
      await this.fly(k, flyMs);
      this.i = k + 1;
      this.renderSentence();
      if (this.steps[k + 1]) this.showList(k + 1, false);
    } finally {
      this.busy = false;
      if (!this.steps[k + 1]) this.renderList();
    }
  }

  fly(k, ms) {
    return new Promise(resolve => {
      const row = this.q("[data-list]").children[this.steps[k].rank];
      const from = row?.querySelector(".piece"), to = this.q("[data-sentence] .caret");
      if (!from || !to || prefersReduced()) return resolve();
      const a = from.getBoundingClientRect(), b = to.getBoundingClientRect();
      if (!a.width || !b.height) return resolve();
      const el = document.createElement("span");
      el.className = "fly-word";
      el.textContent = this.steps[k].piece.trim() || this.steps[k].piece;
      el.style.left = `${a.left}px`;
      el.style.top = `${a.top}px`;
      document.body.appendChild(el);
      const dx = b.left - a.left, dy = (b.top + b.height / 2) - (a.top + a.height / 2);
      const anim = el.animate(
        [{ transform: "translate(0,0)", opacity: 1 }, { transform: `translate(${dx}px, ${dy}px)`, opacity: 0.85 }],
        { duration: ms, easing: "cubic-bezier(0.16, 1, 0.3, 1)", fill: "forwards" },
      );
      anim.onfinish = () => { el.remove(); resolve(); };
    });
  }

  stop() { this.playing = false; this.q("[data-play]").textContent = "Watch it choose"; }

  async play() {
    if (this.playing) { this.stop(); return; }
    if (this.busy) return;
    if (this.i >= this.steps.length) { this.i = 0; this.renderSentence(); this.showList(0, false); }
    this.playing = true;
    this.q("[data-play]").textContent = "Pause";
    while (this.playing && this.i < this.steps.length) await this.choose(this.i);
    this.stop();
    this.renderList();
  }

  async next() {
    if (this.busy) return;
    this.stop();
    if (this.i >= this.steps.length) { this.i = 0; this.renderSentence(); this.showList(0, false); return; }
    await this.choose(this.i, 350);
  }

  async live() {
    if (!this.engine) return;
    const rung = this.picker.rung;
    if (!(await this.consent(rung))) return;
    this.stop();
    const btn = this.q("[data-live]");
    btn.disabled = true;
    this.enable(false);
    this.prompt = this.q("[data-prompt]").value.trim() || this.prompt;
    this.steps = [];
    this.i = 0;
    this.renderSentence();
    this.showList(0, false);
    // words land in order as the engine picks them; when the engine runs ahead
    // of the animation, the landings speed up to catch it
    let queue = Promise.resolve(), pending = 0;
    const land = k => {
      pending++;
      queue = queue.then(async () => { const rush = pending > 3; await this.choose(k, rush ? 0 : 250, rush ? 160 : 320); pending--; });
    };
    try {
      await this.engine.run("sample", { rung, opts: { prompt: this.prompt, maxNew: 24, temperature: this.temp() } }, {
        onEvent: e => { if (e.type === "token") { this.steps.push({ piece: e.piece, rank: e.rank, entropy: e.entropy, top: e.top }); land(this.steps.length - 1); } },
      });
      await queue;
      this.recordedTemp = this.temp();
    } finally {
      btn.disabled = false;
      this.enable(!!this.steps.length);
      this.renderList();
    }
  }
}

function escapeHtml(s) { return s.replace(/[&<>]/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;" }[c])); }
