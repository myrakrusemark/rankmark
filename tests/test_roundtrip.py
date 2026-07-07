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
def test_embed_decode_round_trip(gpt2):
    params = ChannelParams(tau=2.0)
    result = embed(gpt2, PROMPT, PAYLOAD, params, max_new_tokens=200)
    assert result.frames_planted >= 1.0, "not enough entropy to plant one frame"
    decoded = decode(gpt2, result.text, params)
    assert decoded.valid
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
