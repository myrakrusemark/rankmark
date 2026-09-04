// Lens = a transformers.js causal LM driven token-by-token. Encode and decode
// both go through the SAME KV-cached generate() path (a forcing LogitsProcessor
// picks each token), so their per-step logits are numerically identical — the
// invariant the whole rank-parity scheme depends on.

import {
  AutoModelForCausalLM, AutoTokenizer, LogitsProcessor, LogitsProcessorList, Tensor,
} from "https://cdn.jsdelivr.net/npm/@huggingface/transformers@3.7.5";
import { entropyOf, rankOf, sortedTokenIds } from "./logits.js";
import { MODELS } from "./models.js";

export { entropyOf, rankOf, sortedTokenIds, MODELS };

const _cache = new Map(); // name -> Promise<Lens>

export function loadLens(name, onProgress) {
  if (!_cache.has(name)) _cache.set(name, _load(name, onProgress));
  return _cache.get(name);
}

async function _load(name, onProgress) {
  const spec = MODELS[name];
  if (!spec) throw new Error(`unknown lens ${name}`);
  const tokenizer = await AutoTokenizer.from_pretrained(spec.repo);
  const model = await AutoModelForCausalLM.from_pretrained(spec.repo, {
    dtype: spec.dtype,
    device: "wasm", // deterministic across machines; webgpu is not bit-exact
    progress_callback: onProgress,
  });
  return new Lens(name, spec, model, tokenizer);
}

// A processor that hands each step's raw logits to `decide(logits) -> tokenId`,
// then rewrites the row so greedy argmax emits exactly that token.
class ForcingProcessor extends LogitsProcessor {
  constructor(decide) { super(); this.decide = decide; }
  _call(inputIds, logits) {
    const row = logits.data ?? logits[0].data ?? logits; // [1, vocab]
    const arr = row instanceof Float32Array ? row : Float32Array.from(row);
    const chosen = this.decide(arr);
    for (let i = 0; i < arr.length; i++) arr[i] = i === chosen ? 1e4 : -1e4;
    return logits;
  }
}

export class Lens {
  constructor(name, spec, model, tokenizer) {
    this.name = name;
    this.spec = spec;
    this.model = model;
    this.tokenizer = tokenizer;
  }

  encodeText(text) {
    return this.tokenizer.encode(text, { add_special_tokens: false });
  }
  decodeTokens(ids) {
    return this.tokenizer.decode(ids, { skip_special_tokens: true });
  }
  decodeOne(id) {
    return this.tokenizer.decode([id], { skip_special_tokens: false });
  }

  get eosId() { return this.tokenizer.eos_token_id; }
  get bosId() {
    const b = this.tokenizer.bos_token_id;
    return b === undefined || b === null ? null : b;
  }

  // context ids for a completion prompt (BOS + plain ids), matching encoder.py
  completionContext(prompt) {
    const ids = this.encodeText(prompt);
    const bos = this.bosId;
    return bos !== null && (ids.length === 0 || ids[0] !== bos) ? [bos, ...ids] : ids;
  }

  // chat-templated context; only the assistant reply is ever visible/decoded
  instructContext(instruction) {
    const templated = this.tokenizer.apply_chat_template(
      [{ role: "user", content: instruction }],
      { add_generation_prompt: true, tokenize: false },
    );
    return this.tokenizer.encode(templated, { add_special_tokens: false });
  }

  // Single-token stepping loop. Prefill is exactly ONE token (`seedId`); every
  // subsequent token is produced by a cached single step and chosen by decide().
  // This is the whole ballgame for the rank invariant: a BATCHED prefill of the
  // context computes its KV differently from stepping the same tokens one by one
  // (reduction order shifts under int8/float), which flips near-tie ranks. Encode
  // and decode therefore BOTH prefill one token and step the rest — identical
  // numerics on both sides. Returns [seedId, ...all stepped tokens].
  async run(seedId, maxNew, decide) {
    const stepped = [];
    const processor = new ForcingProcessor(rawLogits => {
      const id = decide(Float32Array.from(rawLogits));
      stepped.push(id);
      return id;
    });
    const list = new LogitsProcessorList();
    list.push(processor);
    const input_ids = new Tensor("int64", BigInt64Array.of(BigInt(seedId)), [1, 1]);
    const attention_mask = new Tensor("int64", BigInt64Array.of(1n), [1, 1]);

    await this.model.generate({
      input_ids,
      attention_mask,
      max_new_tokens: maxNew,
      do_sample: false,
      num_beams: 1,
      repetition_penalty: 1.0,
      logits_processor: list,
    });
    return [seedId, ...stepped];
  }
}
