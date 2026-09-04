// Pure logit math shared by encode and decode — no model dependency, so this
// module is importable headlessly (node tests) as well as in the browser.
// Mirrors tokenobs.py's rank_of / entropy_of and channel.py's sorted_token_ids.

export function rankOf(logits, tokenId) {
  const chosen = logits[tokenId];
  let greater = 0, tiedBefore = 0;
  for (let i = 0; i < logits.length; i++) {
    if (logits[i] > chosen) greater++;
    else if (i < tokenId && logits[i] === chosen) tiedBefore++;
  }
  return greater + tiedBefore;
}

export function entropyOf(logits) {
  let max = -Infinity;
  for (let i = 0; i < logits.length; i++) if (logits[i] > max) max = logits[i];
  let sum = 0;
  for (let i = 0; i < logits.length; i++) sum += Math.exp(logits[i] - max);
  const logZ = max + Math.log(sum);
  let h = 0;
  for (let i = 0; i < logits.length; i++) {
    const lp = logits[i] - logZ;
    h -= Math.exp(lp) * lp;
  }
  return h;
}

// descending by logit, ties -> lower token id (the frozen order both sides share)
export function sortedTokenIds(logits) {
  const idx = new Int32Array(logits.length);
  for (let i = 0; i < logits.length; i++) idx[i] = i;
  return idx.sort((a, b) => logits[b] - logits[a] || a - b);
}
