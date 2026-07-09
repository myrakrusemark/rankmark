"""Local web UI: stream embed/decode over the real channel.

Every endpoint calls the same code the CLI uses — the page renders what
decoder.py computed, it never recomputes ranks or checksums itself.
Responses stream NDJSON, one event per scored token, so the heatmap
paints live at model speed.
"""

import json
import queue
import threading
from pathlib import Path

from fastapi import FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse, StreamingResponse
from pydantic import BaseModel

from .channel import ChannelParams
from .framing import build_frame, frame_spans, llr_of, parse_frames_soft, partial_spans, tag_of
from .encoder import embed
from .models import Lens, load_lens
from .tokenobs import scan_iter

app = FastAPI(title="rankmark")
# The page also works opened straight from disk (file://), where the browser
# sends Origin: null — a localhost-only tool, so allow anyone.
app.add_middleware(CORSMiddleware, allow_origins=["*"], allow_methods=["*"],
                   allow_headers=["*"])
STATIC = Path(__file__).parent / "static"

_available: list[str] = ["Qwen/Qwen2.5-3B", "gpt2"]
_lenses: dict[str, Lens] = {}
_load_lock = threading.Lock()


def configure(models: list[str]) -> None:
    global _available
    _available = models


def get_lens(name: str) -> Lens:
    if name not in _available:
        raise HTTPException(400, f"unknown lens {name!r}; serving {_available}")
    with _load_lock:
        if name not in _lenses:
            _lenses[name] = load_lens(name)
    return _lenses[name]


class DecodeRequest(BaseModel):
    text: str
    model: str
    tau: float = 2.0
    profile: int = 1
    window: int | None = None


class EmbedRequest(BaseModel):
    prompt: str
    payload: str  # hex
    model: str
    tau: float = 2.0
    max_tokens: int = 500
    profile: int = 1
    window: int | None = None
    temperature: float = 0.0
    top_k: int = 48
    instruct: bool = False  # prompt is an instruction; only the reply is visible


def ndjson(events) -> StreamingResponse:
    return StreamingResponse(
        (json.dumps(e) + "\n" for e in events), media_type="application/x-ndjson"
    )


@app.get("/")
def index() -> FileResponse:
    return FileResponse(STATIC / "index.html")


@app.get("/api/models")
def api_models() -> dict:
    return {"models": _available, "loaded": sorted(_lenses)}


@app.post("/api/decode")
def api_decode(req: DecodeRequest) -> StreamingResponse:
    lens = get_lens(req.model)
    params = ChannelParams(tau=req.tau, profile=req.profile, window=req.window)

    def events():
        ids = lens.tokenizer(req.text, add_special_tokens=False).input_ids
        yield {"type": "start", "lens": req.model, "tokens": len(ids)}
        tag = tag_of(lens.name)
        obs = []
        llrs = []  # one per carrier, in carrier order (== the bit-strip cells)
        seen = 0
        for o in scan_iter(lens, ids, params.window):
            obs.append(o)
            carrier = o.entropy >= params.tau
            yield {
                "type": "token",
                "pos": o.pos,
                "piece": lens.tokenizer.decode([o.token_id]),
                "rank": o.rank,
                "bucket": o.bucket,
                "entropy": round(o.entropy, 3),
                "carrier": carrier,
                "bit": o.rank % 2,
            }
            # scan the carriers so far — a frame that validates on a prefix
            # stays valid (each carrier's llr depends only on itself), so the
            # message and its colored parts can surface mid-stream
            if carrier:
                llrs.append(llr_of(o.rank, o.entropy, params.tau))
                frames = [f for f in parse_frames_soft(llrs, tag) if f.tag_ok]
                if len(frames) > seen:
                    seen = len(frames)
                    yield {
                        "type": "frame",
                        "frames": len(frames),
                        "payload": frames[0].payload.hex(),
                        "spans": [s for f in frames for s in frame_spans(f)],
                    }
                # tentative parts of the frame still arriving at the tail
                yield {"type": "partial", "spans": partial_spans(llrs)}
        frames = [f for f in parse_frames_soft(llrs, tag) if f.tag_ok]
        yield {
            "type": "done",
            "lens": req.model,
            "carriers": len(llrs),
            "total": len(obs),
            "frames": len(frames),
            "valid": bool(frames),
            "payload": frames[0].payload.hex() if frames else None,
            "spans": [s for f in frames for s in frame_spans(f)],
        }

    return ndjson(events())


@app.post("/api/embed")
def api_embed(req: EmbedRequest) -> StreamingResponse:
    lens = get_lens(req.model)
    params = ChannelParams(tau=req.tau, profile=req.profile, window=req.window,
                           temperature=req.temperature, top_k=req.top_k)
    try:
        payload = bytes.fromhex(req.payload)
    except ValueError:
        raise HTTPException(400, "payload must be hex bytes, e.g. a7") from None

    def events():
        q: queue.Queue = queue.Queue()

        def on_token(choice):
            q.put(
                {
                    "type": "token",
                    "piece": lens.tokenizer.decode([choice.token_id]),
                    "rank": choice.rank,
                    "bucket": 0,
                    "entropy": round(choice.entropy, 3),
                    "carrier": choice.planted,
                    "bit": choice.rank % 2,
                }
            )

        def run():
            try:
                result = embed(
                    lens, req.prompt, payload, params,
                    max_new_tokens=req.max_tokens, on_token=on_token, instruct=req.instruct,
                )
                q.put(
                    {
                        "type": "done",
                        "lens": req.model,
                        "text": result.text,
                        "bits_planted": result.bits_planted,
                        "frames_planted": round(result.frames_planted, 2),
                        "carrier_nulls": result.carrier_nulls,
                        "retokenizes_cleanly": result.retokenizes_cleanly,
                    }
                )
            except Exception as exc:  # surfaced to the page, not swallowed
                q.put({"type": "error", "message": str(exc)})
            q.put(None)

        threading.Thread(target=run, daemon=True).start()
        frame_bits = len(build_frame(payload, params.profile, tag_of(lens.name)))
        yield {"type": "start", "lens": req.model, "prompt": req.prompt, "frame_bits": frame_bits}
        while (event := q.get()) is not None:
            yield event

    return ndjson(events())
