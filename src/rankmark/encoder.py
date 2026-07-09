"""Embed a payload while generating: the token choices ARE the watermark."""

import itertools
from dataclasses import dataclass, field

from .channel import ChannelParams, encode_step
from .framing import build_frame, tag_of
from .models import Lens
from .tokenobs import StepScorer, window_logits


@dataclass
class EmbedResult:
    text: str
    continuation: str
    token_ids: list[int]  # full context including prompt (no BOS)
    bits_planted: int
    frames_planted: float
    carrier_nulls: int
    retokenizes_cleanly: bool
    fingerprint: dict = field(default_factory=dict)


def context_ids(lens: Lens, text: str) -> list[int]:
    """Canonical context: BOS (when the tokenizer defines one) + plain ids.

    Must match tokenobs.scan exactly — encoder and decoder have to see the
    same prefix or every rank downstream shifts.
    """
    ids = lens.tokenizer(text, add_special_tokens=False).input_ids
    bos = lens.tokenizer.bos_token_id
    if bos is not None and (not ids or ids[0] != bos):
        return [bos, *ids]
    return ids


def embed(
    lens: Lens,
    prompt: str,
    payload: bytes,
    params: ChannelParams | None = None,
    max_new_tokens: int = 300,
    on_token=None,
) -> EmbedResult:
    params = params or ChannelParams()
    frame = build_frame(payload, params.profile, tag_of(lens.name))
    bit_stream = itertools.cycle(frame)
    next_bit = next(bit_stream)

    prompt_ctx = context_ids(lens, prompt)
    if not prompt_ctx:
        raise ValueError("prompt tokenized to nothing and tokenizer has no BOS")
    ids = list(prompt_ctx)
    eos = lens.tokenizer.eos_token_id
    planted = 0
    nulls = 0

    # Encode/decode must share the exact numerical path: either the cached
    # step scorer fed token by token, or the same bounded-window forward the
    # decoder's scan will use.
    if params.window:
        logits = window_logits(lens, ids[-params.window :])
    else:
        scorer = StepScorer(lens)
        for tid in prompt_ctx:
            logits = scorer.step(tid)

    for _ in range(max_new_tokens):
        # the model may not end the text before one whole frame is planted
        ban = eos if planted < len(frame) else None
        choice = encode_step(logits, next_bit, params, ban_token=ban)
        if choice.planted:
            planted += 1
            next_bit = next(bit_stream)
        else:
            nulls += 1
        ids.append(choice.token_id)
        if on_token:
            on_token(choice)
        if choice.token_id == eos:
            break
        if params.window:
            logits = window_logits(lens, ids[-params.window :])
        else:
            logits = scorer.step(choice.token_id)

    bos_len = len(prompt_ctx) - len(lens.tokenizer(prompt, add_special_tokens=False).input_ids)
    full_ids = ids[bos_len:]  # strip BOS for text rendering
    text = lens.tokenizer.decode(full_ids, skip_special_tokens=True)
    continuation = lens.tokenizer.decode(ids[len(prompt_ctx) :], skip_special_tokens=True)

    reencoded = context_ids(lens, text)
    return EmbedResult(
        text=text,
        continuation=continuation,
        token_ids=full_ids,
        bits_planted=planted,
        frames_planted=planted / len(frame),
        carrier_nulls=nulls,
        retokenizes_cleanly=reencoded == ids,
        fingerprint=lens.fingerprint,
    )
