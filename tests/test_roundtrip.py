"""Model-backed tests. Slow: need downloaded weights. Run with -m slow."""

import pytest

from rankmark.channel import ChannelParams
from rankmark.decoder import decode
from rankmark.encoder import embed
from rankmark.models import load_lens
from rankmark.tokenobs import scan

PROMPT = "The history of cryptography begins with"
PAYLOAD = bytes.fromhex("a7")


@pytest.fixture(scope="module")
def gpt2():
    return load_lens("gpt2")


@pytest.mark.slow
def test_determinism_same_text_same_ranks(gpt2):
    ids = gpt2.tokenizer("The quick brown fox jumps over the lazy dog.").input_ids
    first = scan(gpt2, ids)
    second = scan(gpt2, ids)
    assert [o.rank for o in first] == [o.rank for o in second]
    assert [o.entropy for o in first] == [o.entropy for o in second]


@pytest.mark.slow
def test_embed_decode_round_trip_lean(gpt2):
    params = ChannelParams(tau=2.0, profile=0)
    result = embed(gpt2, PROMPT, PAYLOAD, params, max_new_tokens=250)
    assert result.frames_planted >= 1.0, "not enough entropy to plant one frame"
    decoded = decode(gpt2, result.text, params)
    assert decoded.valid
    assert decoded.payload == PAYLOAD


@pytest.mark.slow
def test_temperature_round_trip(gpt2):
    """Sampling deeper same-parity tokens must not change what decodes back."""
    params = ChannelParams(tau=2.0, profile=0, temperature=0.8, top_k=48)
    result = embed(gpt2, PROMPT, PAYLOAD, params, max_new_tokens=300, seed=7)
    assert result.frames_planted >= 1.0
    decoded = decode(gpt2, result.text, params)
    assert decoded.valid and decoded.payload == PAYLOAD
    # the whole point: the mark is no longer a wall of rank-0 tokens
    ranks = [o.rank for o in decoded.obs]
    assert sum(r > 1 for r in ranks) > 0.1 * len(ranks)


@pytest.mark.slow
def test_v2_frame_survives_truncation(gpt2):
    """The Phase-2 milestone on a real lens: cut the head and tail off the
    marked text and a repeated lean frame still validates.

    Needs the bounded-context window: full-context ranks are disturbed by a
    head cut all the way to the end of the text (~25% carrier parity flips
    measured on gpt2), but windowed ranks match bit-for-bit once the scan is
    `window` tokens past the cut."""
    params = ChannelParams(tau=2.0, profile=0, window=64)
    result = embed(gpt2, PROMPT, PAYLOAD, params, max_new_tokens=450)
    assert result.frames_planted >= 3.0, "need a few repetitions to truncate into"

    # cut by character so the interior stays byte-identical — rewriting
    # whitespace would retokenize (and desync) the whole text
    n = len(result.text)
    cut = result.text[n // 6 : -(n // 6)]
    decoded = decode(gpt2, cut, params)
    assert decoded.valid, "no frame survived truncation"
    assert decoded.payload == PAYLOAD


@pytest.mark.slow
def test_instruct_instruction_is_disposable_past_window():
    """Instruct mode: the decoder gets only the reply (never the instruction).
    Past the window, encoder and decoder must compute identical carrier bits —
    that agreement is what lets a frame validate without the instruction."""
    win = 24
    lens = load_lens("Qwen/Qwen2.5-0.5B-Instruct")
    params = ChannelParams(tau=2.0, profile=0, window=win, temperature=0.0)
    enc = []
    result = embed(lens, "Describe a lighthouse in two sentences.", b"hi", params,
                   max_new_tokens=120, instruct=True,
                   on_token=lambda c: enc.append((c.planted, c.rank % 2)))
    assert result.retokenizes_cleanly
    ids = lens.tokenizer(result.text, add_special_tokens=False).input_ids
    dec = {o.pos: (o.entropy >= params.tau, o.rank % 2) for o in scan(lens, ids, win)}

    after = [p for p in range(win, len(enc)) if p in dec]
    assert after, "generation too short to reach past the window"
    assert all(enc[p] == dec[p] for p in after)  # instruction scrolled out → exact match


@pytest.mark.slow
def test_unwatermarked_text_does_not_validate(gpt2):
    text = (
        "Cryptography is the practice and study of techniques for secure "
        "communication in the presence of adversarial behavior. Modern "
        "cryptography exists at the intersection of mathematics, computer "
        "science, information security, and electrical engineering."
    )
    decoded = decode(gpt2, text, ChannelParams(tau=2.0))
    assert not decoded.valid
