# watermark.myrakrusemark.com: plan (v2, 2026-09-04)

Source: `/home/myra/Dropbox/Work/llm-crypto/rankmark`. Browser engine in `web/`, Python reference in `src/rankmark/`.
Target: a static site on Cloudflare Pages. Every model runs in the visitor's browser, WASM only. The page is a tool
with teaching built around it, not a marketing site.

What changed from v1: no server inference, no WebGPU, no hero, no two-release split. The inference engine changes
(section 3), which is the biggest single item in the work breakdown.

## Decisions made for you

1. **Engine: llama.cpp compiled to WASM (via a fork of wllama), replacing transformers.js/ONNX Runtime.** Reason in
   section 3: ONNX Runtime Web caps memory at 4 GB with no 64-bit build, has no 4-bit kernel on WASM (it dequantizes
   every weight matrix to fp32 on every step, measured at 0.5 tok/s for a 0.6B model), and 8B is unreachable through
   it. llama.cpp WASM measured 12 tok/s on the same 0.6B model on this laptop, already ships a 64-bit memory build,
   and its 4 GB cap is one build constant. The fork adds a full-logits export and raises that cap.
2. **Ladder: Qwen3-0.6B, 1.7B, 4B, 8B.** 8B is Chrome and Firefox only (Safari has no stable 64-bit WASM memory).
   Nothing above 8B on the page; that is the "run it locally" path.
3. **One release.** Everything live at launch. The v1 two-release split is gone.
4. **Public GitHub repo.** Needed for free CI runners on every OS and for "get the code". The repo has no remote today.
5. **Completion mode only.** Instruct/chat mode is removed: it cannot round-trip without windowed scoring
   (`src/rankmark/encoder.py:74-75`, `web/engine/decoder.js:14-21`), which is too slow in a browser.
6. **Payload is a short "tag"** (initials, a word), 1 to 8 bytes depending on model. No "secret message" framing.
7. **Qwen only. gpt2 is dropped from the page.** The "wrong model" in the lineup is a Qwen sibling (text written with
   one rung, read with another). Same tokenizer, same family, and it still fails the checksum, which is the sharper
   lesson: close is not the key. The gpt2-derived test vectors in `web/test/vectors.json` stay; they test the frame
   stack, not a model, and need no gpt2 in the browser.
8. **Motion only inside the tool**, and only where data moves: bits leaving the frame strip for the text, bits pulled
   back out on read, bits dying under an edit. Nothing below the tool animates.

## 1. Positioning

For developers, students, and anyone who has read "AI text is watermarked" and wants to see it happen. The page says
what it is in one sentence and puts the tool on screen immediately.

The comparison target is real and recent. Anthropic's post "How Claude's text watermark works"
(https://www.anthropic.com/news/claude-text-watermark, 2026-08-14, updated 2026-09-01, fetched and confirmed this
session) says future Claude models carry "a version of the SynthID-Text approach published by Google DeepMind", the
mark is keyed ("detectable to anyone who has a key"), detection reports the likelihood Claude was involved, the
detection API is limited to EU-eligible organizations and compliance customers, and code is "generally less
watermarked". Google has run SynthID-Text in Gemini since 2024. OpenAI ships no text watermark as of September 2026.

The contrast the page teaches: deployed schemes key the pattern with a secret, so only the key-holder can detect it.
Rankmark keys the pattern with the model itself: no secret, the generating model's own next-token ranking is the only
decoder, and the payload carries its checksum, so reading it back is also an attribution test among open-weight
models. The page states the flip side on the same screen: anyone with the same weights can forge it, it is visible to
GLTR-style detectors, it dies under paraphrase, and it is a research demo (Phase 3 of `docs/rankmark-build-plan.md`,
n=1 attribution evidence in `out/attribution.json`).

## 2. The page

**Top strip.** Name, one sentence ("Watch a language model hide a tag in its own words, then read it back"), the model
picker showing what this machine can run, and two links: "How this works" (scrolls down) and "Run it locally".

**The tool, three tabs.**

*Write.* Left column: the opening text the model continues, the tag, and a plain-language robustness choice (lean /
standard / robust, mapped to profiles 0/1/2 with the bit counts shown). Advanced, folded: temperature, seed, tau.
Center: the generated text streaming in. Right rail: the frame as a strip of bits, segments labelled knock, label,
your tag, seal, repair. As each carrier word is chosen, its bit slides out of the strip and lands under the word as a
solid (1) or hollow (0) underline. Words the model was sure about arrive with a brief dim pulse and no bit.

Callouts appear once each, anchored to the thing they explain, the first time it happens, dismissible, each with a
"more" that expands into the matching part of the explainer below:

| Trigger | Callout | Teaches |
|---|---|---|
| first word | "Every word is a ranked choice." Hover any word: top five candidates with ranks | text is choices |
| first skipped word | "This word carried nothing; the model was too sure." | entropy gate |
| first carrier | "This word carries a 0: the model's second choice was as good as its first." | rank parity |
| knock planted | "The knock: a fixed pattern the reader can find at any offset." | sync |
| seal closed | "Sealed: the checksum now validates the whole frame." | CRC as the gate |
| done | mark card, "Read it back", "Break it" | what to do next |

*Read.* Paste text, or carry it over. Pick a model. Underlines get pulled out word by word into an empty frame on the
right; bits from damaged words arrive faint (soft bits). The frame locks and shows the tag, or stays scattered. Verdict
copy is exact: "a Rankmark frame planted with this model validates here" / "no frame found" / "ambiguous". Break-it
controls sit on the text: delete a sentence, cut the start, cut the end, swap five words, paraphrase (precomputed). Each
edit re-runs the read (debounced, cancellable) and the visitor watches bits die or survive. Cutting the end survives;
cutting the start kills everything after it; that pair is the second lesson. A "lineup" button runs every cached rung
and shows which one validates. A sibling rung reading the text is the point of the lineup: most of its ranks look
right (both models agree on the easy words), but on the near-tie words that carry bits a different model orders the
tie differently often enough that the checksum fails. The page shows the sibling's measured carrier-bit agreement
(Phase 3) next to the verdict. With one rung cached the lineup runs on a precomputed sibling read from `snapshot.json`
and offers the second download.

*Run it locally.* Section 9.

**Below the tool: "How this works".** Static. What watermarking is; how the labs do it (Anthropic's SynthID-Text
deployment with the quotes above, Google, the red/green scheme, why "AI detectors" are not watermarks, with the
Stanford 61% false-positive figure on non-native essays); a comparison table (keyed vs keyless, zero-bit detection vs
payload, who can detect, what survives paraphrase, forgeability); the limits panel; the EU AI Act Article 50 timeline.
Two small no-model toys are optional here: a red/green list toy and a two-round tournament toy. Nothing here needs a
download.

**Mobile.** The tool works from `snapshot.json` (a precomputed run) with the same animations, and says that a live run
needs a laptop. No downloads offered on phones.

## 3. Engine and model ladder

### Why the engine changes

The current port (`web/engine/lens.js`) uses transformers.js on ONNX Runtime Web with int8 weights. Facts established
this session, all against primary sources or measured in Chrome 145 on this laptop (i5-1135G7, 4 threads):

- ONNX Runtime Web links with a 4 GB maximum WASM memory and ships no 64-bit memory build (its own docs: "no way for
  ONNX Runtime Web to run models larger than 4GB"). transformers.js has no 64-bit path either.
- Chrome refuses any single ArrayBuffer over 2 GiB minus 2 MiB. transformers.js loads each weight shard into one
  ArrayBuffer, so the 1.7B q4 file (2,147,212,861 bytes) cannot even be loaded.
- ONNX Runtime's WASM build has no 4-bit matrix kernel. `MatMulNBits` falls to a path that dequantizes the whole weight
  matrix to fp32 on every step. Measured: Qwen3-0.6B q4 at 0.54 tok/s, q4f16 at 0.43 tok/s, int8 at 0.9 to 2.1 tok/s.
  For 4B the per-step temp buffer would be 1.56 GB; it would not fit.
- No 8B ONNX export exists in a browser-loadable layout; every one is a single 4.5 to 7 GB file.
- llama.cpp compiled to WASM (wllama 3.6.1, 2026-08-27) ships a 64-bit-memory build with JSPI, fixed-width SIMD and
  threads, loads split GGUF files, and measured 12 tok/s on Qwen3-0.6B Q8_0 and 2.7 tok/s on Qwen3-1.7B Q8_0 here.
  Its heap cap is 4 GiB by build constant (`-sMAXIMUM_MEMORY=4096MB` in its CMakeLists and `maxBytes` in
  `llama-cpp.js`); Chrome's ceiling for 64-bit WASM memory is 16 GiB, and a 5.9 GB heap was grown live in Chrome 145
  during the research.
- wllama v3 exposes only top-N probabilities, not the raw logit row. Rankmark needs the full row (151,936 floats for
  Qwen3) at every step for the entropy gate and the exact ranking. So the fork adds one export: call
  `llama_get_logits_ith` and hand back a Float32Array.

Together: one custom build of wllama (raise the cap, add the logits export) unlocks 1.7B, 4B and 8B at usable speed,
and 0.6B becomes fast enough to feel interactive. The build is the risk; section 10 has the go/no-go.

### Determinism

The engine's job is to reproduce the writer's exact ranking at read time. WASM fixed-width SIMD is deterministic by
spec; only "relaxed SIMD" may differ per CPU, and llama.cpp's WASM path uses `-msimd128` only (its relaxed-SIMD pull
request is unmerged). ggml partitions matrix multiplies by output rows, never by the reduction dimension, so thread
count should not change bits. Both of those are "likely from source", not measured; nobody has published a
cross-machine bit-exactness test for either runtime. The CI matrix in section 7 is that test, and until it passes the
page says a shared text "should" read elsewhere, not "will". Same-machine, same-build round trips are the baseline
and are tested 100 times in Phase 2.

The single-step invariant stays: the engine feeds one token at a time with the KV cache, because batched prefill and
single steps take different kernel paths and give different rankings. That is why a read costs as much as a write.

### The ladder

Rankmark's frame needs about 560 generated tokens for a 1-byte lean frame at Qwen's measured 12.6% carrier rate
(greedy; temperature 0.7 raises the rate and shortens this). Reading is the same number of steps. Times below are
write plus read for one lean frame, from measurements on this laptop and cited numbers; Apple Silicon runs roughly
twice as fast. Every number gets re-measured in Phase 2 and the page shows a live ETA before any run.

| Rung | Weights | Download | Heap | Browsers | Write + read, 1-byte tag | Tag cap |
|---|---|---|---|---|---|---|
| Qwen3-0.6B (default) | Q8_0 | 0.64 GB | ~1 GB | Chrome, Firefox, Safari (compat build) | ~2 min at 12 tok/s | 1-3 bytes |
| Qwen3-1.7B | Q8_0 | 1.83 GB | ~2.3 GB | same | ~7 min at 2.7 tok/s (measured) | up to 4 bytes |
| Qwen3-4B | Q4_K_M, split into ≤512 MB parts | 2.50 GB | ~3 GB incl. KV at 1,200 tokens | same (4 GiB heap) | 6-12 min at 1.5-3 tok/s (est.) | up to 8 bytes |
| Qwen3-8B | Q4_K_M, split | 5.03 GB | ~5.5 GB, 64-bit memory | Chrome ≥137, Firefox ≥153; no Safari | 12-25 min at 0.7-1.5 tok/s (est.) | up to 8 bytes |

Files: `Qwen/Qwen3-*-GGUF` (or the unsloth mirrors where Qwen's repo lacks a size), pinned by commit sha in the
registry. The 4B and 8B files are split with `llama-gguf-split` so no part exceeds 512 MB; the engine loads the parts
in parallel. Qwen3-0.6B Q4_K_M failed once in wllama with a typed-array length error during research; Q8_0 is used
for the two small rungs anyway (better quality, small files) and the failure is investigated in Phase 1.

**Where the ceiling is.** 8B is the top of the browser ladder and needs Chrome or Firefox, about 6 GB of free RAM, and
patience. 14B at 4-bit is 9 GB of weights plus cache, inside Chrome's 16 GiB memory ceiling in principle but at
roughly 0.5 tok/s and with no way to test it on a 7 GB CI runner; it is not offered. Everything above 8B is "run it
locally".

**Hardware detection** (`probe.js`): feature-test 64-bit memory (`new WebAssembly.Memory({address:'i64', ...})`) and
JSPI (`WebAssembly.Suspending`), read `navigator.deviceMemory` (Chromium only), `hardwareConcurrency`,
`crossOriginIsolated`, and `navigator.storage.estimate()`. Recommend the largest rung whose heap fits with 2 GB to
spare, show the size and the ETA, and let the visitor override. Safari and any browser without 64-bit memory never see
8B. If `crossOriginIsolated` is false the engine runs single-threaded and the page says so.

## 4. Architecture

Everything runs in the visitor's browser. The Pages site is HTML, CSS, ES modules, the engine's `.wasm` and `.js`,
and `snapshot.json`. Weights come from huggingface.co (CORS confirmed on both the resolve endpoint and the CDN) and are
cached by the browser's Cache Storage; the cache panel lists what is held and offers removal.

- **Engine adapter** (`web/engine/lens.js`, rewritten). Load a rung (split GGUF), prefill the prompt one token at a
  time, `step(token) -> Float32Array logits`, `reset()`, `dispose()`. The frame stack (`bits.js`, `framing.js`,
  `ecc.js`), `encoder.js` and `decoder.js` stay; they consume logits and never touch the engine. The 90 Python-derived
  vectors in `web/test/vectors.json` keep validating the frame stack; a new same-engine round-trip test validates the
  adapter.
- **Two engine bugs fixed on the way** (found in v1 review): `encoder.js:37` sizes the token budget with a gpt2-era
  multiplier, so Qwen runs end "too short"; it becomes `ceil(frameBits / rate[lens] * 1.3)` from a measured per-lens
  rate. And Qwen3's second end-of-text token (`<|endoftext|>`, 151643) is not banned during writing, so when the
  model reaches for it every carrier after it desyncs; the ban becomes a set covering both EOS ids.
- **Worker.** One lens resident at a time; `cancel` and `unload` commands; progress and ETA events; the lineup loads
  lenses sequentially with a visible swap.
- **Temperature.** Port same-parity sampling from `channel.py:114-121` with a seeded generator, default 0.7. Reads
  are unaffected (rank parity only).
- **Fingerprint.** Hash of {engine build hash, model file sha, quantization, thread count}. Stamped on every write,
  checked on every read; a mismatch names the differing field instead of reporting "no frame".
- **Mark card.** Every write produces the text plus a one-line footer `rankmark: Qwen3-1.7B Q8_0 f=<hash>`. On read
  the footer is recognised and stripped, the named lens loaded if cached, and the fingerprint compared. Copy copies
  the raw generated string, not the rendered DOM. The reader re-tokenizes pasted text and reports "altered in
  transit" (whitespace, quotes) before ever saying "no frame".
- **Telemetry.** None beyond optional Cloudflare Web Analytics page counts (its beacon carries the CORP header the
  isolation policy requires; confirmed). No text leaves the machine; the page says so as a feature.
- **Python side.** `server.py` and `static/index.html` stay as the research harness and the local path. Not deployed.

## 5. Visual and motion plan

No hero. The top strip is one line of type and the controls. The design toolkit is the VibeCurb skill set already in
`~/.claude/skills` (`awwwards-sections`, `awwwards-motion-design`; `awwwards-hero-section` is not used;
`visual-redesign` is React-only and not used).

From the sections skill, the parts that apply: the "Single Showcase" architecture (one large centered interactive
surface) for the tool; the rhythm rules for what sits below it (alternate layout direction, shift background tone
every two or three sections, one visual break, no three-equal-card grids); the anti-slop bans. Its conversion-funnel
order is replaced with a teaching order.

From the motion skill: declare the page type as editorial/product with the "surgical" personality at the start, or
its default animates every paragraph. Its vanilla-JS prescriptions hold: CSS transitions and keyframes, animate only
transform/opacity, `prefers-reduced-motion` on everything, no `transition: all`. Signature moments, all inside the tool:
a bit leaving the strip and landing under a word (transform only, under 300 ms); the seal border drawing when the CRC
validates; bits pulled out of words on read, arriving faint when damaged; the frame snapping into place; ranks
scattering when the wrong lens reads. Streaming words fade in by opacity, never translate. Reduced motion: bits appear
in place, no travel.

Palette and type: light editorial ground (`#FAFAF9`), near-black text, one warm accent. Bit 0 and bit 1 are solid vs
hollow underline at one hue (fixes the colour-blind green/amber pair in `web/index.html:11,16`); rank shading is value
steps. Display and body from Google Fonts (checked at build, not assumed), mono for the frame strip. Body copy
`max-width: 65ch`. Copy goes through `combob-writing` before the first sentence.

`web/index.html` is replaced: `web/ui/` one ES module per panel (write, read, frame strip, callouts, lineup, cache,
local), `web/styles/`, `web/data/snapshot.json`, `web/vendor/` for the engine build.

## 6. Hosting and deploy: Cloudflare Pages

Facts confirmed this session: this laptop's wrangler is logged in by OAuth as the account holding the
`myrakrusemark.com` zone with `pages:write`; `fathoms-log.pages.dev` was deployed the same way. Static requests on
Pages are free and unlimited; 25 MiB per file (the engine's largest `.wasm` is well under); `_headers` sets
per-path headers; `.wasm` is served as `application/wasm`.

`_headers` at the deploy root:

```
/*
  Cross-Origin-Opener-Policy: same-origin
  Cross-Origin-Embedder-Policy: require-corp
  Cross-Origin-Resource-Policy: same-origin
  X-Content-Type-Options: nosniff
  Referrer-Policy: strict-origin-when-cross-origin

/engine/*
  Cache-Control: public, max-age=60, must-revalidate

/vendor/*
  Cache-Control: public, max-age=31536000, immutable
```

Do not repeat a header name across overlapping rules: Pages joins duplicates with a comma.

Deploy:

```
cd /home/myra/Dropbox/Work/llm-crypto/rankmark/web
rm -rf dist && mkdir dist && cp -r index.html ui styles data engine vendor _headers dist/
npx wrangler whoami
npx wrangler pages project create watermark --production-branch main      # once
npx wrangler pages deploy dist --project-name watermark --branch main --commit-dirty=true
```

Custom domain: once, in the dashboard (Workers & Pages, watermark, Custom domains, Set up a domain,
`watermark.myrakrusemark.com`); Cloudflare creates the CNAME because the zone is in the same account. Adding the CNAME
by hand first yields a 522.

Zone-level settings that will bite, all confirmed against the live zone:

1. Browser Cache TTL is 4 hours on the zone and overrides any shorter `max-age` on the custom domain (seen on
   hifathom.com). Set it to "Respect Existing Headers", or a Configuration Rule for this hostname.
2. Email Obfuscation is on and rewrites HTML containing an `@`. Disable for this hostname with a Configuration Rule.
3. Rocket Loader is off; keep it off, and mark module scripts `data-cfasync="false"`.
4. Auto Minify no longer exists.
5. Pages is in maintenance mode; Cloudflare steers new projects to Workers Static Assets (same free static hosting,
   same `_headers`). Not a reason to change now; a later migration is mechanical.

Verify: `curl -sI https://watermark.myrakrusemark.com | grep -i cross-origin` and `crossOriginIsolated === true` in
the console.

## 7. Testing without a Mac

GitHub-hosted runners are free and unlimited on public repositories, all operating systems. The matrix:

| Runner | Arch | Browsers |
|---|---|---|
| `ubuntu-latest` | x86 Linux | Playwright Chromium, Firefox, WebKit |
| `ubuntu-24.04-arm` | ARM Linux | same |
| `windows-latest` | x86 Windows | same |
| `macos-15` | Apple Silicon (M1, 3 cores, 7 GB) | Playwright trio plus real Safari 26.5 via `safaridriver`, real Chrome 150 and Firefox 153 preinstalled |

Playwright's WebKit is not Safari; the `macos-15` runner has the real one. The job serves `web/` with `serve.mjs`
(it already sets the isolation headers), asserts `crossOriginIsolated`, writes a fixed prompt and tag on each
(OS, browser), uploads the text and bit string, and a final job diffs every artifact byte for byte. 0.6B runs on the
whole matrix; 1.7B runs serially on the macOS runner (7 GB is tight); 4B and 8B are outside CI memory.

For a human in front of a real Mac: Scaleway rents a Mac mini M1 at €0.11/hour with a 24-hour minimum (about €2.64 a
session; M4-S €0.22/hour), VNC from this laptop. That covers 4B and 8B portability checks against this laptop (31 GB
RAM, 8 threads, so 8B runs here at the low end of the estimate). BrowserStack's 30-minute trial or TestMu's free live
minutes are spare second opinions. Steady-state cost: $0/month.

## 8. Honesty and safety

Next to every verdict and in the limits panel: a valid frame means "a Rankmark frame planted with this model validates
here", never "this model wrote this"; no frame proves nothing (unmarked, edited, wrong lens, different engine build
are one outcome); text that fails to re-tokenize is "altered in transit" before it is "no frame"; a fingerprint
mismatch names the field. The page cannot detect ChatGPT, Claude or Gemini output, and no public detector exists for
Claude or Gemini text. Truncation and rank numbers were measured on gpt2 and are re-measured per rung in Phase 2.
Cross-machine stability is "should" until the CI matrix passes. The 2^-48 figure is the robust profile only; the
default is CRC16-gated and the false-accept rate is shown from the Phase 2 sieve. Arm A is visible to GLTR-style
detectors and dies under paraphrase; anyone with the weights can forge a frame. The tag input is short and labelled
as a tag; it is not presented as a covert channel.

Client-side removes the server from the threat model: no rate limits, no leaks, no cross-visitor state, text never
leaves the machine. What remains: dependence on huggingface.co (its anonymous limit is 3,000 requests per 5 minutes
per IP, which a classroom NAT can hit; an R2 mirror is the fallback), multi-GB downloads on metered links (consent
gate with sizes, `saveData` respected), Safari's 7-day cache eviction (stated), and false attribution by a reader who
treats a chance CRC hit as proof (mitigated by never rendering an authorship verdict).

## 9. Run it locally

The repo becomes public on GitHub (the `gh` CLI is logged in as `myrakrusemark`; there is no remote today). The
"Run it locally" tab shows three commands:

```
git clone https://github.com/myrakrusemark/rankmark && cd rankmark
uv venv ~/.venvs/rankmark --python 3.14 --system-site-packages && source ~/.venvs/rankmark/bin/activate && uv pip install -e .
rankmark serve --model Qwen/Qwen3-14B
```

and a "local mode" field: enter `http://localhost:8770` and the page talks to that server instead of the browser
engine. `server.py` already allows any origin and streams the same per-token events the old page consumed. Chrome and
Firefox treat `http://localhost` as a secure origin so the HTTPS page may call it; Safari's behaviour is unverified,
and the fallback is `node web/serve.mjs` to run the page itself locally. A text written through a local Python lens
reads only through Python (different arithmetic from the browser engine); the page labels it as its own lens.

The `rankmark serve` model list is whatever the machine holds; the README states the GPU and dtype requirements
(bf16 on CUDA, fp32 on CPU, fp16 refused) from the existing determinism caveats.

## 10. Work breakdown

| Phase | Deliverables | Days |
|---|---|---|
| 0 Publish and pin | `feat/public-site` from the current branch; commit `web/` and the four dirty Python files, one concern per commit; create the public GitHub repo and push; pin model file shas in the registry; CI skeleton | 1.5 |
| 1 Engine spike, go/no-go by day 5 | Fork wllama; add the full-logits export (`llama_get_logits_ith` to Float32Array); raise `MAXIMUM_MEMORY`/`maxBytes` to 8 GiB; build via its Docker setup; load split Qwen3-0.6B Q8_0; single-step logits; run-to-run determinism x100; single-step vs batched divergence check; investigate the Q4_K_M failure. Go: round trip passes. No-go fallback: keep ONNX int8 for 0.6B and 1.7B, and 4B/8B become "run it locally" | 5 |
| 2 Adapter and engine additions | `lens.js` on the fork; EOS set; measured-rate token budget; temperature port; worker cancel/unload/progress; registry with tiers and tag caps; `probe.js` with feature tests; fingerprint; mark card and footer strip; re-tokenize check; Qwen3-0.6B and 1.7B round-trip tests; `snapshot.json` generator | 5 |
| 3 Determinism CI and measurements | GitHub Actions matrix (section 7); thread-count sweep; carrier rate per rung at temp 0.7; tok/s per rung; round-trip token counts; false-frame sieve per profile (100,000 random-bit trials plus human paragraphs); head-cut flip rate; EOS counts; sibling lineup: every rung reads text written by every other rung, recording carrier-bit agreement and whether any sibling ever validates (if one does, the attribution claim is narrowed on the page); cover-text quality check per rung and the default locked | 4 |
| 4 Tool UI | Write / Read / Local tabs; frame strip and bit motion; callout system; break-it controls with cancel; lineup; mark card; download consent with size and ETA; cache panel; mobile snapshot mode; 4B and 8B rungs gated by the probe | 8 |
| 5 Explainer and copy | "How this works" section, comparison table sourced to the Anthropic post and help article, the Nature paper and OpenAI's provenance pages; limits panel; every string through combob and the lint | 3 |
| 6 Hosting | `_headers`, wrangler project, custom domain, the three zone rules, analytics, header verification | 1 |
| 7 QA and gate | Browser matrix green; one Scaleway Mac session for 4B/8B portability against this laptop; accessibility (every token's rank, entropy and bit as a hidden label; knobs are native inputs; tooltips open on focus; 4.5:1 contrast); reduced motion; every printed number traced to a Phase 3 measurement or removed | 3.5 |

Total: 31 working days, 30 to 36 with slack. Phases 4 and 5 run in parallel with 3; phase 6 any time after 0. The
go/no-go at day 6.5 is the one real fork in the road.

## 11. Open questions

1. Repo: `https://github.com/myrakrusemark/rankmark.git` (exists, public, empty as of 2026-09-04). Settled.
2. 8B on the page means 12 to 25 minutes for one write-plus-read on a typical x86 laptop, about half that on Apple
   Silicon, Chrome or Firefox only. The page states this before the download. Fine as the ceiling?
3. gpt2: dropped, Qwen only. Settled.
