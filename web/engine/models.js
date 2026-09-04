// Model registry: the ladder in registry.json plus the URL each file resolves
// to. Every rung carries the engine block so a lens can fingerprint itself.

export async function loadRegistry(url = new URL("./registry.json", import.meta.url)) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`registry: HTTP ${res.status}`);
  const reg = await res.json();
  for (const rung of reg.rungs) rung.engine = reg.engine;
  return reg;
}

export function rungById(reg, id) {
  const rung = reg.rungs.find(r => r.id === id);
  if (!rung) throw new Error(`unknown rung ${id}`);
  return rung;
}

// One URL for a single file; for a split model the first part, which the
// engine follows to the rest (llama-gguf-split naming).
export function fileUrl(rung) {
  const file = rung.parts ? rung.parts[0] : rung.file;
  return `https://huggingface.co/${rung.repo}/resolve/${rung.revision}/${file}`;
}
