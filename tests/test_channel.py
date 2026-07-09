"""Pure-logic tests: CRC, bit packing, encode_step gating."""

import torch

from rankmark.channel import (
    ChannelParams,
    bits_to_bytes,
    bits_to_int,
    bytes_to_bits,
    crc16,
    encode_step,
    int_to_bits,
    sorted_token_ids,
)


def test_crc16_known_value():
    assert crc16(b"123456789") == 0x29B1  # CRC-16/CCITT-FALSE check value


def test_bit_packing_round_trip():
    data = bytes(range(256))
    assert bits_to_bytes(bytes_to_bits(data)) == data
    assert bits_to_int(int_to_bits(0xB65D, 16)) == 0xB65D


def test_encode_step_low_entropy_is_carrier_null():
    logits = torch.tensor([10.0, 0.0, 0.0, 0.0])  # near-deterministic
    choice = encode_step(logits, next_bit=1, params=ChannelParams(tau=1.0))
    assert choice.token_id == 0
    assert not choice.planted
    assert choice.rank == 0


def test_encode_step_plants_parity():
    logits = torch.tensor([1.0, 0.9, 0.8, 0.7])  # high entropy, 4-way close
    params = ChannelParams(tau=0.5)
    zero = encode_step(logits, next_bit=0, params=params)
    one = encode_step(logits, next_bit=1, params=params)
    assert zero.planted and one.planted
    assert zero.token_id == 0  # rank 0 carries bit 0
    assert one.token_id == 1  # rank 1 carries bit 1


def test_banned_token_skips_to_same_parity():
    logits = torch.tensor([1.0, 0.9, 0.8, 0.7])  # high entropy, 4-way close
    params = ChannelParams(tau=0.5)
    choice = encode_step(logits, next_bit=0, params=params, ban_token=0)
    assert choice.token_id == 2 and choice.rank == 2  # next even rank
    assert choice.rank % 2 == 0  # parity survives the ban
    null = encode_step(torch.tensor([10.0, 0.0, 0.0, 0.0]), 1, ChannelParams(tau=1.0), ban_token=0)
    assert null.token_id == 1 and not null.planted  # null dodges the ban too


def test_temperature_carrier_keeps_parity():
    logits = torch.tensor([3.0, 2.9, 2.8, 2.7, 2.6, 2.5])  # flat: deep ranks in play
    params = ChannelParams(tau=0.5, temperature=1.5, top_k=6)
    gen = torch.Generator().manual_seed(0)
    ranks = set()
    for _ in range(40):
        c = encode_step(logits, next_bit=1, params=params, generator=gen)
        assert c.planted and c.rank % 2 == 1  # always odd rank -> bit 1
        ranks.add(c.rank)
    assert len(ranks) > 1  # actually explores beyond rank 1, not stuck greedy


def test_temperature_null_samples_beyond_rank_zero():
    logits = torch.tensor([2.0, 1.9, 1.8, 1.7])  # low-entropy-ish but flat top
    params = ChannelParams(tau=5.0, temperature=2.0, top_k=4)  # tau high -> all nulls
    gen = torch.Generator().manual_seed(1)
    ranks = set(encode_step(logits, 0, params, generator=gen).rank for _ in range(40))
    assert ranks != {0}  # a null that can escape the greedy rank-0 rut


def test_sorted_ties_break_to_lower_token_id():
    logits = torch.tensor([1.0, 2.0, 2.0, 0.5])
    order = sorted_token_ids(logits).tolist()
    assert order[:3] == [1, 2, 0]
