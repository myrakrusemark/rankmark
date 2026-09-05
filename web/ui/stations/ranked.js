// Station: every word is a ranked choice. A sentence grows one word at a time;
// on the right, the model's top candidates for the next word with their odds
// at the chosen temperature. When the word is chosen its row lights up and the
// word flies into the sentence. No controls: it runs on its own whenever it is
// in view and waits when it is not. It starts on the recorded run; when the
// page's model comes in it writes its own sentence in one short job, and that
// sentence takes over at the next pass. The model is shared with every other
// station, so this one never holds it: the words are taken all at once and only
// the animation pauses.

const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
const wait = ms => new Promise(r => setTimeout(r, ms));
const prefersReduced = () => matchMedia("(prefers-reduced-motion: reduce)").matches;

export class RankedChoice {
  constructor(root, { engine, snapshot }) {
    Object.assign(this, { root, engine });
    this.q = s => root.querySelector(s);
    this.steps = snapshot?.ranked?.steps || [];
    this.prompt = snapshot?.ranked?.prompt || "It was late in the harbor when the last boat came in, and";
    this.recordedTemp = snapshot?.ranked?.temperature ?? 0.7;
    this.source = this.steps.length ? "a recorded run" : "";
    this.pending = null;   // the model's own sentence, waiting for the next pass
    this.i = 0;            // words landed in the sentence
    this.shown = null;     // the step whose list is on the right
    this.chosen = false;   // whether that list has its pick lit
    this.busy = false;
    this.looping = false;
    this.ran = false;
    this.visible = false;
    this.waiters = [];
    this.q("[data-temp]").addEventListener("input", () => this.renderList());
    this.renderSentence();
    this.showList(0, false);
    this.renderSource();
    // out of view, the loop waits before the next word
    new IntersectionObserver(([e]) => {
      this.visible = e.isIntersecting;
      if (this.visible) { const w = this.waiters; this.waiters = []; for (const r of w) r(); }
    }, { threshold: 0.25 }).observe(root);
    if (this.steps.length) this.loop();
  }

  temp() { return Number(this.q("[data-temp]").value); }
  whenVisible() { return this.visible ? Promise.resolve() : new Promise(r => this.waiters.push(r)); }

  // odds of each candidate at the chosen temperature, from the recorded scores
  odds(top, t) {
    if (t <= 0) return top.map((_, k) => (k === 0 ? 1 : 0));
    const m = Math.max(...top.map(c => c.logit));
    const w = top.map(c => Math.exp((c.logit - m) / t));
    const s = w.reduce((a, b) => a + b, 0);
    return w.map(x => x / s);
  }

  renderSource() { this.q("[data-source]").textContent = this.source; }

  renderSentence() {
    const done = this.steps.slice(0, this.i).map(s => s.piece).join("");
    this.q("[data-sentence]").innerHTML = `<span class="muted">${escapeHtml(this.prompt)}</span><span data-done>${escapeHtml(done)}</span><span class="caret"></span>`;
  }

  showList(k, chosen) { this.shown = k; this.chosen = chosen; this.renderList(); }

  renderList() {
    const t = this.temp();
    this.q("[data-temp-out]").textContent = t.toFixed(1);
    const list = this.q("[data-list]"), head = this.q("[data-list-head]");
    const step = this.steps[this.shown];
    if (!step) {
      list.innerHTML = "";
      list.classList.remove("chosen");
      head.textContent = "the model's top 8 for the next word";
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
  }

  // land word k: show its list, light the pick after a beat, fly it into the sentence
  async choose(k, beat = 600, flyMs = 320) {
    const step = this.steps[k];
    if (!step) return;
    await this.whenVisible();
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

  // one pass after another: land every word, hold, take the model's sentence if
  // it has arrived, start again
  async loop() {
    if (this.looping) return;
    this.looping = true;
    for (;;) {
      if (this.pending) { this.steps = this.pending; this.pending = null; this.renderSource(); }
      this.i = 0;
      this.renderSentence();
      this.showList(0, false);
      while (this.i < this.steps.length) await this.choose(this.i);
      await this.whenVisible();
      await wait(4000);
    }
  }

  // the model's own sentence, once, when a model is in. With a recorded pass
  // playing, the words wait for the next pass; with nothing to show yet they
  // land as the engine picks them
  async live(rung) {
    if (!this.engine || this.ran) return;
    this.ran = true;
    const name = rung.id.replace(/-Q.*$/, "");
    const steps = [];
    const asTheyCome = !this.steps.length;
    let queue = Promise.resolve(), pendingLandings = 0;
    const land = k => {
      pendingLandings++;
      queue = queue.then(async () => { const rush = pendingLandings > 3; await this.choose(k, rush ? 0 : 250, rush ? 160 : 320); pendingLandings--; });
    };
    if (asTheyCome) {
      this.steps = steps;
      this.source = `${name}, writing on this computer`;
      this.renderSource();
    }
    try {
      await this.engine.run("sample", { rung, opts: { prompt: this.prompt, maxNew: 24, temperature: this.temp() } }, {
        onEvent: e => { if (e.type === "token") { steps.push({ piece: e.piece, rank: e.rank, entropy: e.entropy, top: e.top }); if (asTheyCome) land(steps.length - 1); } },
      });
    } catch { this.ran = false; return; }
    if (!steps.length) { this.ran = false; return; }
    this.recordedTemp = this.temp();
    this.source = `${name} wrote this on your computer`;
    if (asTheyCome) { await queue; this.renderSource(); this.loop(); }
    else this.pending = steps;
  }
}

function escapeHtml(s) { return s.replace(/[&<>]/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;" }[c])); }
