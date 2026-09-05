// Boot: registry, hardware probe, engine worker, the two panels, tabs.
// Decides between live runs and the recorded replay.

import { loadRegistry } from "../engine/models.js";
import { probe } from "../engine/probe.js";
import { EngineClient } from "./worker-client.js";
import { ModelPicker } from "./models.js";
import { FrameStrip } from "./frame-strip.js";
import { TextView } from "./text-view.js";
import { Callouts } from "./callouts.js";
import { WritePanel } from "./write.js";
import { ReadPanel } from "./read.js";
import { Replay } from "./snapshot.js";
import { initLocal } from "./local.js";

const $ = s => document.querySelector(s);

const registry = await loadRegistry(new URL("../engine/registry.json", import.meta.url));
const hw = await probe(registry);
const narrow = matchMedia("(max-width: 700px)").matches;
const canRun = hw.isolated && hw.rungs.some(r => r.ok) && !narrow;

// tabs
const tabs = [...document.querySelectorAll('[role="tab"]')];
const indicator = $(".tabs .indicator");
function select(id) {
  for (const t of tabs) {
    const on = t.id === `tab-${id}`;
    t.setAttribute("aria-selected", String(on));
    document.getElementById(t.getAttribute("aria-controls")).hidden = !on;
    if (on) { indicator.style.width = `${t.offsetWidth}px`; indicator.style.transform = `translateX(${t.offsetLeft}px)`; }
  }
  history.replaceState(null, "", `#${id}`);
}
for (const t of tabs) t.addEventListener("click", () => select(t.id.replace("tab-", "")));
select(["write", "read", "local"].includes(location.hash.slice(1)) ? location.hash.slice(1) : "write");
addEventListener("resize", () => select(tabs.find(t => t.getAttribute("aria-selected") === "true").id.replace("tab-", "")));

// shared pieces
const engine = canRun ? new EngineClient() : null;
const picker = new ModelPicker({
  select: $("#model"), status: $("#model-status"), cacheList: $("#cache-list"), registry, probe: hw,
  onChange: () => write.renderTag(),
});
const layer = $(".callout-layer");
const callouts = new Callouts(layer);
$("[data-reset-callouts]")?.addEventListener("click", () => callouts.reset());

const wStrip = new FrameStrip($("#write-strip"));
const wView = new TextView($("#write-text"), { emptyText: "The model's text appears here as it writes." });
const rStrip = new FrameStrip($("#read-strip"));
const rView = new TextView($("#read-text"), { emptyText: "" });

let read;
const write = new WritePanel($("#panel-write"), {
  engine, picker, callouts, strip: wStrip, view: wView,
  onDone: ({ card, mode }) => { read.load(card); select("read"); read.run().then(() => { if (mode === "break") $("#panel-read [data-break]")?.focus(); }); },
});
read = new ReadPanel($("#panel-read"), { engine, picker, callouts, strip: rStrip, view: rView });
initLocal($("#panel-local"));

// recorded run: the no-download path, and the only path on a phone or an unisolated page
let snapshot = null;
try { snapshot = await (await fetch(new URL("../data/snapshot.json", import.meta.url))).json(); } catch { /* no snapshot */ }
const replay = new Replay({ strip: wStrip, view: wView, callouts });
const replayRead = new Replay({ strip: rStrip, view: rView, callouts });
if (snapshot) {
  const replayBtn = $("#panel-write [data-replay]");
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
    $("#panel-write [data-read]").onclick = async () => { read.load(card); select("read"); await replayRead.read(snapshot, $("#panel-read [data-head]")); read.verdict("ok", `A frame planted with <b>${snapshot.rung.replace(/-Q.*$/, "")}</b> validates in this text.<span class="tag">${snapshot.opts.payloadHex === "a7" ? "0xa7" : snapshot.opts.payloadHex}</span>`); };
    $("#panel-write [data-break]").onclick = $("#panel-write [data-read]").onclick;
    callouts.once("done", $("#panel-write [data-card]"));
  });
} else {
  $("#panel-write [data-replay]").hidden = true;
}

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
  window.rankmark = { engine, picker, registry, hw, snapshot };
}
