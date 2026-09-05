// Model picker: what this machine can run, what is already downloaded, the
// consent dialog with size and time before any download, and the cache panel.

import { frameLenBits } from "../engine/framing.js";

const GB = b => (b / 1e9).toFixed(b >= 1e9 ? 1 : 2) + " GB";

export class ModelPicker {
  constructor({ select, status, cacheList, registry, probe, onChange }) {
    this.select = select;
    this.status = status;
    this.cacheList = cacheList;
    this.registry = registry;
    this.probe = probe;
    this.onChange = onChange;
    this.cached = new Map();
    let stored = null;
    try { stored = localStorage.getItem("rankmark.rung"); } catch { /* ignore */ }
    this.select.addEventListener("change", () => { try { localStorage.setItem("rankmark.rung", this.select.value); } catch { /* ignore */ } this.renderStatus(); this.onChange?.(this.rung); });
    this.render(stored);
  }

  get rung() { return this.registry.rungs.find(r => r.id === this.select.value) || this.registry.rungs[0]; }

  render(preferred) {
    this.select.innerHTML = "";
    for (const r of this.registry.rungs) {
      const p = this.probe.rungs.find(x => x.id === r.id);
      const o = document.createElement("option");
      o.value = r.id;
      o.textContent = `${r.id.replace(/-Q.*$/, "")} · ${GB(r.bytes)}${this.cached.has(r.id) ? " · downloaded" : ""}`;
      if (p && !p.ok) { o.disabled = true; o.textContent += ` · ${p.reasons[0]}`; }
      this.select.appendChild(o);
    }
    const want = preferred && this.registry.rungs.some(r => r.id === preferred) ? preferred : this.probe.recommended;
    const opt = [...this.select.options].find(o => o.value === want && !o.disabled) || [...this.select.options].find(o => !o.disabled);
    if (opt) this.select.value = opt.value;
    this.renderStatus();
  }

  // a lean 1-byte frame: tokens = bits / carrier rate, with the budget's slack
  writeTokens(rung, payloadLen = 1, profile = 0) {
    return Math.ceil((frameLenBits(payloadLen, profile) / (rung.carrierRate || 0.12)) * 1.3);
  }
  minutes(rung, tokens) { return Math.max(1, Math.round(tokens / (rung.tokPerSec || 1) / 60)); }

  renderStatus() {
    const r = this.rung;
    const p = this.probe.rungs.find(x => x.id === r.id);
    const tokens = this.writeTokens(r);
    const mins = this.minutes(r, tokens);
    const parts = [];
    parts.push(this.cached.has(r.id) ? "downloaded" : `${GB(r.bytes)} download`);
    parts.push(`about ${mins} min to write a short tag on a laptop, the same to read it`);
    if (p && !p.ok) parts.push(p.reasons.join("; "));
    this.status.textContent = parts.join(" · ");
    this.status.classList.toggle("warn", !!(p && !p.ok));
  }

  // ask before the first download of a rung; returns true when allowed
  async consent(rung) {
    if (this.cached.has(rung.id)) return true;
    const dlg = document.getElementById("consent");
    dlg.querySelector("[data-size]").textContent = GB(rung.bytes);
    dlg.querySelector("[data-name]").textContent = rung.id.replace(/-Q.*$/, "");
    dlg.querySelector("[data-mins]").textContent = String(this.minutes(rung, this.writeTokens(rung)));
    const est = this.probe.storage;
    dlg.querySelector("[data-space]").textContent = est ? `${GB(est.quota - (est.usage || 0))} free in this browser's storage` : "";
    return new Promise(resolve => {
      const done = v => { dlg.removeEventListener("close", onClose); resolve(v); };
      const onClose = () => done(dlg.returnValue === "yes");
      dlg.addEventListener("close", onClose);
      dlg.showModal();
    });
  }

  // OPFS: wllama keeps <hash>_<file> next to __metadata__<hash>_<file>
  async scanCache() {
    this.cached = new Map();
    try {
      const root = await navigator.storage.getDirectory();
      const dir = await root.getDirectoryHandle("cache", { create: true });
      for await (const [name, h] of dir.entries()) {
        if (h.kind !== "file" || name.startsWith("__metadata__")) continue;
        const r = this.registry.rungs.find(x => name.endsWith("_" + x.file));
        if (!r) continue;
        const f = await h.getFile();
        if (f.size === r.bytes) this.cached.set(r.id, { name, size: f.size });
      }
    } catch { /* no OPFS: nothing cached */ }
    this.render(this.select.value);
    this.renderCache();
  }

  async remove(id) {
    const entry = this.cached.get(id);
    if (!entry) return;
    try {
      const root = await navigator.storage.getDirectory();
      const dir = await root.getDirectoryHandle("cache");
      await dir.removeEntry(entry.name).catch(() => {});
      await dir.removeEntry("__metadata__" + entry.name).catch(() => {});
    } catch { /* ignore */ }
    await this.scanCache();
  }

  renderCache() {
    if (!this.cacheList) return;
    const items = [...this.cached.keys()].map(id => this.registry.rungs.find(r => r.id === id));
    this.cacheList.innerHTML = items.length
      ? items.map(r => `<li><span>${r.id.replace(/-Q.*$/, "")} · ${GB(r.bytes)}</span><button type="button" data-remove="${r.id}">Remove</button></li>`).join("")
      : `<li><span>Nothing downloaded yet.</span></li>`;
    this.cacheList.querySelectorAll("[data-remove]").forEach(b => b.addEventListener("click", () => this.remove(b.dataset.remove)));
  }
}
