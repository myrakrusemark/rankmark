I have everything needed. Producing the merged build plan directly.

# Keyed Rank-Lens Watermark — Merged Build Plan

## 1. System definition

We hide a small self-validating payload in generated text by nudging each token choice against a **known model's next-token distribution** — the model is the **lens**. Reading text back through that same lens gives, per token, a rank (where the realized token sat in the model's sorted logits); rendered GLTR-style that rank pattern is the **heatmap** (green top-10, yellow top-100, red top-1000, purple beyond). The deliberate rank perturbations we plant are the **freckles** — a light, recoverable dusting on top of the model's natural distribution — and when framed with sync + checksum they form a self-clocking **barcode** the decoder can find without knowing where it starts. Attribution is the twist: re-decode the text through each candidate model's own logits; the author is the one lens under which the barcode's checksum validates. There is no secret key — **the key is the model itself** (Jiang et al. rank-token mapping fused with a BREW-style designated-codeword gate, the argmax-over-candidates identification of Fu & Russell, and GLTR as the visual surface).

## 2. The one decision to make up front: naive rank-threshold vs Meteor-style invisible embedding

Two ways to plant freckles:

- **Arm A — naive rank-binning (legible).** Bit = parity of the chosen token's rank inside a top-K entropy window. Decode is literally `rank % 2`. Zero shared state, trivially visible in the heatmap as a barcode. Not distortion-free — a GLTR/DetectGPT/Binoculars classifier can smell it. (Degenerate 1-bit case of Jiang et al.; structurally KGW's green/red split without the hash.)
- **Arm B — Meteor/Discop distribution-matched (covert).** Partition the CDF into equal-probability-mass intervals, index by payload bits, sample within — the marginal emitted distribution matches the model's, so the heatmap looks like ordinary sampling (Ziegler et al. arithmetic-coding lineage; distortion-free per Kuditipudi/PRC). Higher security, lower legible-signal, more code.

**Build Arm A first, keep Arm B as a swappable channel behind the same interface.** Arm A is the fastest path to a visible thesis and — critically — it makes the *one experiment that can kill the project* cheap to run (does a wrong-model lens fail the checksum?). The legibility is a feature at MVP: you can *see* the barcode snap in and out as you swap lenses. Arm B is a Phase-4 arm that quantifies exactly what legibility costs on the detectability axis; it's the honest counterweight to Arm A's "too clean is detectable" paradox, not a prerequisite for first light. Design `channel.py` with an `encode_step(dist, bits) -> token` / `decode_step(dist, token) -> (bits, llr)` contract so A and B are drop-in.

## 3. Phased plan

Stack throughout: **Python 3.11, PyTorch 2.4+, HuggingFace `transformers`/`tokenizers`, `numpy`, `scipy`.** Everything consumes one atomic record:

```python
@dataclass
class TokenObs:
    pos: int
    token_id: int
    rank: int          # 0-indexed rank of realized token in this lens's sorted logits
    logprob: float
    entropy: float     # H(p_t), nats — drives the carrier/null gate
    bucket: int        # GLTR: 0=top10 1=top100 2=top1000 3=beyond
```

`ranks = [o.rank for o in obs]` is the single object encode / decode / heatmap / attribution all read.

### Phase 0 — Scaffold + determinism harness

The determinism harness is not setup, it's the load-bearing wall. Rank recovery requires the decoder to reproduce the encoder's exact logit *ordering*; float nondeterminism flipping near-ties is the dominant silent failure.

- **Repo:** standalone `research/rankmark/` (kept out of the site build per this project's engine/experimentation separation — do **not** wire into myrakrusemark.com). `pyproject.toml`, `pytest`.
- **`models.py`:** deterministic lens loader + logit cache. `torch.use_deterministic_algorithms(True)`, `model.eval()`, `torch.no_grad()`, `allow_tf32=False`, batch size 1, one frozen dtype policy (**fp32 on CPU for MVP; bf16 documented if GPU** — fp16 rank ties are a known wall). Pin `transformers`/`torch`/CUDA and **stamp the commit SHA + tokenizer.json hash into every artifact** — a quant/dtype/revision change reorders ranks and silently breaks decode.
- **`tokenobs.py`:** teacher-forcing pass (feed observed tokens, read the distribution at each position), `rank_of` with tie-break `sort by (-logit, token_id)` — identical rule both sides.
- **Determinism regression test:** decode same text twice → assert identical ranks; then decode on a second machine/torch build → the canary for float-tie flips. **If this fails, all capacity claims are void — fix before proceeding.**
- **Models:** start MVP-cheap for real-time CPU iteration — `gpt2` (124M, GLTR's exact backing model) primary; `distilgpt2` (the deliberate same-family hard negative), `pythia-160m`, `opt-125m` (different tokenizers) as the pool. Graduate to 7–8B (`Mistral-7B-v0.3` base + `Llama-3.1-8B`/`Qwen2.5-7B` cross-family, plus a 4-bit quant and a LoRA variant of the primary) in Phase 3/4 where within-family false-attribution actually gets stress-tested.

**Libraries:** `torch`, `transformers`, `tokenizers`, `pytest`.

### Phase 1 — MVP: embed + decode + heatmap (Arm A, no ECC)

Goal: the thesis made visible in ~500 LOC, CPU-runnable.

- **`channel.py` (Arm A):** entropy-gated rank-parity. Per step: sort logits; if `H(p_t) < τ` (top token dominates) emit rank-0 as a **carrier-null**, don't advance the bit index; else pick the highest-prob token in the top-K window whose `rank % 2 == next_bit`. Self-clocking in token order; the gate is a deterministic function of the lens's own distribution, so encoder/decoder agree on carrier positions **only if the lens matches** — the desync-under-wrong-model *is* the attribution signal, previewed here.
- **`decoder.py`:** teacher-force → recompute ranks → re-apply the *same* `τ` gate to find carriers → `bits = [rank%2 for carriers]`. No stored per-text state; encoder and decoder share only the algorithm and `τ`. That's what keeps "the key is the model" honest.
- **`heatmap.py`:** GLTR buckets rendered as `<span style="background:…">` into a standalone `.html` (plus a `rich` terminal version). Second row of ticks marks bit-carrying tokens and their parity — you literally see the barcode. **Money shot:** same watermarked text rendered through gpt2 (author) vs pythia (impostor), side by side.
- **`cli.py`:** `embed / decode / heatmap`.

**Milestone gate:** round-trip a random payload embed→decode on gpt2 at ~100% (0 edits), report usable bits/token (~0.3–0.6 after gating). This proves the rank-parity channel and determinism before any ECC investment.

**Libraries:** stdlib + Phase-0 stack; `rich` for terminal heatmap.

### Phase 2 — ECC + framing + robustness

Turn the raw bit channel into a mangling-survivable, self-clocking, checksum-gated frame. This is where robustness budget is spent.

- **`framing.py`** — self-clocking frame, repeated back-to-back so a truncated quote still contains ≥1 whole frame:
  ```
  [ SYNC | HEADER | ECC( PAYLOAD ‖ CHECKSUM ) ]  ×N
  ```
  - **SYNC:** PN / m-sequence (Barker-like) with a sharp autocorrelation peak; the decoder slides a correlator to find frame boundaries → recovers copy-paste-from-the-middle. Allow a small Levenshtein window around the next expected offset for insertion/deletion resync (Kuditipudi / Qu et al.).
  - **HEADER:** frame length, ECC params, **model-namespace tag**, designated-codeword class — repetition-coded ×5, majority vote (tiny and catastrophic to lose).
  - **CHECKSUM = designated codeword (BREW/CORE-BREW):** n-bit CRC/signature (`MAGIC` + `crc32`). **This is the attribution gate.** Accept only if checksum validates *and* the designated class matches. A random wrong-lens decode passing MAGIC(16b)+CRC(32b) is ~2⁻⁴⁸ — that product, not the ECC, is what drives false attribution down.
- **`ecc.py`** — concatenated coding on soft input (`SoftBit` = LLR carried end-to-end):
  - Outer **Reed–Solomon over GF(2⁸)** (`reedsolo`, cross-check `galois`) — burst/erasure robustness, Qu et al. construction.
  - **Block interleave (depth ~32)** — scatters a deleted-sentence burst across many RS symbols.
  - Inner **rate-1/2 convolutional + soft Viterbi** — absorbs dense near-tie rank noise as LLRs, not hard flips.
  - **Repetition ×3+** on the frame (STEAD) for autoregressive error-propagation resilience.
- **Ablation baked in:** MAGIC/CRC on vs RS-only. RS-only will "correct" random noise into spurious payloads — reproducing BREW's false-detection warning empirically and proving the gate earns its place.

**Milestone gate:** recover ≥1 valid frame from any ~150-embeddable-token span after truncation; graceful degradation up to RS budget under edits, honest cliff after.

**Libraries:** `reedsolo`, `galois`, a small conv/Viterbi impl (or `pyldpc`), `scipy`.

### Phase 3 — Multi-model attribution

- **`attribute.py`:** loop candidate lenses, decode each, collect gate-passing frames.
  ```
  for M in pool: r = decode(text, M); if r.valid: results.append((M, payload, llr_margin))
  ```
  Handle **cross-tokenizer** wrangle at the string level: re-tokenize the raw text under each candidate's own tokenizer. Different tokenizer → different boundaries → different gating → different ranks → checksum fails. That's the mechanism, not a bug.
- **Selection is NOT bare argmax** (Fu & Russell / Wu et al.: max over K lenses inflates FPR toward 1). Layered mitigations, all *measured* not assumed: (1) designated-codeword gate first — only checksum-valid frames enter, the ~2⁻ⁿ filter; (2) **Bonferroni/Šidák** correction over K **and** the number of sync offsets tried (the real comparison count); (3) **namespace-tag consistency** — a frame CRC-passing under Mistral but carrying Llama's tag is rejected as collision artifact; (4) **co-fire policy:** if two lenses validate (expected for within-family), return `AMBIGUOUS{set}` tie-broken by LLR margin and flagged low-confidence — never force a winner.
- **Output states:** `ATTRIBUTED(M, payload, p)`, `AMBIGUOUS(set)`, `UNATTRIBUTED`.

**Go/no-go gate (the whole project hinges here):** embed under the primary; confirm it decodes-and-validates under the primary and decodes-and-**rejects** under a cross-family lens on clean text. That single cross-model reject is the proof-of-concept. If the gate cannot separate true-lens from wrong-lens on clean text, the novelty is unsound — **stop before scaling the pool.**

**Libraries:** Phase-2 stack; `scipy.stats` for correction.

### Phase 4 — Evaluation

`eval/harness.py` — one entrypoint, emits all figures + `results.json`. Datasets: C4/OpenWebText continuations + a held-out **human-written control** (unwatermarked must attribute to nobody). Add a covert-arm build of `channel.py` (Arm B, Meteor/PRC distortion-free) here for the security contrast.

1. **Capacity vs perplexity** — sweep `τ, δ, K`; bits/token vs perplexity increase, Arm A vs Arm B. Expect A carries more, sits right on DetectGPT; B hugs base perplexity.
2. **Attribution FPR (headline)** — grid `n ∈ {8,16,24,32}` × pool size K × composition (cross-family / within-family / **4-bit quant** / **LoRA**). Report true-attribution, aggregate false-attribution, and empirical-vs-`K·2⁻ⁿ`. *The open question: does a Mistral-v0.3-embedded frame reliably FAIL to validate under Mistral-v0.1 / its quant / a LoRA? If quant shares enough rank structure to false-validate, that is the paper's key (still-publishable) negative result.*
3. **Detectability** — GLTR / DetectGPT / Fast-DetectGPT / Binoculars separating marked (both arms) from base. Target AUC ≈ 0.5 for Arm B; quantify Arm A's security cost.
4. **K-scaling FPR curve** — grow the pool, plot empirical FPR vs the Fu & Russell bound; verify the gate holds it flat where argmax would climb.
5. **Robustness gauntlet** — random edit/insert/delete 0–40% (target ≥15% edits, Qu et al. ~17 edits/para); sentence deletion/truncation; **DIPPER paraphrase + round-trip translation (EXPECTED FAILURE — quantify the death)**.
6. **Ablations** — remove checksum (false detections reappear), remove entropy gate (perplexity explodes), remove interleave (burst cliff), hard vs LLR soft decode.
7. **Determinism stress** — encode GPU-A / decode GPU-B / CPU / different torch → rank-flip rate and its effect on decode. The mundane failure most likely to sink deployment.

**Libraries:** `evaluate`/perplexity, `datasets`, DIPPER (Krishna et al.), GLTR public code (`HendrikStrobelt/detecting-fake-text`), Fast-DetectGPT/Binoculars references, `scipy`, `matplotlib`.

## 4. Sharp risks and where each is addressed

- **Determinism / tokenizer reproducibility (most likely to silently sink it).** Rank recovery needs bit-comparable *ordering*, and fp16 ties, TF32, GPU-matmul reordering, dtype/quant/revision drift, and BPE-merge round-trip ambiguity all flip ranks. → **Phase 0** builds the harness and the two-machine canary *first*; artifacts stamp torch/transformers/CUDA/tokenizer hashes; **Phase 4 exp. 7** quantifies cross-device flip rate. Frozen tie-break `(-logit, token_id)` shared both sides. Encoder verifies `decode(encode(x)) == x` at build time.
- **Paraphrase / round-trip-translation laundering (the unavoidable wall).** In-text marks die by construction (Krishna et al.: DetectGPT 70.3%→4.6%). → Not hidden: **Phase 4 exp. 5** measures the death explicitly; the honest architecture names an **out-of-band retrieval/fingerprint fallback** (hash+embed every emitted doc, attribute laundered text by nearest-neighbor) as the acknowledged escape hatch — built last, only after the intrinsic path is characterized, and flagged as breaking the "purely intrinsic, no side-info" story.
- **The too-clean-is-detectable paradox.** To be a recoverable payload the freckles must perturb sampling away from the natural distribution, which *reduces* stego-security (Ziegler KL argument vs Kuditipudi/PRC distortion-free ideal). Legible barcode ⟂ indistinguishable output. → Resolved by making it a **measured axis, not a claim**: the Arm A / Arm B split (§2) with **entropy gating** (only spend the channel where entropy exists — the Discop insight, so low-entropy positions stay natural) and **Phase 4 exp. 3** plotting the security cost. The heatmap's marked-vs-unmarked side-by-side view instruments the leak directly — if marked is visibly greener, `τ` is mis-tuned.
- **Multi-candidate FPR inflation (Fu & Russell wall).** Trying K lenses and taking max drives FPR → 1. → **Phase 3** never uses bare argmax: checksum gate (~2⁻ⁿ) + Bonferroni over K-and-offsets + namespace consistency + AMBIGUOUS reporting; **Phase 4 exp. 4** verifies the curve stays flat.
- **Within-family false attribution (the empirical crux).** Idiosyncrasies shows separability collapses ~97%→~60% within family; quant/LoRA may share rank structure enough to false-validate. → The pool is *designed* around this (distilgpt2 at MVP; quant+LoRA+v0.1 neighbors at scale); **Phase 3 go/no-go** and **Phase 4 exp. 2** are built to *falsify* the core assumption, and a family-level-only result is pre-committed as an honest publishable outcome.

## 5. What makes this novel / publishable

Every ingredient is published (2019–2026): rank-token-mapping stego (Jiang et al.), RBC/PRC ECC watermarking (Chao; Christ–Gunn), the GLTR rank heatmap (Gehrmann–Strobelt–Rush), the BREW designated-codeword gate (J. Kim et al.), and the argmax-over-candidates identification with its FPR wall (Fu & Russell). **The unclaimed hinge is the attribution mechanism: using each candidate model's own predicted next-token distribution as the swappable decoding lens, so the "key" is the model itself** — authorship is established when the text, read through model M's logits, yields a rank-deviation pattern that checksum-validates, and fails under every other model's logits. This fuses two lines the literature keeps strictly separate: (1) rank-token-mapping already *requires* the exact model to decode but never turns that model-dependence into an attribution test; (2) every published multi-candidate attribution scheme (PersonaMark, WASA, Three Bricks, Multi-use LLM Watermarking) keys on a stored per-provider/per-user secret or an intrinsic fingerprint classifier — **none re-runs the text through each candidate model's own logits and lets a checksum select the author.** The self-clocking Morse/barcode framing of the payload is likewise not adopted by any surveyed system (they use RS/BCH/PRC codewords, not human-legible structure).

The load-bearing empirical claim is **untested and falsifiable**, which is exactly why it's worth building: does a rank-deviation payload embedded under model A reliably *fail* to checksum-validate under model B — especially B ∈ {same-family, quantized, LoRA}? **Phase 3's cross-model reject and Phase 4 exp. 2 are designed to break that assumption.** If it holds cross-family but degrades under quantization/finetuning, the honest paper writes itself: *"model-as-lens attribution works across architectures but degrades to a family-level signal under quantization/finetuning"* — a clean, citable result either way. Confidence the full composite is unpublished is MEDIUM (a search negative, not a proof), so the first deliverable after Phase 3's gate should be a focused arXiv/lit sweep under the field's inconsistent terminology ("identification," "source attribution," "fingerprinting") before committing to the full evaluation.