// Boot: registry, hardware probe, one engine worker, the essay's stations and
// the full tool at the bottom. All generation is live; a supported model loads on arrival.

import { loadRegistry } from "../engine/models.js";
import { probe } from "../engine/probe.js";
import { EngineClient } from "./worker-client.js";
import { ModelPicker, GB } from "./models.js";
import { FrameStrip } from "./frame-strip.js";
import { TextView } from "./text-view.js";
import { Callouts } from "./callouts.js";
import { WritePanel } from "./write.js";
import { ReadPanel } from "./read.js";
import { RankedChoice } from "./stations/ranked.js";
import { attachEvidence } from "./stations/evidence.js";
import { renderLineup } from "./stations/lineup.js";

const $ = s => document.querySelector(s);
const quiet = { once() {}, dismiss() {}, reset() {} };   // stations narrate in prose, not pop-ups

const registry = await loadRegistry(new URL("../engine/registry.json", import.meta.url));
const hw = await probe(registry);
const canRun = hw.isolated && hw.rungs.some(r => r.ok);
const engine = canRun ? new EngineClient() : null;

const picker = new ModelPicker({
  select: $("#model"), status: $("#model-status"), registry, probe: hw,
  onChange: () => { stWrite.renderTag(); toolWrite.renderTag(); },
});
const consent = r => picker.consent(r);

// ---- stations ---------------------------------------------------------------
const ranked = new RankedChoice($("#st-ranked"), { engine, picker, consent });

const stWriteStrip = new FrameStrip($("#st-write-strip"));
const stWriteView = new TextView($("#st-write-text"), { emptyText: "The model's words appear here as it writes." });
const stReadStrip = new FrameStrip($("#st-read-strip"));
const stReadView = new TextView($("#st-read-text"), { boxed: false });
const stEvStrip = new FrameStrip($("#st-ev-strip"));
const stEvView = new TextView($("#st-ev-text"), { boxed: false });

const stRead = new ReadPanel($("#st-read"), { engine, picker, callouts: quiet, strip: stReadStrip, view: stReadView });
const stEv = new ReadPanel($("#st-evidence"), { engine, picker, callouts: quiet, strip: stEvStrip, view: stEvView });
attachEvidence(stEv, $("#st-evidence [data-evidence]"));
// once the read station has read the text, the edit station reads the same
// text as its baseline: every sentence pair is already scored, so it costs the
// model nothing and shows the planted bits all agreeing before any edit
{
  const origRun = stRead.run.bind(stRead);
  stRead.run = async o => {
    const r = await origRun(o);
    if (r && !stEv.running && stEv.reference && stEv.ta.value === stRead.ta.value) stEv.run({ quiet: true });
    return r;
  };
}

const stWrite = new WritePanel($("#st-write"), {
  engine, picker, callouts: quiet, strip: stWriteStrip, view: stWriteView,
  // the text flows on into the read and evidence stations: as it is written,
  // then finished with its footer line, so nothing needs pasting
  onText: text => { stRead.preview(text); $("#st-read [data-head]").textContent = "the text you wrote above, still being written"; },
  onDone: ({ card, tokens, mode, planted, frameBits, layout, tag, rung, echo }) => {
    if (mode === "stalled") { $("#st-read [data-head]").textContent = `the text you wrote above; its frame stopped at ${planted} of ${frameBits} bits, so a read finds nothing`; return; }
    if (mode !== "done") return;
    stRead.load(card);
    stEv.load(card);
    stEv.reference = tokens;
    stEv.frame = { layout, frameBits, message: tag, rung, echo };   // what was planted, section by section
    $("#st-read [data-head]").textContent = "the text you wrote above, with its footer line";
    $("#st-read [data-paste]").placeholder = "";
  },
});

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
const wStrip = new FrameStrip($("#write-strip"));
const wView = new TextView($("#write-text"), { emptyText: "The model's text appears here as it writes." });
const rStrip = new FrameStrip($("#read-strip"));
const rView = new TextView($("#read-text"), { boxed: false });
let toolRead;
const toolWrite = new WritePanel($("#panel-write"), {
  engine, picker, callouts, strip: wStrip, view: wView,
  onDone: ({ card, mode }) => { if (mode === "done") $("#tool-read-key").value = $("#tool-write-key").value; if (mode === "done" || mode === "stalled") return; toolRead.load(card); select("read"); toolRead.run().then(() => { if (mode === "break") $("#panel-read [data-break]")?.focus(); }); },
});
toolRead = new ReadPanel($("#panel-read"), { engine, picker, callouts, strip: rStrip, view: rView });

// ---- mode ---------------------------------------------------------------------
if (!canRun) {
  const why = !hw.isolated ? "This page is not cross-origin isolated, so the engine cannot use threads here."
    : "No model in the ladder fits this browser.";
  for (const p of document.querySelectorAll("[data-live-only]")) p.hidden = true;
  for (const note of document.querySelectorAll("[data-mode-note]")) {
    note.textContent = why;
    note.hidden = false;
  }
} else {
  await picker.scanCache();
  setupModelPicker();
}
window.rankmark = { engine, picker, registry, hw };

// every example's go button follows the model: off with a note while it loads
// (or after a cancel), on when it is in
function modelReady(on, label) {
  ranked.ready(on, label);
  for (const panel of [stWrite, stRead, stEv, toolWrite, toolRead]) panel?.modelReady(on, label);
}

// ---- the model that loads on arrival ------------------------------------------
// the examples need a model, so the small one starts loading as soon as the page
// can run one (or the rung the visitor downloaded and picked before). A card says
// so, with a progress bar, a cancel button and the ladder: picking another rung
// cancels this download and starts that one.
function setupModelPicker() {
  const card = $("#autoload");
  if (!card) { modelReady(true); return; }   // narrow screens and data saver: ask before downloading
  modelReady(true);
  const q = s => card.querySelector(s);
  const msg = q("[data-al-msg]"), fill = q("[data-al-fill]"), pct = q("[data-al-pct]"), bar = q(".al-bar"), cancel = q("[data-al-cancel]"), list = q("[data-al-list]"), pill = q("[data-al-pill]");
  const name = r => r.id.replace(/-Q.*$/, "");
  const needs = r => `${Math.ceil(r.heapGB + 2)} GB free memory${r.heapGB >= 5 ? " (a 16 GB machine)" : ""}${r.memory64 ? ", Chrome 133+ or Firefox 134+" : ""}`;
  let current = null, job = null, loaded = null, shrinkTimer = null;
  // the card is the page's only model chooser, so it never goes away: it
  // shrinks to a pill naming the loaded model, and the pill reopens it
  const shrink = () => {
    clearTimeout(shrinkTimer);
    pill.innerHTML = loaded ? `<b>${name(loaded)}</b> ready · <u>change model</u>` : `No model loaded · <u>choose one</u>`;
    pill.hidden = false;
    card.classList.add("mini");
  };
  const show = () => { clearTimeout(shrinkTimer); card.hidden = false; card.classList.remove("mini"); pill.hidden = true; requestAnimationFrame(() => card.classList.remove("off")); };
  const renderList = state => {
    list.innerHTML = registry.rungs.map(r => {
      const p = hw.rungs.find(x => x.id === r.id);
      const on = r === current;
      const detail = p?.ok
        ? `${GB(r.bytes)} · ${needs(r)} · about ${picker.minutes(r, picker.writeTokens(r))} min to write a short message${picker.cached.has(r.id) ? " · downloaded" : ""}`
        : `${GB(r.bytes)} · ${p?.reasons[0] ?? "cannot run here"}`;
      return `<li><button type="button" data-al-pick="${r.id}" aria-pressed="${on}" ${p?.ok ? "" : "disabled"}><b>${name(r)}</b>${on && state ? `<i>${state}</i>` : ""}<span>${detail}</span></button></li>`;
    }).join("");
  };
  // a download has no abort hook: kill the worker and drop the partial file
  const stop = async () => {
    if (!job) return;
    job = null;
    loaded = null;
    modelReady(false, "No model loaded");
    picker.granted.delete(current.id);
    engine.restart();
    await picker.dropPartial(current);
    await picker.scanCache();
  };
  const start = async rung => {
    await stop();
    current = rung;
    if (rung.id !== picker.select.value) { picker.select.value = rung.id; picker.select.dispatchEvent(new Event("change")); }
    const fromCache = picker.cached.has(rung.id);
    msg.textContent = fromCache
      ? `${name(rung)} is loading from this browser's storage so they run on your own computer.`
      : `${name(rung)} (${GB(rung.bytes)}) is downloading into this browser so they run on your own computer. Nothing you type leaves the page.`;
    bar.classList.toggle("wait", fromCache);
    fill.style.transform = "scaleX(0)";
    pct.textContent = "";
    cancel.textContent = "Cancel";
    renderList(fromCache ? "loading" : "downloading");
    show();
    modelReady(false, "Loading the model");
    picker.granted.add(rung.id);
    const mine = engine.run("load", { rung }, {
      onProgress: p => {
        if (job !== mine || !p.total) return;
        const f = Math.min(1, p.loaded / p.total);
        fill.style.transform = `scaleX(${f})`;
        pct.textContent = f >= 1 ? "starting the model" : `${Math.round(f * 100)}% of ${GB(rung.bytes)}`;
      },
    });
    job = mine;
    let res;
    try { res = await mine; } catch (err) {
      if (job !== mine) return;
      job = null;
      picker.granted.delete(rung.id);
      bar.classList.remove("wait");
      msg.textContent = `The download did not finish (${err.message}). Each example asks again when you run it.`;
      cancel.textContent = "Close";
      modelReady(false, "No model loaded");
      renderList("");
      return;
    }
    if (job !== mine || res?.cancelled) return;
    job = null;
    loaded = rung;
    bar.classList.remove("wait");
    fill.style.transform = "scaleX(1)";
    pct.textContent = "";
    msg.textContent = `${name(rung)} is ready. Every example on this page runs on your computer.`;
    cancel.textContent = "Close";
    await picker.scanCache();
    renderList("ready");
    modelReady(true);
    shrinkTimer = setTimeout(shrink, 2000);
  };
  cancel.addEventListener("click", async () => { await stop(); shrink(); });
  pill.addEventListener("click", show);
  list.addEventListener("click", e => {
    const b = e.target.closest("[data-al-pick]");
    if (!b || b.disabled) return;
    const r = registry.rungs.find(x => x.id === b.dataset.alPick);
    if (r && r !== current) start(r);
  });
  // Reuse a downloaded model first; otherwise start with the smallest supported one.
  const supported = registry.rungs.filter(r => hw.rungs.some(p => p.id === r.id && p.ok));
  const initial = supported.find(r => r.id === picker.rung.id && picker.cached.has(r.id))
    || supported.find(r => picker.cached.has(r.id)) || supported[0];
  if (initial) start(initial);
  else { renderList(""); card.hidden = false; card.classList.remove("off"); shrink(); }
}
