"""rank_of / entropy_of / bucket logic against hand-built distributions."""

import math

import torch

from rankmark.channel import sorted_token_ids
from rankmark.tokenobs import bucket_of, entropy_of, rank_of


def test_rank_of_simple():
    logits = torch.tensor([0.1, 3.0, 2.0, -1.0])
    assert rank_of(logits, 1) == 0
    assert rank_of(logits, 2) == 1
    assert rank_of(logits, 0) == 2
    assert rank_of(logits, 3) == 3


def test_rank_of_ties_break_to_lower_id():
    logits = torch.tensor([2.0, 2.0, 2.0, 5.0])
    assert rank_of(logits, 3) == 0
    assert rank_of(logits, 0) == 1
    assert rank_of(logits, 1) == 2
    assert rank_of(logits, 2) == 3


def test_rank_of_agrees_with_sorted_token_ids():
    torch.manual_seed(7)
    logits = torch.randn(500)
    logits[10] = logits[20] = logits[30]  # plant ties
    order = sorted_token_ids(logits).tolist()
    for rank, token_id in enumerate(order):
        assert rank_of(logits, token_id) == rank


def test_entropy_uniform():
    logits = torch.zeros(16)
    assert math.isclose(entropy_of(logits), math.log(16), rel_tol=1e-5)


def test_entropy_peaked_is_near_zero():
    logits = torch.tensor([100.0] + [0.0] * 15)
    assert entropy_of(logits) < 1e-3


def test_buckets():
    assert bucket_of(0) == 0
    assert bucket_of(9) == 0
    assert bucket_of(10) == 1
    assert bucket_of(999) == 2
    assert bucket_of(1000) == 3
