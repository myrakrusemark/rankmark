// Lens = a llama.cpp model in WASM (the wllama fork) driven one token per
// llama_decode call. Encode and decode both step tokens one at a time through
// the same call, so their per-step logits are numerically identical: the
// invariant the rank-parity scheme depends on.

import { Wllama } from "../vendor/wllama/index.js";
import { entropyOf, rankOf, sortedTokenIds } from "./logits.js";
import { fileUrl } from "./models.js";
import { fingerprint } from "./fingerprint.js";

export { entropyOf, rankOf, sortedTokenIds };

const WASM = new URL("../vendor/wllama/wllama.wasm", import.meta.url).href;
// wasm32 + Asyncify build for browsers without JSPI or Memory64 (Safari); picked by wllama itself
const COMPAT = {
  worker: new URL("../vendor/wllama-compat/wllama.js", import.meta.url).href,
  wasm: new URL("../vendor/wllama-compat/wllama.wasm", import.meta.url).href,
};
const utf8 = new TextDecoder();

export class Cancelled extends Error {
  constructor() { super("cancelled"); this.name = "Cancelled"; }
}

// one lens resident at a time: two models do not fit the heap together
let current = null;

export function defaultThreads() {
  const n = self.navigator?.hardwareConcurrency ?? 4;
  return self.crossOriginIsolated ? Math.max(1, Math.min(8, Math.floor(n / 2))) : 1;
}

export async function loadLens(rung, { onProgress, threads, viaBlob = false } = {}) {
  const nThreads = threads ?? defaultThreads();
  if (current && current.rung.id === rung.id && current.threads === nThreads) return current;
  await unloadLens();
  const w = new Wllama({ default: WASM }, { parallelDownloads: 3, suppressNativeLog: true });
  w.setCompat(COMPAT);
  const params = {
    n_ctx: rung.nCtx ?? 2048,
    n_threads: nThreads,
    n_gpu_layers: 0,   // CPU only: wllama offloads to WebGPU by default, and GPU bits differ from CPU bits
    flash_attn: false, // one attention kernel, pinned; auto could pick differently per build
    warmup: false,
    progressCallback: onProgress,
  };
  let cache = "opfs";
  let weightsSha256 = null;
  const loadViaBlob = async () => {
    const { blob, sha256 } = await fetchBlob(fileUrl(rung), rung.bytes, onProgress);
    weightsSha256 = sha256;
    cache = "none";
    await w.loadModel([blob], params);
  };
  if (viaBlob) {
    await loadViaBlob();
  } else {
    try {
      await w.loadModelFromUrl(fileUrl(rung), params);
    } catch (err) {
      // the origin's storage quota is too small for the file (Safari, private
      // windows, tiny disks): run from a Blob and just do not cache
      if (!/quota|transient|out of memory/i.test(String(err && err.message || err))) throw err;
      await loadViaBlob();
    }
  }
  const vocab = await w.getVocab(false);
  const info = w.getLoadedContextInfo();
  current = new Lens(rung, w, vocab, info, nThreads);
  current.cache = cache;
  current.weightsSha256 = weightsSha256;
  current.fp = await fingerprint(current.fingerprintParts());
  return current;
}

// stream a file into a Blob with progress; hash it when it fits one buffer
async function fetchBlob(url, total, onProgress) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`${url}: HTTP ${res.status}`);
  const reader = res.body.getReader();
  const chunks = [];
  let loaded = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
    loaded += value.byteLength;
    onProgress?.({ loaded, total: total || Number(res.headers.get("content-length")) || loaded });
  }
  const all = new Uint8Array(loaded);
  let off = 0;
  for (const c of chunks) { all.set(c, off); off += c.byteLength; }
  chunks.length = 0;
  let sha256 = null;
  if (loaded < 2 ** 31) {
    const digest = await crypto.subtle.digest("SHA-256", all);
    sha256 = [...new Uint8Array(digest)].map(b => b.toString(16).padStart(2, "0")).join("");
  }
  return { blob: new MemorySource(all), sha256 };
}

// Blob-shaped view over one buffer. wllama reads a model through size, slice()
// and stream(); a real Blob this large goes through WebKit's blob loader, which
// fails ("too much data buffered"), so the bytes are served from memory instead.
class MemorySource {
  constructor(bytes) { this.bytes = bytes; this.size = bytes.byteLength; }
  slice(start = 0, end = this.size) {
    const bytes = this.bytes;
    return {
      size: end - start,
      arrayBuffer: async () => bytes.slice(start, end).buffer,
    };
  }
  stream() {
    const bytes = this.bytes;
    const step = 4 * 1024 * 1024;
    let pos = 0;
    return new ReadableStream({
      pull(ctrl) {
        if (pos >= bytes.byteLength) { ctrl.close(); return; }
        ctrl.enqueue(bytes.slice(pos, Math.min(pos + step, bytes.byteLength)));
        pos += step;
      },
    });
  }
}

export function currentLens() { return current; }

export async function unloadLens() {
  if (!current) return;
  const old = current;
  current = null;
  await old.w.exit();
}

export class Lens {
  constructor(rung, w, vocab, info, threads) {
    this.rung = rung;
    this.name = rung.id;
    this.w = w;
    this.threads = threads;
    this.nVocab = vocab.nVocab;
    this.nCtx = rung.nCtx ?? 2048;
    this.eosId = vocab.tokenEos;
    this.eogIds = new Set(vocab.listTokensEog);
    this.addBos = !!info.add_bos_token;
    this.bosToken = info.token_bos;
    this.pieces = vocab.pieces.map(b => utf8.decode(b));
    this.cancelFlag = false;
    this.fp = null;
  }

  fingerprintParts() {
    return {
      engine: this.rung.engine?.commit ?? null,
      model: this.rung.id,
      sha256: this.rung.sha256,
      quant: this.rung.quant,
      device: "wasm-cpu",
      flashAttn: false,
      nCtx: this.nCtx,
    };
  }

  encodeText(text) { return this.w.tokenize(text, false); }
  async decodeTokens(ids) { return utf8.decode(await this.w.detokenize(ids, false)); }
  decodeOne(id) { return this.pieces[id] ?? ""; }

  get bosId() { return this.addBos ? this.bosToken : null; }

  // context ids for a completion prompt (BOS + plain ids), matching encoder.py
  async completionContext(prompt) {
    const ids = await this.encodeText(prompt);
    const bos = this.bosId;
    return bos !== null && (ids.length === 0 || ids[0] !== bos) ? [bos, ...ids] : ids;
  }

  cancel() { this.cancelFlag = true; }

  async step(ids, reset = false) {
    if (this.cancelFlag) { this.cancelFlag = false; throw new Cancelled(); }
    return (await this.w.rawEval(ids, { reset })).logits;
  }

  // Prefill is the seed alone; every later token is chosen by decide() from the
  // previous step's logits and fed back as a single step. stopOn ends the run
  // early when decide() returns one of those ids (the encoder passes the
  // end-of-generation set). Returns [seedId, ...stepped].
  async run(seedId, maxNew, decide, { stopOn } = {}) {
    const stepped = [];
    let logits = await this.step([seedId], true);
    for (let i = 0; i < maxNew; i++) {
      const id = decide(logits);
      stepped.push(id);
      if (stopOn && stopOn.has(id)) break;
      if (i + 1 < maxNew) logits = await this.step([id]);
    }
    return [seedId, ...stepped];
  }
}
