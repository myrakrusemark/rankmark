// Seeded sampling helpers. The JS sampler is its own reference: a seed
// reproduces a run in the browser, it does not reproduce a Python run.

// mulberry32: 32-bit seed, uniform floats in [0, 1)
export function mulberry32(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function randomSeed() {
  const u = new Uint32Array(1);
  crypto.getRandomValues(u);
  return u[0];
}

// pick an index in proportion to softmax(values / temperature)
export function sampleSoftmax(values, temperature, rng) {
  let max = -Infinity;
  for (const v of values) if (v > max) max = v;
  const weights = values.map(v => Math.exp((v - max) / temperature));
  let sum = 0;
  for (const w of weights) sum += w;
  let u = rng() * sum;
  for (let i = 0; i < weights.length; i++) {
    u -= weights[i];
    if (u <= 0) return i;
  }
  return weights.length - 1;
}
