"""Pure-logic tests for the ECC stack: conv/Viterbi, RS, interleave, repetition."""

import random

from rankmark.ecc import (
    HARD_LLR,
    bits_to_llrs,
    conv_encode,
    CONV_TAIL,
    deinterleave,
    interleave,
    rep_decode_soft,
    rep_encode,
    rs_decode,
    rs_encode,
    viterbi_decode,
)


def test_conv_round_trip():
    rng = random.Random(1)
    bits = [rng.randint(0, 1) for _ in range(80)]
    coded = conv_encode(bits)
    assert len(coded) == 2 * (len(bits) + CONV_TAIL)
    assert viterbi_decode(bits_to_llrs(coded), len(bits)) == bits


def test_conv_corrects_hard_flips():
    rng = random.Random(2)
    bits = [rng.randint(0, 1) for _ in range(80)]
    llrs = bits_to_llrs(conv_encode(bits))
    for pos in (5, 40, 90, 141):  # scattered single flips
        llrs[pos] = -llrs[pos]
    assert viterbi_decode(llrs, len(bits)) == bits


def test_conv_soft_beats_hard_on_quiet_damage():
    """The same wrong bits kill a hard decode but not a quiet (low-|LLR|) one.

    Burst kept shorter than the code memory (K-1 = 6 info bits): beyond
    that even erasures are genuinely ambiguous.
    """
    rng = random.Random(3)
    bits = [rng.randint(0, 1) for _ in range(60)]
    clean = bits_to_llrs(conv_encode(bits))
    burst = range(20, 28)

    loud = list(clean)
    quiet = list(clean)
    for pos in burst:
        loud[pos] = -loud[pos]  # confidently wrong
        quiet[pos] = -0.05 if clean[pos] > 0 else 0.05  # wrong but flagged unreliable
    assert viterbi_decode(quiet, len(bits)) == bits
    assert viterbi_decode(loud, len(bits)) != bits


def test_viterbi_too_short_returns_none():
    assert viterbi_decode([HARD_LLR] * 4, 10) is None


def test_rs_round_trip_and_correction():
    data = bytes(range(20))
    coded = bytearray(rs_encode(data, 4))
    coded[3] ^= 0xFF
    coded[11] ^= 0x55  # two byte errors, within nsym=4 budget
    assert rs_decode(bytes(coded), 4) == data


def test_rs_gives_up_beyond_budget():
    data = bytes(range(20))
    coded = bytearray(rs_encode(data, 2))
    for i in (0, 5, 9, 14):  # four byte errors against nsym=2
        coded[i] ^= 0xAA
    out = rs_decode(bytes(coded), 2)
    assert out != data  # either None or a miscorrection — never silently right


def test_interleave_round_trip():
    data = bytes(range(37))  # deliberately not a multiple of depth
    for depth in (1, 2, 4, 8):
        assert deinterleave(interleave(data, depth), depth) == data


def test_interleave_scatters_bursts():
    data = bytes(range(32))
    shuffled = interleave(data, 8)
    # a 4-byte burst in the interleaved stream lands >= depth apart originally
    positions = sorted(shuffled.index(data[i]) for i in (0, 1, 2, 3))
    assert all(b - a >= 4 for a, b in zip(positions, positions[1:]))


def test_repetition_soft_combine():
    bits = [1, 0, 1]
    llrs = bits_to_llrs(rep_encode(bits, 3))
    llrs[0] = -llrs[0]  # one vote flipped; the other two outvote it
    combined = rep_decode_soft(llrs, 3)
    assert [1 if x < 0 else 0 for x in combined] == bits
