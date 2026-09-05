// Station: every word is a ranked choice. The visitor gives an opening and a
// temperature and starts it; the page's model writes the next 24 words. For
// each word the list on the right shows the model's top candidates with their
// odds at that temperature, the pick lights up, and the word flies into the
// sentence. Words land as the engine picks them and the landing pauses while
// the station is out of view. The model is shared with every other station,
// so this is one short job. Without a model (phones) the button plays the
// recorded run from the snapshot.

const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
const wait = ms => new Promise(r => setTimeout(r, ms));
const prefersReduced = () => matchMedia("(prefers-reduced-motion: reduce)").matches;
const WORDS = 24;

export class RankedChoice {
  constructor(root, { engine, picker, snapshot, consent }) {
    Object.assign(this, { root, engine, picker, consent });
    this.q = s => root.querySelector(s);
    this.recorded = snapshot?.ranked || null;
    this.prompt = this.recorded?.prompt || "It was late in the harbor when the last boat came in, and";
    this.steps = [];
    this.i = 0;            // words landed in the sentence
    this.shown = null;     // the step whose list is on the right
    this.chosen = false;   // whether that list has its pick lit
    this.source = "";
    this.busy = false;
    this.running = false;
    this.visible = false;
    this.waiters = [];
    const prompt = this.q("[data-prompt]"), btn = this.q("[data-start]");
    prompt.value = this.prompt;
    if (engine) {
      this.ready(false, "Loading the model");   // app.js enables it when the model is in
    } else {
      prompt.readOnly = true;
      btn.textContent = "Watch a recorded run";
      btn.disabled = !this.recorded;
    }
    this.q("[data-temp]").addEventListener("input", () => this.renderList());
    btn.addEventListener("click", () => this.start());
    this.renderList();
    // out of view, the landing waits before the next word
    new IntersectionObserver(([e]) => {
      this.visible = e.isIntersecting;
      if (this.visible) { const w = this.waiters; this.waiters = []; for (const r of w) r(); }
    }, { threshold: 0.25 }).observe(root);
  }

  temp() { return Number(this.q("[data-temp]").value); }

  // the start button follows the model: off while it loads or after a cancel
  ready(on, label) {
    const btn = this.q("[data-start]");
    btn.disabled = !on || this.running;
    btn.textContent = label || (this.steps.length ? "Write it again" : `Write the next ${WORDS} words`);
  }

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

  async start() {
    if (this.running) return;
    this.running = true;
    const btn = this.q("[data-start]");
    btn.disabled = true;
    this.steps = [];
    this.i = 0;
    this.q("[data-sentence]").hidden = false;
    try {
      if (this.engine) await this.live(btn);
      else await this.replay();
    } finally {
      this.running = false;
      if (this.engine) this.ready(true);
      else { btn.disabled = false; btn.textContent = "Watch it again"; }
      this.renderSource();
    }
  }

  // the page's model writes the next words from the opening at the slider's
  // temperature; each word lands as the engine picks it, faster when the
  // engine runs ahead of the animation
  async live(btn) {
    const rung = this.picker.rung;
    if (!(await this.consent(rung))) return;
    const name = rung.id.replace(/-Q.*$/, "");
    this.prompt = this.q("[data-prompt]").value.trim() || this.prompt;
    this.renderSentence();
    this.showList(0, false);
    this.source = `${name}, writing on this computer`;
    this.renderSource();
    btn.textContent = "Writing";
    let queue = Promise.resolve(), pending = 0;
    const land = k => {
      pending++;
      queue = queue.then(async () => { const rush = pending > 3; await this.choose(k, rush ? 0 : 250, rush ? 160 : 320); pending--; });
    };
    await this.engine.run("sample", { rung, opts: { prompt: this.prompt, maxNew: WORDS, temperature: this.temp() } }, {
      onEvent: e => {
        if (e.type !== "token") return;
        this.steps.push({ piece: e.piece, rank: e.rank, entropy: e.entropy, top: e.top });
        land(this.steps.length - 1);
      },
    });
    await queue;
    this.source = this.steps.length ? `${name} wrote this on your computer` : "";
  }

  // no model here: the recorded run, one word at a time
  async replay() {
    this.prompt = this.recorded.prompt;
    this.renderSentence();
    this.source = "a recorded run";
    this.renderSource();
    for (const s of this.recorded.steps) {
      this.steps.push(s);
      await this.choose(this.steps.length - 1);
    }
  }
}

function escapeHtml(s) { return s.replace(/[&<>]/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;" }[c])); }
