// Known-message evidence: line up what a reader recovered against what the
// writer planted, and count agreement over the bits that survived. This is
// what a keyed detector does with its key: it knows the expected pattern and
// counts matches; chance is 50%, and a z-score says how far above chance.

// longest common subsequence alignment of two id arrays -> pairs of indices
function align(a, b) {
  const n = a.length, m = b.length;
  const dp = Array.from({ length: n + 1 }, () => new Uint16Array(m + 1));
  for (let i = n - 1; i >= 0; i--) for (let j = m - 1; j >= 0; j--) {
    dp[i][j] = a[i] === b[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
  }
  const pairs = [];
  let i = 0, j = 0;
  while (i < n && j < m) {
    if (a[i] === b[j]) { pairs.push([i, j]); i++; j++; }
    else if (dp[i + 1][j] >= dp[i][j + 1]) i++;
    else j++;
  }
  return pairs;
}

// written: [{id, carrier, bit}] from the writer; read: [{id, carrier, bit}] from a reader
export function agreement(written, read) {
  const pairs = align(written.map(t => t.id), read.map(t => t.id));
  let both = 0, agree = 0, lost = 0, extra = 0;
  const perToken = new Array(read.length).fill(null); // null: unmatched; "ok" / "flip" / "lost"
  const matchedRead = new Set();
  for (const [i, j] of pairs) {
    matchedRead.add(j);
    const w = written[i], r = read[j];
    if (w.carrier && r.carrier) { both++; if (w.bit === r.bit) { agree++; perToken[j] = "ok"; } else perToken[j] = "flip"; }
    else if (w.carrier) { lost++; perToken[j] = "lost"; }
    else if (r.carrier) extra++;
  }
  const planted = written.filter(t => t.carrier).length;
  const z = both ? (agree - both / 2) / Math.sqrt(both / 4) : 0;
  return {
    planted, survived: both, agree, agreementPct: both ? Math.round((100 * agree) / both) : null,
    lost, extra, z: Math.round(z * 10) / 10,
    matchedTokens: pairs.length, perToken,
  };
}
