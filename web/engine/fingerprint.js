// A lens fingerprint names everything that decides a logit row: engine build,
// weights, quantization, attention kernel, context size. Thread count is left
// out on purpose: ggml partitions matmuls by output row, so it does not change
// bits (measured 1/2/4/8 identical), and a reader on a different core count
// must not report a mismatch. Two lenses with the same fingerprint read each
// other's text; a mismatch is diagnosable by field.

const FIELDS = ["engine", "model", "sha256", "quant", "device", "flashAttn", "nCtx"];

async function shortSha(bytes, n) {
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return [...new Uint8Array(digest)].slice(0, n).map(b => b.toString(16).padStart(2, "0")).join("");
}

export async function fingerprint(parts) {
  const canon = {};
  for (const k of FIELDS) canon[k] = parts[k] ?? null;
  return shortSha(new TextEncoder().encode(JSON.stringify(canon)), 6);
}

// which fields differ between two fingerprint part sets
export function fingerprintDiff(a, b) {
  return FIELDS.filter(k => (a[k] ?? null) !== (b[k] ?? null));
}

// hash of the exact text the writer produced; a reader compares it to what was
// pasted, so "altered in transit" is a fact, not a guess
export function textHash(text) {
  return shortSha(new TextEncoder().encode(text), 6);
}

// The mark card is the text plus one footer line naming the lens and the text
// hash; the reader strips it before tokenizing so the footer never enters the
// channel.
const FOOTER = /\n\nrankmark: (\S+) f=([0-9a-f]{12})(?: t=([0-9a-f]{12}))?\s*$/;

export function markCard(text, rungId, fp, hash) {
  return `${text}\n\nrankmark: ${rungId} f=${fp}${hash ? ` t=${hash}` : ""}`;
}

export function parseMarkCard(s) {
  const m = FOOTER.exec(s);
  return m ? { text: s.slice(0, m.index), rungId: m[1], fp: m[2], textHash: m[3] ?? null } : null;
}
