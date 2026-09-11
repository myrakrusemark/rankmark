// Station: whose text is it. Measured bit agreement when each model reads
// text another model wrote, from web/data/measurements.json, as bars.

export async function renderLineup(root, url) {
  let data = null;
  try { data = await (await fetch(url)).json(); } catch { /* no measurements yet */ }
  if (!data || !data.lineups || !Object.keys(data.lineups).length) { root.hidden = true; return; }
  const short = id => id.replace(/-Q.*$/, "");
  const rows = [];
  for (const [writer, l] of Object.entries(data.lineups)) {
    rows.push(`<div class="lu-writer">written by <b>${short(writer)}</b></div>`);

    for (const r of [...l.results].sort((a, b) => Number(b.reader === writer) - Number(a.reader === writer))) {
      const pct = r.bitAgreement === null ? 0 : Math.round(r.bitAgreement * 100);
      rows.push(bar(short(r.reader) + (r.reader === writer ? " (writer)" : ""), pct, `${r.valid === true ? "message recovered" : r.valid === false ? "message not recovered" : "recovery not measured"} · ${r.bothCarrier}/${r.writerCarriers} shared carriers`, r.reader === writer));
    }
  }
  root.innerHTML = `<p class="note">Green bars use the writer’s own model. Percentages show matching bits, not a probability of authorship.</p><div class="lu-grid">${rows.join("")}</div><p class="note">Bars show agreement at places where both models say a bit could go. <a href="data/measurements.json">Based on real generated data.</a></p>`;
}

function bar(name, pct, label, self) {
  return `<div class="lu-row ${self ? "self" : ""}"><span class="lu-name">${name}</span><span class="lu-bar"><i style="transform: scaleX(${pct / 100})"></i></span><span class="lu-pct">${pct}%</span></div>`;
}
