// Regressions for descriptive evidence and the truncated candidate display.
import assert from 'node:assert/strict';
import { agreement } from '../engine/compare.js';
import { report } from '../ui/stations/evidence.js';
import { RankedChoice } from '../ui/stations/ranked.js';

const original = [0, 1, 0, 1].map((bit, id) => ({ id, bit, carrier: true }));
const edited = [original[0], { ...original[1], bit: 0 }, original[3]];
const result = agreement(original, edited);
assert.equal(result.agree, 2);
assert.equal(result.survived, 3);
assert.equal(result.lost, 1); // deleted tokens must count as lost, too
assert.equal(result.agreementPct, 67); // denominator is surviving carriers
assert.equal(agreement(original, []).lost, 4);

const frame = { rung: 'Qwen3-1.7B-Q8_0', frameBits: 4, message: '', layout: [{ kind: 'sync', start: 0, len: 4 }] };
for (const valid of [false, true]) {
  // Even a large diagnostic z must never trigger an authorship verdict.
  const html = report({ ...result, z: 100 }, { valid }, frame, original, Infinity);
  assert.match(html, /agreement with the original watermark/);
  assert.match(html, /2 matching, 1 flipped, 1 lost/);
  assert.doesNotMatch(html, /written by|wrote this|luck gives|every bit agrees/);
  assert.match(html, valid ? /passes its checksum/ : /No packet validated/);
}

const head = { textContent: '' };
const list = { innerHTML: '', classList: { toggle() {} } };
const view = Object.create(RankedChoice.prototype);
Object.assign(view, {
  steps: [{ rank: 9, piece: ' elsewhere', top: [{ piece: ' a', logit: 1 }, { piece: ' b', logit: 1 }] }],
  shown: 0, chosen: true,
  q: selector => selector === '[data-list]' ? list : selector === '[data-list-head]' ? head : null,
});
view.renderList();
assert.match(head.textContent, /relative probabilities among these 2/);
assert.match(head.textContent, /picked #10: ␣elsewhere \(outside this list\)/);
assert.equal((list.innerHTML.match(/50%/g) || []).length, 2);
console.log('Educational evidence and candidate display regressions passed.');

// Same-model bars must come from recorded results, not an invented baseline.
const { renderLineup } = await import('../ui/stations/lineup.js');
const savedFetch = globalThis.fetch;
try {
  const root = { innerHTML: '', hidden: false };
  const results = [{ reader: 'Qwen3-1.7B-Q8_0', bitAgreement: 0.6, valid: false, bothCarrier: 30, writerCarriers: 50 }];
  globalThis.fetch = async () => ({ json: async () => ({ lineups: { 'Qwen3-0.6B-Q8_0': { results } }, lineupTokens: 200 }) });
  await renderLineup(root, 'fixture');
  assert.doesNotMatch(root.innerHTML, /lu-row self/);
  results.unshift({ reader: 'Qwen3-0.6B-Q8_0', bitAgreement: 1, valid: false, bothCarrier: 50, writerCarriers: 50 });
  await renderLineup(root, 'fixture');
  assert.match(root.innerHTML, /lu-row self/);
  assert.match(root.innerHTML, /100%/);
  assert.doesNotMatch(root.innerHTML, />message recovered/);
} finally { globalThis.fetch = savedFetch; }
