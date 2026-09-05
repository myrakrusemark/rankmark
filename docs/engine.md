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

## Measurements (this laptop: i5-1135G7, 8 threads, Chrome 145, 2026-09-04)

Correction, later the same day: these numbers were taken in a headed Chrome with WebGPU, and wllama offloads
every layer to the GPU by default (`n_gpu_layers` 99999), so they are GPU-assisted. The lens now pins
`n_gpu_layers: 0`; the GPU and CPU paths produce different logit rows (hash `5d21ff2ea08f8319` on the Intel GPU vs
`ca3e23e2a6997865` on CPU, same weights, same build), which is exactly why the site is CPU-only. CPU figures from
the measurement campaign replace this table when it finishes; expect 0.6B near 4 to 5 tok/s and 8B well under 1.

| Rung | Load (first visit, incl. download) | Single-step speed | Notes |
|---|---|---|---|
| Qwen3-0.6B Q8_0, 0.64 GB | 15 s | 7 tok/s | Round trip at temp 0.7: 796 tokens, 31% carriers, 3.5 frames, tag read back; embed 112 s, decode 82 s |
| Qwen3-1.7B Q8_0, 1.83 GB | 71 s | 3.7 tok/s | deterministic |
| Qwen3-4B Q4_K_M, 2.5 GB single file | 95 s | ~5 tok/s prefill | loads without splitting on the memory64 build |
| Qwen3-8B Q4_K_M, 5.03 GB single file | 145 s (load alone 16 s) | 2.0 tok/s | first proof of the 8 GiB heap; 5% carriers greedy, text quality good |

Temperature 0.7 raises the 0.6B carrier rate from 11.6% (greedy) to 31%, so a 1-byte lean frame needs about 330
tokens instead of 800, and the text stops looping. The registry's `carrierRate` sizes the budget; 0.6B is measured,
the others are placeholders until Phase 3 measures them.

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
