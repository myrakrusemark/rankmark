// Phase 1 spike: a Lens over the wllama fork's raw_eval, the same shape lens.js
// exposes to encoder.js / decoder.js. One llama_decode per token, so prefill and
// generation take identical kernel paths; every logit row is the full vocab.

import { Wllama } from "/vendor/wllama/index.js";

const WASM = "/vendor/wllama/wllama.wasm";
const utf8 = new TextDecoder();

export class LlamaLens {
  constructor(name, w, vocab, opts) {
    this.name = name;
    this.w = w;
    this.opts = opts;
    this.nVocab = vocab.nVocab;
    this.eosId = vocab.tokenEos;
    this.eogIds = new Set(vocab.listTokensEog);
    this.pieces = vocab.pieces.map(b => utf8.decode(b));
  }

  static async load(name, url, opts = {}) {
    const w = new Wllama({ default: WASM }, {
      parallelDownloads: 3,
      suppressNativeLog: !opts.nativeLog,
    });
    await w.loadModelFromUrl(url, {
      n_ctx: opts.n_ctx ?? 2048,
      n_threads: opts.n_threads ?? 4,
      flash_attn: false,   // pin one attention kernel; auto could differ per build
      warmup: false,
      progressCallback: opts.onProgress,
    });
    const vocab = await w.getVocab(false);
    return new LlamaLens(name, w, vocab, opts);
  }

  async unload() { await this.w.exit(); }

  // Qwen3 adds no BOS; the real adapter will read add_bos from the model
  get bosId() { return null; }

  encodeText(text) { return this.w.tokenize(text, false); }
  async decodeTokens(ids) { return utf8.decode(await this.w.detokenize(ids, false)); }
  decodeOne(id) { return this.pieces[id] ?? ""; }

  completionContext(prompt) { return this.encodeText(prompt); }
  instructContext() { throw new Error("instruct mode is not part of the spike"); }

  async step(ids, reset = false) {
    return (await this.w.rawEval(ids, { reset })).logits;
  }

  // Same contract as lens.js run(): prefill is the seed alone, every later token is
  // chosen by decide() from the previous step's logits. End-of-generation tokens
  // are masked out on both sides so a completion-mode model cannot stop early and
  // encode/decode see the same rows.
  async run(seedId, maxNew, decide) {
    const stepped = [];
    let logits = await this.step([seedId], true);
    for (let i = 0; i < maxNew; i++) {
      this.maskEog(logits);
      const id = decide(logits);
      stepped.push(id);
      if (i + 1 < maxNew) logits = await this.step([id]);
    }
    return [seedId, ...stepped];
  }

  maskEog(logits) {
    for (const t of this.eogIds) logits[t] = -1e30;
  }
}
