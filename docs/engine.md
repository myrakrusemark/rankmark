# The browser engine

Everything runs in the visitor's browser. The model is llama.cpp compiled to WASM (the wllama fork, see
`engine-spike.md`), driven one token per `llama_decode` call so writing and reading take identical kernel paths.
No server, no WebGPU.

## Modules (`web/engine/`)

| Module | Role |
|---|---|
| `registry.json` | The ladder: repo, revision, file, sha256, quant, heap, tier, tag cap, carrier rate, plus the engine build. A lens id is frozen once texts carry it. |
| `models.js` | Loads the registry, resolves a rung to its Hugging Face URL (single file; the memory64 build has no 2 GB limit). |
| `lens.js` | One resident lens. `loadLens(rung)`, `run(seed, maxNew, decide, {stopOn})`, `encodeText`, `decodeTokens`, `decodeOne`, `cancel`. Pins `flash_attn: false`, `n_ctx` 2048, threads = min(8, cores/2) when cross-origin isolated. |
| `encoder.js` | `embed(lens, opts, onEvent)`: greedy or same-parity temperature sampling (port of `channel.py`), the end-of-generation set banned until one frame is planted, token budget `ceil(frameBits / carrierRate * 1.3)` capped by the context. |
| `decoder.js` | `decode(lens, text, opts, onEvent)`: teacher-forced single steps, soft bits, frame parse. |
| `sampling.js` | mulberry32 seeded RNG, softmax sampling. The JS sampler is its own reference; a seed reproduces a browser run, not a Python one. |
| `fingerprint.js` | Lens fingerprint (engine commit, model, sha256, quant, threads, attention kernel, n_ctx), text hash, mark card build and parse. |
| `worker.js` | Owns the lens. Commands: `load`, `embed`, `decode`, `cancel`, `unload`, `info`. Replies: `progress`, `ready`, `event`, `done`, `cancelled`, `error`. |
| `probe.js` | Main-thread feature tests: Memory64, JSPI, isolation, `deviceMemory`, storage quota. Recommends the largest passing rung up to the 4B tier; 8B is offered, never recommended, because `deviceMemory` is capped at 8. |
| `logits.js`, `bits.js`, `framing.js`, `ecc.js` | Unchanged frame stack, validated by the 90 Python vectors. |

## The mark card

Every write produces the text plus one footer line:

```
rankmark: Qwen3-0.6B-Q8_0 f=ab757b9c59cf t=3f0e9a1c22b7
```

`f` is the lens fingerprint, `t` the hash of the exact text. The reader strips the footer before tokenizing,
compares `t` to the pasted text (a difference is reported as "altered in transit" before any verdict), and compares
`f` to its own lens (a difference names the mismatch instead of reporting "no frame"). Without a footer the reader
makes no claim about either.

## Measurements (this laptop: i5-1135G7, 8 threads, headless Chromium, CPU only, 2026-09-05)

The first numbers (2026-09-04) were taken in a headed Chrome with WebGPU, and wllama offloads every layer to the
GPU by default (`n_gpu_layers` 99999), so they were GPU-assisted and about 1.5 to 3 times faster than these. The lens
now pins `n_gpu_layers: 0`; the GPU and CPU paths produce different logit rows (hash `5d21ff2ea08f8319` on the
Intel GPU vs `ca3e23e2a6997865` on CPU, same weights, same build), which is why the site is CPU-only. The table
is the measurement campaign (`web/test/ci/campaign.mjs`, records in `web/data/measurements.json`): one seeded
write of a 1-byte lean frame (79 bits) at temperature 0.7 and tau 2.0, then its read.

| Rung | Speed | Carrier rate at tau 2.0 | Write | Read |
|---|---|---|---|---|
| Qwen3-0.6B Q8_0, 0.64 GB | 4.8 tok/s | 40% | 330 tokens, 1.9 frames, 69 s | valid, 42 s; survives a tail cut, not a head cut |
| Qwen3-1.7B Q8_0, 1.83 GB | 2.1 tok/s | 7% | 770 tokens (budget cap), 0.75 frames, 6.2 min | no frame, 5.5 min |
| Qwen3-4B Q4_K_M, 2.5 GB | 1.0 tok/s | 6% | 770 tokens, 0.62 frames, 13 min | no frame, 9.6 min |
| Qwen3-8B Q4_K_M, 5.03 GB | 0.6 tok/s | 6% | 770 tokens, 0.68 frames, 22 min | no frame, 28 min |

The bigger rungs are more confident, so at tau 2.0 fewer than one word in twelve carries a bit and a frame does
not fit inside the budget. tau is per rung in the registry. The entropy profile pass (`MODE=entropy`, results under
`entropy` in `measurements.json`) writes 200 tokens per rung at temperature 0.7 and records the carrier rate at
eight gates:

| Rung | mean entropy (nats) | tau 0.75 | tau 1.0 | tau 1.25 | tau 1.5 | tau 2.0 | chosen tau | registry rate |
|---|---|---|---|---|---|---|---|---|
| 0.6B | 1.97 | 65% | 60% | 57% | 52% | 46% | 2.0 | 0.40 |
| 1.7B | 1.18 | 58% | 51% | 44% | 37% | 19% | 1.25 | 0.35 |
| 4B | 0.78 | 39% | 31% | 23% | 17% | 9% | 1.0 | 0.25 |
| 8B | 0.78 | 44% | 32% | 24% | 17% | 7% | 1.0 | 0.25 |

The registry rate is discounted below the profile because longer texts drift into confident territory (the 0.6B
measured 40% over 330 tokens against 46% on the profile, and one story write at seed 20260905 carried only 21%).
That write also exposed the budget rule: with 1.3 times the expected tokens it stopped at 71 of 103 bits. The
encoder now allows 2.0 times; a write stops at the first sentence end past the seal, so the slack costs nothing on a
normal text. The recorded run in `web/data/snapshot.json` is a 1.7B write at tau 1.25: 217 tokens, 107 carriers
(49%), the 103-bit frame planted once and read back.

Sibling reads (writer at tau 2.0, 200 tokens, seed 777; each other rung reading the same text) never validate.
Bit agreement on the words both models treat as carriers runs 53 to 71%, against 50% for a coin, and the two models
rarely agree on which words are carriers at all (the 4B text has 21 carrier words for the 4B, 76 for the 0.6B).
That is the lineup section's point: a sibling model gets most easy words right and orders the near-ties differently.

## Determinism: measured

The CI matrix (`.github/workflows/determinism.yml`, records in `web/data/determinism/`) runs a fixed prompt and a
seeded write-plus-read on GitHub's runners: Linux x86, Linux ARM64, Windows x86 and Apple Silicon macOS, each on
Chromium, Firefox and WebKit, at the default thread count and at one thread, with the downloaded weights hashed
against the registry. On 2026-09-05 all twelve produced the same logit row (`ca3e23e2a6997865`), the same text,
the same ranks and the same carrier bits, and this laptop matches them. A text written on one machine reads on
another; "portable" is measured, not argued.

What broke it before the pin: WebGPU. wllama offloads every layer to the GPU by default, and the GPU row for the
same weights hashes differently (`5d21ff2ea08f8319` on this laptop's Intel GPU). The lens sets `n_gpu_layers: 0`
and the fingerprint records the device.

Local checks on top of that: 100 fresh prefills give one hash; one-call and per-token prefill agree; the same seed
reproduces the same text; run-to-run and thread count never change bits.

## Safari

The wasm32 compat build of the fork (not yet built) caps the heap at 4 GiB and files at 2 GB, so Safari gets the
0.6B and 1.7B rungs only. The page's probe hides the rest there.
