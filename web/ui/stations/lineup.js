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
    rows.push(bar(short(writer), 100, "validates", true));
    for (const r of l.results) {
      const pct = r.bitAgreement === null ? 0 : Math.round(r.bitAgreement * 100);
      rows.push(bar(short(r.reader), pct, r.valid ? "validates" : "no frame", false));
    }
  }
  root.innerHTML = `<div class="lu-grid">${rows.join("")}</div><p class="note">Bars: how many of the planted bits a reader recovers with the right value. The writer gets all of them; a sibling from the same family lands near 60%; a coin gets 50%. Measured on ${data.updated?.slice(0, 10) || "this laptop"}, 200-word texts.</p>`;
}

function bar(name, pct, label, self) {
  return `<div class="lu-row ${self ? "self" : ""}"><span class="lu-name">${name}</span><span class="lu-bar"><i style="transform: scaleX(${pct / 100})"></i><b style="left:50%"></b></span><span class="lu-pct">${pct}%</span><span class="lu-label">${label}</span></div>`;
}
