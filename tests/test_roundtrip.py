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
def test_embed_decode_round_trip_v1(gpt2):
    params = ChannelParams(tau=2.0, framing="v1")
    result = embed(gpt2, PROMPT, PAYLOAD, params, max_new_tokens=200)
    assert result.frames_planted >= 1.0, "not enough entropy to plant one frame"
    decoded = decode(gpt2, result.text, params)
    assert decoded.valid
    assert decoded.payload == PAYLOAD


@pytest.mark.slow
def test_embed_decode_round_trip_v2_lean(gpt2):
    params = ChannelParams(tau=2.0, framing="v2", profile=0)
    result = embed(gpt2, PROMPT, PAYLOAD, params, max_new_tokens=250)
    assert result.frames_planted >= 1.0, "not enough entropy to plant one frame"
    decoded = decode(gpt2, result.text, params)
    assert decoded.valid
    assert decoded.payload == PAYLOAD


@pytest.mark.slow
def test_v2_frame_survives_truncation(gpt2):
    """The Phase-2 milestone on a real lens: cut the head and tail off the
    marked text and a repeated lean frame still validates.

    Needs the bounded-context window: full-context ranks are disturbed by a
    head cut all the way to the end of the text (~25% carrier parity flips
    measured on gpt2), but windowed ranks match bit-for-bit once the scan is
    `window` tokens past the cut."""
    params = ChannelParams(tau=2.0, framing="v2", profile=0, window=64)
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
def test_unwatermarked_text_does_not_validate(gpt2):
    text = (
        "Cryptography is the practice and study of techniques for secure "
        "communication in the presence of adversarial behavior. Modern "
        "cryptography exists at the intersection of mathematics, computer "
        "science, information security, and electrical engineering."
    )
    decoded = decode(gpt2, text, ChannelParams(tau=2.0))
    assert not decoded.valid
