# Rankmark

An experimental text watermark and interactive article: hide a short message
in a language model's token choices, then recover it with a matching reader.

**[Read the article and try the tool](https://myrakrusemark.com/watermark/).**

The browser tool runs Qwen3 locally using llama.cpp in WebAssembly. It supports
optional passphrases that change how rank parity maps to bits. This is
experimental keying, **not message encryption or a guarantee of authorship**.
A checksum-valid result is evidence of a recovered frame, not proof of who
wrote the text. Cross-model bit agreement alone does not identify a model.

## Run the article locally

Requires Node.js 22 or later. Fetch the pinned engine assets once, then start
the server (which supplies the headers needed by multi-threaded WebAssembly):

```sh
node scripts/fetch-engine.mjs
node web/serve.mjs
```

Open http://127.0.0.1:8770/. Model weights download into the browser.

## Python command-line tool

The Python implementation is a separate, unkeyed research tool. Its frames and
profiles differ from the browser engine; do not mix their generated texts.

```sh
python3.12 -m venv .venv
source .venv/bin/activate
python -m pip install -e '.[dev]'

rankmark --profile 0 --temperature 0.7 embed \
  --model Qwen/Qwen3-0.6B \
  --prompt 'It was late in the harbor when the last boat came in, and' \
  --payload a7 --max-tokens 800 --verify > marked.txt

rankmark --profile 0 decode --model Qwen/Qwen3-0.6B --file marked.txt
```

`a7` is one byte expressed in hexadecimal. Use matching model, device, and
settings when writing and reading. Edits, truncation, and numerical differences
can prevent recovery. The `attribute` command compares candidate readers;
it is not a general-purpose authorship detector.

## Checks

```sh
pytest -q
ruff check src tests
node web/test/verify.mjs
node web/test/framing_copies.mjs
node web/test/echo.mjs
node web/test/engine_roundtrip.mjs
node web/test/educational_evidence.mjs
node web/test/read_selection.mjs
```

Model-backed tests and measurement scripts live under `web/test/ci/`.
`web/data/measurements.json` preserves the measured comparisons used by the
article. These are historical results, not prerecorded interactive examples.

## Publish

See [the article deployment guide](scripts/ARTICLE-DEPLOY.md). The article is
published at `/watermark/` in the main portfolio repository; this repository
contains its source. The [research plan](docs/rankmark-build-plan.md) records
earlier experiments and proposals, not a statement of current guarantees.
