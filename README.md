# rankmark

Keyed rank-lens watermark: hide a self-validating payload in LLM-generated
text by steering token choices against the model's own next-token ranking.
There is no secret key — **the key is the model itself**. Text decodes (and
checksum-validates) only through the logits of the model that generated it,
which turns decoding into an attribution test.

See [docs/rankmark-build-plan.md](docs/rankmark-build-plan.md) for the full
research plan. This repo currently implements Phase 0 (determinism harness),
Phase 1 (Arm A: entropy-gated rank parity, GLTR heatmap), and Phase 2
(ECC + framing + robustness).

## How it works

- **Embed**: while generating, at each high-entropy step emit the token whose
  rank parity (rank 0 or rank 1) matches the next payload bit. Low-entropy
  steps emit rank 0 and carry nothing (carrier-nulls), so text quality holds.
- **Frame**: payload is wrapped as `[SYNC | HEADER | ECC(PAYLOAD‖CRC)]`,
  repeated for as long as generation runs. A sliding correlator finds the
  sync pattern anywhere in the carrier stream; the ECC stack (Reed–Solomon +
  interleave + rate-1/2 convolutional with soft Viterbi, by profile) absorbs
  edit damage; the CRC is the attribution gate. Profiles trade capacity for
  robustness: `--profile 0` (lean, 71-bit frames — any ~150-carrier span
  holds a whole one), `1` (standard, CRC32 + full ECC), `2` (robust, ~2^-48
  gate).
- **Decode**: teacher-force the text through a lens, recover each token's
  rank, re-apply the same entropy gate, read parities as soft bits (edit
  damage arrives quiet, not loud and wrong), scan for gate-passing frames.
  A wrong lens desyncs the gate and fails the CRC: that is the attribution
  signal.
- **Truncation** (`--window N`): full-context ranks die under a head cut —
  every downstream near-tie flips (~25% carrier parity error measured on
  gpt2, persisting to the end of the text). With `--window`, both sides
  score each position from at most N context tokens, so any position more
  than N tokens past a cut sees bit-identical logits and decodes clean.
  Costs one bounded forward pass per token instead of a cached step.

## Setup

```bash
uv venv ~/.venvs/rankmark --python 3.14 --system-site-packages  # needs torch
source ~/.venvs/rankmark/bin/activate
uv pip install -e ".[dev]"
```

## Use

```bash
# generate text carrying payload 0xa7, verify the round trip
rankmark embed --model Qwen/Qwen2.5-3B --prompt "The history of cryptography begins with" \
  --payload a7 --max-tokens 250 --verify > marked.txt

# read it back through a lens (exit 0 = checksum-valid frame found)
rankmark decode --model Qwen/Qwen2.5-3B --file marked.txt --heatmap decode.html

# the attribution test: only the generating lens validates
rankmark attribute --pool "Qwen/Qwen2.5-3B,gpt2" --file marked.txt
```

## Test

```bash
pytest            # fast, pure-logic tests
pytest -m slow -o addopts=""   # model-backed round-trip tests (downloads gpt2)
```

## Determinism caveats

Encode and decode must run on the same machine, torch build, and dtype.
Lenses load in the checkpoint's native dtype (gpt2 fp32, Qwen bf16); fp16 is
refused. The frozen tie-break everywhere is sort by `(-logit, token_id)`.
Cross-machine rank stability is untested (build plan Phase 4, experiment 7).
