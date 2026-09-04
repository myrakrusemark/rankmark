# Engine spike: llama.cpp in WASM (Phase 1 record, 2026-09-04)

Question: can the browser engine move from transformers.js/ONNX Runtime to llama.cpp compiled to WASM, keep
Rankmark's determinism guarantees, and reach 8B? Verdict: **go.**

## What was built

Fork: `https://github.com/myrakrusemark/wllama`, branch `rankmark`, on wllama 3.7.0 (llama.cpp submodule
`c7bda030`). Local checkout `~/src/wllama`. Four actions added to the C++ glue and the TypeScript API:

- `raw_eval(tokens, reset)`: one `llama_decode` per token, returns the full logit row (151,936 floats for Qwen3) as
  raw bytes; `rawEval()` in JS hands back a `Float32Array`. Bypasses the server task queue and uses the loaded
  model's context, so it must not be mixed with `createCompletion` on the same model.
- `tokenize`, `detokenize`, `vocab`: the model's own tokenizer, which the v3 API had dropped. `vocab` returns every
  piece plus the end-of-generation ids in one call so per-token display needs no round trip.
- Memory: the memory64 build declares a 16 GiB maximum (V8's ceiling) and the worker asks for 8 GiB, stepping down
  128 MB at a time until the browser accepts. The wasm32 compat build (Safari) keeps 4 GiB.

Build: `scripts/build_wasm_podman.sh` in the fork (emsdk 4.0.20 in a podman container; `SKIP_COMPAT=1` for the
memory64 build alone, about 15 minutes on this laptop). Then `npm run build:worker && npm run build:tsup`; the
site takes `esm/index.js` and `src/wasm/wllama.wasm` into `web/vendor/wllama/`.

Harness: `web/test/spike/` (a Lens over `rawEval` with the same contract as `engine/lens.js`, and a page that runs
the checks from the console). `encoder.js` and `decoder.js` now `await` tokenizer calls, which a worker-backed lens
answers asynchronously; the fake-lens tests still pass.

## Measurements (this laptop: i5-1135G7, 8 threads, Chrome 145, crossOriginIsolated, Memory64 and JSPI present)

| Check | Result |
|---|---|
| Qwen3-0.6B Q8_0 load | 14.8 s including the 640 MB download |
| Logit row | 151,936 finite floats; "The history of cryptography begins with" -> " the", " ancient", " a" |
| Run-to-run determinism | 100 fresh prefills, 1 distinct hash; 5 greedy 64-token runs, 1 distinct sequence |
| One call vs one-per-token prefill | identical hash |
| Thread sweep 1/2/4/8 | identical hash on all four (`5d21ff2ea08f8319`) |
| Round trip, tag `a7`, lean profile, tau 2.0, 700 tokens | 81 carriers (11.6%), 1.14 frames planted, re-tokenizes cleanly; decode locks the frame and reads `a7`; embed 101 s (6.95 tok/s), decode 66 s |
| Qwen3-0.6B Q4_K_M (unsloth mirror) | loads, deterministic, 5.8 tok/s; the earlier failure was in wllama's completion API, not this path |
| Qwen3-1.7B Q8_0 (1.83 GB) | loads in 71 s including download, deterministic, 3.7 tok/s |

Single-step throughput is 6 to 8 tok/s at 0.6B through the full JS round trip (each step copies a 600 KB row out
of the worker). wllama's own completion API measured 12 tok/s on the same model, so the per-step transfer costs
about a third; moving entropy and top-k ranking into C++ would recover most of it if needed.

## Not yet shown

- Anything above 1.83 GB in the heap. The 8 GiB cap was accepted by Chrome (the worker started), but no model
  over 4 GiB has been loaded; the 4B and 8B rungs do that in Phase 2.
- Cross-machine bit-exactness. The thread sweep and the spec argument (fixed-width SIMD, row-partitioned matmuls)
  say it should hold; the CI matrix in Phase 3 is the test.
- Greedy text loops (the 700-token sample repeats one sentence). Temperature sampling is a Phase 2 item.
- The Safari compat build was skipped for the spike.
