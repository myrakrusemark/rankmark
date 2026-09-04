// Error correction: RS(GF2^8) outer, block interleave, rate-1/2 conv + soft
// Viterbi inner. Port of ecc.py. The RS layer reproduces the `reedsolo`
// library's default parameters exactly (prim=0x11d, fcr=0, generator=2),
// because a frame built in Python must decode here and vice versa.

export const HARD_LLR = 4.0;

const CONV_K = 7;
const CONV_POLYS = [0o171, 0o133];
const CONV_STATES = 1 << (CONV_K - 1);
export const CONV_TAIL = CONV_K - 1;

export const bitsToLlrs = bits => bits.map(b => (b ? -HARD_LLR : HARD_LLR));
export const llrsToBits = llrs => llrs.map(x => (x < 0 ? 1 : 0));

// --- GF(2^8), prim 0x11d, generator 2 (reedsolo defaults) -----------------
const GF_EXP = new Uint8Array(512);
const GF_LOG = new Uint8Array(256);
(() => {
  let x = 1;
  for (let i = 0; i < 255; i++) {
    GF_EXP[i] = x;
    GF_LOG[x] = i;
    x <<= 1;
    if (x & 0x100) x ^= 0x11d;
  }
  for (let i = 255; i < 512; i++) GF_EXP[i] = GF_EXP[i - 255];
})();

const gfMul = (a, b) => (a === 0 || b === 0 ? 0 : GF_EXP[GF_LOG[a] + GF_LOG[b]]);
const gfInv = a => GF_EXP[255 - GF_LOG[a]];
const gfPow = (a, p) => GF_EXP[(((GF_LOG[a] * p) % 255) + 255) % 255]; // Python-style mod for p<0

// polynomials: index 0 = highest-degree coefficient (the "RS for coders" convention)
function polyMul(p, q) {
  const r = new Array(p.length + q.length - 1).fill(0);
  for (let i = 0; i < p.length; i++)
    for (let j = 0; j < q.length; j++) r[i + j] ^= gfMul(p[i], q[j]);
  return r;
}

function polyAdd(p, q) { // right-aligned (low degree at the end)
  const r = new Array(Math.max(p.length, q.length)).fill(0);
  for (let i = 0; i < p.length; i++) r[i + r.length - p.length] = p[i];
  for (let i = 0; i < q.length; i++) r[i + r.length - q.length] ^= q[i];
  return r;
}

const polyScale = (p, x) => p.map(c => gfMul(c, x));

function polyEval(poly, x) { // Horner, poly[0] = highest degree
  let y = poly[0];
  for (let i = 1; i < poly.length; i++) y = gfMul(y, x) ^ poly[i];
  return y;
}

function rsGenerator(nsym) {
  let g = [1];
  for (let i = 0; i < nsym; i++) g = polyMul(g, [1, gfPow(2, i)]); // fcr=0, generator=2
  return g;
}

export function rsEncode(data, nsym) {
  if (nsym === 0) return Uint8Array.from(data);
  const gen = rsGenerator(nsym);
  const out = new Uint8Array(data.length + nsym);
  out.set(data);
  for (let i = 0; i < data.length; i++) {
    const coef = out[i];
    if (coef !== 0)
      for (let j = 1; j < gen.length; j++) out[i + j] ^= gfMul(gen[j], coef);
  }
  out.set(data); // parity is the tail; restore the systematic message part
  return out;
}

// --- decode: syndromes -> Berlekamp-Massey -> Chien -> Forney -------------
// Faithful port of the "Reed-Solomon codes for coders" reference the
// `reedsolo` library implements (fcr=0, generator=2, prim=0x11d).

function calcSyndromes(msg, nsym) {
  const synd = [0]; // leading pad, as in the reference
  for (let i = 0; i < nsym; i++) synd.push(polyEval(msg, gfPow(2, i)));
  return synd;
}

function findErrorLocator(synd, nsym) {
  let errLoc = [1];
  let oldLoc = [1];
  const syndShift = synd.length - nsym; // = 1
  for (let i = 0; i < nsym; i++) {
    const K = i + syndShift;
    let delta = synd[K];
    for (let j = 1; j < errLoc.length; j++)
      delta ^= gfMul(errLoc[errLoc.length - 1 - j], synd[K - j]);
    oldLoc = [...oldLoc, 0];
    if (delta !== 0) {
      if (oldLoc.length > errLoc.length) {
        const newLoc = polyScale(oldLoc, delta);
        oldLoc = polyScale(errLoc, gfInv(delta));
        errLoc = newLoc;
      }
      errLoc = polyAdd(errLoc, polyScale(oldLoc, delta));
    }
  }
  while (errLoc.length && errLoc[0] === 0) errLoc.shift();
  const errs = errLoc.length - 1;
  if (errs * 2 > nsym) return null; // too many errors to correct
  return errLoc;
}

function findErrors(errLocRev, nmess) { // errLocRev = errLoc reversed (constant..highest)
  const errs = errLocRev.length - 1;
  const errPos = [];
  for (let i = 0; i < nmess; i++)
    if (polyEval(errLocRev, gfPow(2, i)) === 0) errPos.push(nmess - 1 - i);
  return errPos.length === errs ? errPos : null;
}

function findErrataLocator(coefPos) {
  let eLoc = [1];
  for (const i of coefPos) eLoc = polyMul(eLoc, polyAdd([1], [gfPow(2, i), 0]));
  return eLoc;
}

function findErrorEvaluator(synd, errLoc, nsym) {
  const mul = polyMul(synd, errLoc);
  return mul.slice(mul.length - (nsym + 1));
}

function correctErrata(msg, synd, errPos) {
  const coefPos = errPos.map(p => msg.length - 1 - p);
  const errLoc = findErrataLocator(coefPos);
  const syndRev = [...synd].reverse();
  const errEval = findErrorEvaluator(syndRev, errLoc, errLoc.length - 1).reverse();

  const X = coefPos.map(cp => gfPow(2, -(255 - cp)));
  const E = new Array(msg.length).fill(0);
  for (let i = 0; i < X.length; i++) {
    const Xi = X[i];
    const XiInv = gfInv(Xi);
    let errLocPrime = 1;
    for (let j = 0; j < X.length; j++)
      if (j !== i) errLocPrime = gfMul(errLocPrime, 1 ^ gfMul(XiInv, X[j]));
    if (errLocPrime === 0) return null;
    let y = polyEval([...errEval].reverse(), XiInv);
    y = gfMul(gfPow(Xi, 1), y); // fcr=0 -> gf_pow(Xi, 1-fcr) = Xi
    E[errPos[i]] = gfMul(y, gfInv(errLocPrime));
  }
  return polyAdd(Array.from(msg), E);
}

export function rsDecode(codeword, nsym) {
  if (nsym === 0) return Uint8Array.from(codeword);
  let msg = Array.from(codeword);
  const synd = calcSyndromes(msg, nsym);
  if (Math.max(...synd) === 0) return Uint8Array.from(msg.slice(0, msg.length - nsym));

  const errLoc = findErrorLocator(synd, nsym);
  if (errLoc === null) return null;
  const errPos = findErrors([...errLoc].reverse(), msg.length);
  if (errPos === null) return null;

  msg = correctErrata(msg, synd, errPos);
  if (msg === null) return null;
  // right-aligned polyAdd can widen msg; keep the low bytes
  msg = msg.slice(msg.length - codeword.length);

  const synd2 = calcSyndromes(msg, nsym);
  if (Math.max(...synd2) > 0) return null; // miscorrection — CRC gate would also catch it
  return Uint8Array.from(msg.slice(0, msg.length - nsym));
}

// --- repetition -----------------------------------------------------------
export function repEncode(bits, factor) {
  const out = [];
  for (const b of bits) for (let i = 0; i < factor; i++) out.push(b);
  return out;
}

export function repDecodeSoft(llrs, factor) {
  const out = [];
  for (let i = 0; i < llrs.length; i += factor) {
    let sum = 0;
    for (let j = 0; j < factor && i + j < llrs.length; j++) sum += llrs[i + j];
    out.push(sum);
  }
  return out;
}

// --- block interleave -----------------------------------------------------
function interleaveOrder(n, depth) {
  const width = Math.ceil(n / depth);
  const order = [];
  for (let col = 0; col < width; col++)
    for (let row = 0; row < depth; row++) {
      const idx = row * width + col;
      if (idx < n) order.push(idx);
    }
  return order;
}

export function interleave(data, depth) {
  if (depth <= 1) return Uint8Array.from(data);
  const order = interleaveOrder(data.length, depth);
  return Uint8Array.from(order, i => data[i]);
}

export function deinterleave(data, depth) {
  if (depth <= 1) return Uint8Array.from(data);
  const order = interleaveOrder(data.length, depth);
  const out = new Uint8Array(data.length);
  order.forEach((src, dst) => { out[src] = data[dst]; });
  return out;
}

// --- convolutional + soft Viterbi -----------------------------------------
function convOutputs(state, bit) {
  const reg = (bit << (CONV_K - 1)) | state;
  const outs = CONV_POLYS.map(poly => {
    let bitsSet = 0, v = reg & poly;
    while (v) { bitsSet ^= v & 1; v >>= 1; }
    return bitsSet;
  });
  return [reg >> 1, outs];
}

export function convEncode(bits) {
  const out = [];
  let state = 0;
  const padded = [...bits, ...new Array(CONV_TAIL).fill(0)];
  for (const bit of padded) {
    const [next, [o0, o1]] = convOutputs(state, bit);
    out.push(o0, o1);
    state = next;
  }
  return out;
}

export function viterbiDecode(llrs, nbits) {
  const steps = nbits + CONV_TAIL;
  if (llrs.length < 2 * steps) return null;

  const NEG = -Infinity;
  let metrics = new Array(CONV_STATES).fill(NEG);
  metrics[0] = 0;
  const history = [];

  for (let t = 0; t < steps; t++) {
    const pair = [llrs[2 * t], llrs[2 * t + 1]];
    const next = new Array(CONV_STATES).fill(NEG);
    const back = new Array(CONV_STATES).fill(0);
    for (let state = 0; state < CONV_STATES; state++) {
      if (metrics[state] === NEG) continue;
      for (let bit = 0; bit < 2; bit++) {
        const [nxt, outs] = convOutputs(state, bit);
        let m = metrics[state];
        for (let k = 0; k < 2; k++) m += outs[k] === 0 ? pair[k] : -pair[k];
        if (m > next[nxt]) { next[nxt] = m; back[nxt] = (state << 1) | bit; }
      }
    }
    metrics = next;
    history.push(back);
  }

  let state = 0;
  const bits = [];
  for (let i = history.length - 1; i >= 0; i--) {
    const packed = history[i][state];
    bits.push(packed & 1);
    state = packed >> 1;
  }
  bits.reverse();
  return bits.slice(0, nbits);
}
