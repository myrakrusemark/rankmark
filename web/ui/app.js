// Boot: registry, hardware probe, one engine worker, the essay's stations and
// the full tool at the bottom. Decides between live runs and the recorded replay.

import { loadRegistry } from "../engine/models.js";
import { probe } from "../engine/probe.js";
import { EngineClient } from "./worker-client.js";
import { ModelPicker, GB } from "./models.js";
import { FrameStrip } from "./frame-strip.js";
import { TextView } from "./text-view.js";
import { Callouts } from "./callouts.js";
import { WritePanel } from "./write.js";
import { ReadPanel } from "./read.js";
import { Replay } from "./snapshot.js";
import { initLocal } from "./local.js";
import { RankedChoice } from "./stations/ranked.js";
import { attachEvidence } from "./stations/evidence.js";
import { renderLineup } from "./stations/lineup.js";

const $ = s => document.querySelector(s);
const quiet = { once() {}, dismiss() {}, reset() {} };   // stations narrate in prose, not pop-ups

const registry = await loadRegistry(new URL("../engine/registry.json", import.meta.url));
const hw = await probe(registry);
const narrow = matchMedia("(max-width: 700px)").matches;
const canRun = hw.isolated && hw.rungs.some(r => r.ok) && !narrow;
const engine = canRun ? new EngineClient() : null;

let snapshot = null;
try { snapshot = await (await fetch(new URL("../data/snapshot.json", import.meta.url))).json(); } catch { /* no snapshot */ }

const picker = new ModelPicker({
  select: $("#model"), status: $("#model-status"), cacheList: $("#cache-list"), registry, probe: hw,
  onChange: () => { stWrite.renderTag(); toolWrite.renderTag(); },
});
const consent = r => picker.consent(r);

// ---- stations ---------------------------------------------------------------
const ranked = new RankedChoice($("#st-ranked"), { engine, picker, snapshot, consent });

const stWriteStrip = new FrameStrip($("#st-write-strip"));
const stWriteView = new TextView($("#st-write-text"), { emptyText: "The model's words appear here as it writes." });
const stReadStrip = new FrameStrip($("#st-read-strip"));
const stReadView = new TextView($("#st-read-text"), { boxed: false });
const stEvStrip = new FrameStrip($("#st-ev-strip"));
const stEvView = new TextView($("#st-ev-text"), { boxed: false });

const stRead = new ReadPanel($("#st-read"), { engine, picker, callouts: quiet, strip: stReadStrip, view: stReadView });
const stEv = new ReadPanel($("#st-evidence"), { engine, picker, callouts: quiet, strip: stEvStrip, view: stEvView });
attachEvidence(stEv, $("#st-evidence [data-evidence]"));

const stWrite = new WritePanel($("#st-write"), {
  engine, picker, callouts: quiet, strip: stWriteStrip, view: stWriteView,
  onDone: ({ card, tokens, mode }) => {
    if (mode !== "done") return;
    stRead.load(card);
    stEv.load(card);
    stEv.reference = tokens;
    $("#st-read [data-paste]").placeholder = "";
  },
});

// recorded run for the write station (and phones)
const stReplay = new Replay({ strip: stWriteStrip, view: stWriteView, callouts: quiet });
const stReplayBtn = $("#st-write [data-replay]");
if (snapshot) {
  stReplayBtn.addEventListener("click", async () => {
    if (stReplayBtn.disabled) return;
    stReplayBtn.disabled = true;
    if (engine) await engine.cancel();
    try { await stReplay.write(snapshot, $("#st-write [data-head]")); } finally { stReplayBtn.disabled = false; }
    $("#st-write [data-card-foot]").textContent = snapshot.card.slice(snapshot.write.text.length + 2);
    $("#st-write [data-card]").hidden = false;
    $("#st-write [data-copy]").onclick = async () => { try { await navigator.clipboard.writeText(snapshot.card); } catch { /* blocked */ } };
    stRead.load(snapshot.card);
    stEv.load(snapshot.card);
    stEv.reference = snapshot.write.tokens.map(t => ({ id: t.id, carrier: t.carrier, bit: t.bit }));
    if (!engine) {
      // no model here: the read station replays the recorded read
      const rr = new Replay({ strip: stReadStrip, view: stReadView, callouts: quiet });
      $("#st-read [data-run]").hidden = true;
      const btn = document.createElement("button");
      btn.type = "button"; btn.className = "btn primary"; btn.textContent = "Watch it read back";
      $("#st-read .btn-row").prepend(btn);
      btn.onclick = async () => { stRead.annotate(null); await rr.read(snapshot, $("#st-read [data-head]")); stRead.verdict("ok", `A frame planted with <b>${snapshot.rung.replace(/-Q.*$/, "")}</b> validates in this text.`); };
    }
  });
} else {
  stReplayBtn.hidden = true;
}

renderLineup($("#st-lineup [data-lineup-bars]"), new URL("../data/measurements.json", import.meta.url));

// ---- the full tool at the bottom -------------------------------------------
const tabs = [...document.querySelectorAll('#tool [role="tab"]')];
const indicator = $("#tool .tabs .indicator");
function select(id) {
  for (const t of tabs) {
    const on = t.id === `tab-${id}`;
    t.setAttribute("aria-selected", String(on));
    document.getElementById(t.getAttribute("aria-controls")).hidden = !on;
    if (on) { indicator.style.width = `${t.offsetWidth}px`; indicator.style.transform = `translateX(${t.offsetLeft}px)`; }
  }
}
for (const t of tabs) t.addEventListener("click", () => select(t.id.replace("tab-", "")));
select("write");
addEventListener("resize", () => select(tabs.find(t => t.getAttribute("aria-selected") === "true").id.replace("tab-", "")));

const callouts = new Callouts($("#tool .callout-layer"));
$("[data-reset-callouts]")?.addEventListener("click", () => callouts.reset());
const wStrip = new FrameStrip($("#write-strip"));
const wView = new TextView($("#write-text"), { emptyText: "The model's text appears here as it writes." });
const rStrip = new FrameStrip($("#read-strip"));
const rView = new TextView($("#read-text"), { boxed: false });
let toolRead;
const toolWrite = new WritePanel($("#panel-write"), {
  engine, picker, callouts, strip: wStrip, view: wView,
  onDone: ({ card, mode }) => { if (mode === "done") return; toolRead.load(card); select("read"); toolRead.run().then(() => { if (mode === "break") $("#panel-read [data-break]")?.focus(); }); },
});
toolRead = new ReadPanel($("#panel-read"), { engine, picker, callouts, strip: rStrip, view: rView });
initLocal($("#panel-local"));

const replay = new Replay({ strip: wStrip, view: wView, callouts });
const replayRead = new Replay({ strip: rStrip, view: rView, callouts });
const replayBtn = $("#panel-write [data-replay]");
if (snapshot) {
  replayBtn.addEventListener("click", async () => {
    if (replayBtn.disabled) return;
    replayBtn.disabled = true;
    if (engine) await engine.cancel();
    $("#panel-write [data-card]").hidden = true;
    try { await replay.write(snapshot, $("#panel-write [data-head]")); } finally { replayBtn.disabled = false; }
    const card = snapshot.card;
    $("#panel-write [data-card-text]").textContent = snapshot.write.text;
    $("#panel-write [data-card-foot]").textContent = card.slice(snapshot.write.text.length + 2);
    $("#panel-write [data-card]").hidden = false;
    $("#panel-write [data-read]").onclick = async () => { toolRead.load(card); select("read"); toolRead.annotate(null); await replayRead.read(snapshot, $("#panel-read [data-head]")); toolRead.verdict("ok", `A frame planted with <b>${snapshot.rung.replace(/-Q.*$/, "")}</b> validates in this text.`); };
    $("#panel-write [data-break]").onclick = $("#panel-write [data-read]").onclick;
    callouts.once("done", $("#panel-write [data-card]"));
  });
} else {
  replayBtn.hidden = true;
}

// ---- mode ---------------------------------------------------------------------
if (!canRun) {
  const why = !hw.isolated ? "This page is not cross-origin isolated, so the engine cannot use threads here."
    : narrow ? "On a phone the download is 0.6 GB or more and the model runs at under one word a second, so this page replays a recorded run instead. Open it on a laptop to run your own."
    : "No model in the ladder fits this browser.";
  for (const p of document.querySelectorAll("[data-live-only]")) p.hidden = true;
  const note = $("#mode-note");
  note.textContent = why;
  note.hidden = false;
} else {
  await picker.scanCache();
  autoload();
}
window.rankmark = { engine, picker, registry, hw, snapshot };

// ---- the model that loads on arrival ------------------------------------------
// the examples need a model, so the small one starts loading as soon as the page
// can run one: a card says so, with a progress bar and a cancel button. A rung
// the visitor already downloaded and picked before loads instead of the small one.
async function autoload() {
  const card = $("#autoload");
  if (!card || hw.saveData) return;
  const rung = picker.cached.has(picker.rung.id) ? picker.rung : registry.rungs[0];
  if (!hw.rungs.find(r => r.id === rung.id)?.ok) return;
  if (rung !== picker.rung) { picker.select.value = rung.id; picker.renderStatus(); picker.onChange?.(rung); }
  const name = rung.id.replace(/-Q.*$/, "");
  const fromCache = picker.cached.has(rung.id);
  const q = s => card.querySelector(s);
  const msg = q("[data-al-msg]"), fill = q("[data-al-fill]"), pct = q("[data-al-pct]"), bar = q(".al-bar"), cancel = q("[data-al-cancel]");
  msg.textContent = fromCache
    ? `${name} is loading from this browser's storage so they run on your own computer.`
    : `A small model, ${name} (${GB(rung.bytes)}), is downloading into this browser so they run on your own computer. Nothing you type leaves the page.`;
  bar.classList.toggle("wait", fromCache);
  card.hidden = false;
  requestAnimationFrame(() => card.classList.remove("off"));
  const hide = () => { card.classList.add("off"); setTimeout(() => { card.hidden = true; }, 400); };
  picker.granted.add(rung.id);
  let cancelled = false;
  cancel.onclick = async () => {
    cancelled = true;
    picker.granted.delete(rung.id);
    hide();
    engine.restart();
    await picker.dropPartial(rung);
    await picker.scanCache();
  };
  try {
    const res = await engine.run("load", { rung }, {
      onProgress: p => {
        if (!p.total) return;
        const f = Math.min(1, p.loaded / p.total);
        fill.style.transform = `scaleX(${f})`;
        pct.textContent = f >= 1 ? "starting the model" : `${Math.round(f * 100)}% of ${GB(rung.bytes)}`;
      },
    });
    if (cancelled || res?.cancelled) return;
    bar.classList.remove("wait");
    fill.style.transform = "scaleX(1)";
    pct.textContent = "";
    cancel.hidden = true;
    cancel.onclick = null;
    msg.textContent = `${name} is ready. Every example on this page runs on your computer.`;
    await picker.scanCache();
    setTimeout(hide, 4000);
  } catch (err) {
    if (cancelled) return;
    picker.granted.delete(rung.id);
    bar.classList.remove("wait");
    msg.textContent = `The download did not finish (${err.message}). Each example asks again when you run it.`;
    cancel.textContent = "Close";
    cancel.onclick = hide;
  }
}
