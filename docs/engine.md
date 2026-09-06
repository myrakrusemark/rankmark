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
| `encoder.js` | `embed(lens, opts, onEvent)`: greedy or same-parity temperature sampling (port of `channel.py`), the end-of-generation set banned until one frame is planted, token budget `ceil(frameBits / carrierRate * 2.0)` capped by the context, and a stop at the first sentence end past the seal. |
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

| Rung | Speed | tau | Carriers | Write | Read |
|---|---|---|---|---|---|
| Qwen3-0.6B Q8_0, 0.64 GB | 4.8 tok/s | 2.0 | 40% | 330 tokens, 1.9 frames, 69 s | valid, 42 s; survives a tail cut, not a head cut |
| Qwen3-1.7B Q8_0, 1.83 GB | 1.5 to 2.1 tok/s | 1.25 | 56% | 140 tokens, 1.1 frames, 1.5 min | valid, 1.3 min; neither cut survives |
| Qwen3-4B Q4_K_M, 2.5 GB | 0.7 to 1.0 tok/s | 1.0 | 68% | 124 tokens, 1.2 frames, 2.8 min | valid, 1.9 min |
| Qwen3-8B Q4_K_M, 5.03 GB | 0.5 to 0.6 tok/s | 1.0 | 59% | 125 tokens, 1.0 frames, 4.4 min | valid, 3.9 min |

The first pass ran every rung at tau 2.0: the 1.7B, 4B and 8B carried 6 to 9% of words and stopped at 0.6 to 0.75
of a frame after 770 tokens. The rows above are the second pass at the per-rung tau chosen below; the slower speeds
in the ranges were measured while page tests overlapped the run. The realized carrier rates at tau 1.0 to 1.25 are
well above what the entropy profiles predicted (31 to 44%), most likely because forcing rank parity at more
positions pushes the text into less predictable continuations, so later words are less certain too.

The bigger rungs are more confident, so at tau 2.0 fewer than one word in twelve carries a bit and a frame does
not fit inside the budget. tau is per rung in the registry. The entropy profile pass (`MODE=entropy`, results under
`entropy` in `measurements.json`) writes 200 tokens per rung at temperature 0.7 and records the carrier rate at
eight gates:

| Rung | mean entropy (nats) | tau 0.75 | tau 1.0 | tau 1.25 | tau 1.5 | tau 2.0 | chosen tau | registry rate |
|---|---|---|---|---|---|---|---|---|
| 0.6B | 1.97 | 65% | 60% | 57% | 52% | 46% | 2.0 | 0.40 |
| 1.7B | 1.18 | 58% | 51% | 44% | 37% | 19% | 1.25 | 0.45 |
| 4B | 0.78 | 39% | 31% | 23% | 17% | 9% | 1.0 | 0.45 |
| 8B | 0.78 | 44% | 32% | 24% | 17% | 7% | 1.0 | 0.45 |

The registry rate sizes the budget and the minutes shown to the visitor. It sits between the profile and the second
pass: longer texts drift into confident territory (the 0.6B measured 40% over 330 tokens against 46% on the
profile, and one story write at seed 20260905 carried only 21%), so the rate is held under the short-text
measurement. That story write also exposed the budget rule: with 1.3 times the expected tokens it stopped at 71 of 103 bits. The
encoder now allows 2.0 times; a write stops at the first sentence end past the seal, so the slack costs nothing on a
normal text. The recorded run in `web/data/snapshot.json` is a 1.7B write at tau 1.25: 217 tokens, 107 carriers
(49%), the 103-bit frame planted once and read back.

Sibling reads (writer at tau 2.0, 200 tokens, seed 777; each other rung reading the same text) never validate.
Bit agreement on the words both models treat as carriers runs 53 to 71%, against 50% for a coin, and the two models
rarely agree on which words are carriers at all (the 4B text has 21 carrier words for the 4B, 76 for the 0.6B).
That is the lineup section's point: a sibling model gets most easy words right and orders the near-ties differently.

## Edits: measured, and why the lean frame stays

`web/test/ci/edits.mjs` writes "hello" once per frame profile and reads the text back after edits. On the 1.7B
(seed 4242, harbor opening):

| Edit | lean (244 tokens, 115 carriers) | standard (843 tokens, 286 carriers) |
|---|---|---|
| untouched | valid, 100% | valid, 100% |
| one word swapped at 25% | fails, 88% agreement | fails, 88% |
| one word swapped at 50% | fails, 89% | fails, 90% |
| one word swapped at 75% | fails, 94% | valid, 97% |
| second sentence deleted | fails, 75% | fails, 68% |
| last 20% cut | fails, 100% of the surviving 85 | fails, 100% of the surviving 240 |

A changed word disturbs about one in ten of the carrier bits after it, because every later word is scored against a
context that now contains the change. Error correction can absorb the handful of flips an edit near the end causes
(the one standard-frame success, 8 flips in 286) and nothing else, at three and a half times the text. So the
examples keep the lean frame and section five shows agreement instead of validity. The structural fix is windowed
scoring: choose and score each word against only the last few dozen words, so an edit disturbs a window rather than
the rest of the text; then a standard frame would validate through single edits. That is an engine change (the
writer must generate from the same windowed view) and is not built.

## Copies, combining, and the window (branch feat/frame-copies, 2026-09-06)

Three changes follow from the edit measurements above, in the order they pay off.

**The copies profile (3).** The lean frame without its repair bytes: knock, label, message, checksum; 87 bits for a
five-byte message against 103. Its knock is the Barker code inverted, so a lean frame never answers to it and the
parser never reports one frame twice. Two parity bytes bought one corrected byte, which is no help against the one
in five bits an edit flips; the same bits buy most of another copy.

**Copies.** `opts.copies` makes the writer keep going until that many frames are planted (the end-of-text ban and
the sentence-end stop hold until the last copy; the budget is `frameBits × (copies + 2) / rate`). Each copy carries
its own knock, so a reader finds each one wherever it lands.

**Copies, measured** (1.7B, seed 4242, harbor opening, `edits.mjs`): one copy of the copies frame took 211 tokens and,
like the lean frame, failed every edit. Three copies took 773 tokens (266 carriers, 34%) and validated through a
swap at the halfway point, a swap at three quarters and a tail cut, each time on a copy that sat clear of the
damage; the swap at a quarter (94% agreement, 7 flips over 266 bits) and the deleted sentence (70%) still failed,
and combining did not rescue them. That is the next thing to study offline from dumped LLRs: the likely causes are
a damaged knock (tolerance one) keeping a copy out of the candidate set, or a wrong length bit sending it to
another group.

**Combining at the reader.** `parseFramesSoft` keeps every copy that fails on its own as a candidate. Candidates of
one profile and one length are then summed bit by bit (the LLRs, so a bit near a tie counts for little and a
confident bit for much) and the sum is decoded: all copies first, then each left out in turn, so one false knock
cannot spoil the rest. A frame reports `combined`, the copies it took. Same in Python (`parse_frames_soft`).
`web/test/framing_copies.mjs` covers three damaged copies combining and a stray knock.

**The window.** `rung.window > 0` keeps at most that many positions in the KV cache: before each step the lens
drops the oldest through the engine's new `kv_shift` action (keep the seed, remove n, shift the rest back; llama.cpp's
context shift). Writer and reader slide at the same steps, so their logits stay identical; the window is part of the
fingerprint. The point is edits: with the whole text in view, one changed word disturbs every later word's scores;
with a window, it disturbs the words in one window, after which the copies are clean again. Needs engine build
`kv_shift` (fork commit 3333546 or later). Off until measured.

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
