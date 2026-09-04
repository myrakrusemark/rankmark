// Hardware probe (main thread): what this browser and machine can run, and
// which rung to recommend. Feature tests, not user-agent sniffing.

export async function probe(registry) {
  const memory64 = (() => {
    try { new WebAssembly.Memory({ address: "i64", initial: 1n, maximum: 2n }); return true; } catch { return false; }
  })();
  const jspi = typeof WebAssembly.Suspending === "function";
  const isolated = !!self.crossOriginIsolated;
  const deviceMemory = navigator.deviceMemory ?? null; // Chromium only, capped at 8
  const threads = navigator.hardwareConcurrency ?? null;
  let storage = null;
  try { storage = await navigator.storage.estimate(); } catch { /* not available */ }
  const saveData = !!navigator.connection?.saveData;

  const rungs = registry.rungs.map(r => {
    const reasons = [];
    if (r.memory64 && !memory64) reasons.push("needs 64-bit WebAssembly memory (Chrome 133+, Firefox 134+)");
    if (deviceMemory !== null && r.heapGB + 2 > deviceMemory) reasons.push(`needs about ${Math.ceil(r.heapGB + 2)} GB of memory`);
    if (storage && storage.quota && r.bytes > storage.quota - (storage.usage || 0)) reasons.push("not enough storage to cache the download");
    return { id: r.id, tier: r.tier, ok: reasons.length === 0, reasons };
  });

  // largest rung that passes, but never the top tier: deviceMemory is capped at
  // 8 so it cannot tell an 8 GB laptop from a 32 GB one, and 8B needs ~6 GB
  // free. With unknown memory (Firefox, Safari) stop at tier 1.
  const ceiling = deviceMemory === null ? 1 : 2;
  const usable = rungs.filter(x => x.ok && x.tier <= ceiling);
  const recommended = usable.length ? usable[usable.length - 1].id : registry.rungs[0].id;

  return {
    memory64, jspi, isolated, deviceMemory, threads, saveData,
    storage: storage ? { usage: storage.usage, quota: storage.quota } : null,
    rungs, recommended,
  };
}
