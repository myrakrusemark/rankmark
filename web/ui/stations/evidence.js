// Station: edit it and it still tells. The same reader, with the writer's
// planted bits kept as the reference. After each read, the recovered bits are
// lined up against the planted ones: how many survived, how many agree, and
// how far above chance that is. A partial pattern is evidence even when the
// full message is gone; that is what a keyed detector reports.

import { agreement } from "../../engine/compare.js";

export function attachEvidence(readPanel, meterEl) {
  readPanel.reference = null;       // [{id, carrier, bit}] from the write station
  readPanel.readTokens = [];
  const origAppend = readPanel.view.append.bind(readPanel.view);
  readPanel.view.append = (e, o) => { const el = origAppend(e, o); if (!e.seed) readPanel.readTokens.push({ id: e.id, carrier: !!e.carrier, bit: e.bit ?? null, el }); return el; };
  const origRun = readPanel.run.bind(readPanel);
  readPanel.run = async opts => {
    readPanel.readTokens = [];
    meterEl.hidden = true;
    const res = await origRun(opts);
    if (!res || !readPanel.reference) return res;
    const a = agreement(readPanel.reference, readPanel.readTokens);
    a.perToken.forEach((mark, j) => { const t = readPanel.readTokens[j]; if (t && mark) t.el.classList.add(`ev-${mark}`); });
    const pct = a.agreementPct ?? 0;
    const verdictLine = res.valid
      ? "The full message came back."
      : a.survived === 0 ? "No planted bit survived this edit."
      : pct >= 80 ? "The full message did not come back, but the bits that survived still say this model wrote it."
      : "What survived agrees no better than chance: after this edit the reader is scoring different words than the writer did.";
    meterEl.innerHTML = `
      <div class="ev-row"><span>planted</span><b>${a.planted}</b></div>
      <div class="ev-row"><span>survived the edit</span><b>${a.survived}</b><small>${a.lost} lost</small></div>
      <div class="ev-row"><span>agree with what was planted</span><b>${a.survived ? pct + "%" : "n/a"}</b><small>chance is 50%</small></div>
      <div class="ev-bar"><i style="transform: scaleX(${a.survived ? pct / 100 : 0})"></i><b style="left: 50%"></b></div>
      <div class="ev-row"><span>standard deviations above chance</span><b>${a.survived ? a.z : "n/a"}</b></div>
      <p class="ev-verdict">${verdictLine}</p>`;
    meterEl.hidden = false;
    return res;
  };
}
