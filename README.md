# rankmark

Keyed rank-lens watermark: hide a self-validating payload in LLM-generated
text by steering token choices against the model's own next-token ranking.
There is no secret key — **the key is the model itself**. Text decodes (and
checksum-validates) only through the logits of the model that generated it,
which turns decoding into an attribution test.

See [docs/rankmark-build-plan.md](docs/rankmark-build-plan.md) for the full
research plan. This repo currently implements Phase 0 (determinism harness)
and Phase 1 (Arm A: entropy-gated rank parity, MAGIC+CRC16 framing, GLTR
heatmap) — the proof-of-concept.

## How it works

- **Embed**: while generating, at each high-entropy step emit the token whose
  rank parity (rank 0 or rank 1) matches the next payload bit. Low-entropy
  steps emit rank 0 and carry nothing (carrier-nulls), so text quality holds.
- **Frame**: payload is wrapped as `[MAGIC16 | LEN8 | PAYLOAD | CRC16]`,
  repeated for as long as generation runs. MAGIC gives sync; CRC is the gate.
- **Decode**: teacher-force the text through a lens, recover each token's
  rank, re-apply the same entropy gate, read parities, scan for valid frames.
  A wrong lens desyncs the gate and fails the CRC: that is the attribution
  signal.

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
