"""Pure-logic tests: framing, CRC, bit packing, encode_step gating."""

import torch

from rankmark.channel import (
    MAGIC_BITS,
    ChannelParams,
    bits_to_bytes,
    bits_to_int,
    bytes_to_bits,
    crc16,
    encode_step,
    frame_bits,
    int_to_bits,
    parse_frames,
    sorted_token_ids,
)


def test_crc16_known_value():
    assert crc16(b"123456789") == 0x29B1  # CRC-16/CCITT-FALSE check value


def test_bit_packing_round_trip():
    data = bytes(range(256))
    assert bits_to_bytes(bytes_to_bits(data)) == data
    assert bits_to_int(int_to_bits(0xB65D, 16)) == 0xB65D


def test_frame_round_trip():
    payload = b"\xa7\x01\xff"
    frames = parse_frames(frame_bits(payload))
    assert len(frames) == 1
    assert frames[0].payload == payload
    assert frames[0].offset == 0


def test_frame_found_at_nonzero_offset():
    bits = [1, 0, 1, 1, 0, 1, 0] + frame_bits(b"\xa7") + [0, 1, 1]
    frames = parse_frames(bits)
    assert len(frames) == 1
    assert frames[0].payload == b"\xa7"
    assert frames[0].offset == 7


def test_corrupted_frame_rejected():
    bits = frame_bits(b"\xa7\xb2")
    bits[MAGIC_BITS + 10] ^= 1  # flip one payload bit
    assert parse_frames(bits) == []


def test_repeated_frames_all_found():
    bits = frame_bits(b"\x42") * 3
    frames = parse_frames(bits)
    assert [f.payload for f in frames] == [b"\x42"] * 3


def test_random_bits_do_not_validate():
    import random

    rng = random.Random(0)
    bits = [rng.randint(0, 1) for _ in range(4000)]
    assert parse_frames(bits) == []


def test_encode_step_low_entropy_is_carrier_null():
    logits = torch.tensor([10.0, 0.0, 0.0, 0.0])  # near-deterministic
    token, used = encode_step(logits, next_bit=1, params=ChannelParams(tau=1.0))
    assert token == 0
    assert not used


def test_encode_step_plants_parity():
    logits = torch.tensor([1.0, 0.9, 0.8, 0.7])  # high entropy, 4-way close
    params = ChannelParams(tau=0.5)
    token0, used0 = encode_step(logits, next_bit=0, params=params)
    token1, used1 = encode_step(logits, next_bit=1, params=params)
    assert used0 and used1
    assert token0 == 0  # rank 0 carries bit 0
    assert token1 == 1  # rank 1 carries bit 1


def test_sorted_ties_break_to_lower_token_id():
    logits = torch.tensor([1.0, 2.0, 2.0, 0.5])
    order = sorted_token_ids(logits).tolist()
    assert order[:3] == [1, 2, 0]
