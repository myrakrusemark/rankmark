"""Pure-logic tests for v2 framing: sync scan, header, gate, milestone window."""

import random

from rankmark.ecc import bits_to_llrs
from rankmark.framing import (
    DEFAULT_PROFILE,
    HEADER_BITS,
    PROFILES,
    build_frame,
    frame_len_bits,
    frame_spans,
    llr_of,
    parse_frames_hard,
    parse_frames_soft,
    partial_spans,
    tag_of,
)

PAYLOAD = b"\xa7"
TAG = tag_of("gpt2")


def find(frames, profile):
    return [f for f in frames if f.profile == profile]


def test_frame_round_trip_every_profile():
    for pid, profile in PROFILES.items():
        bits = build_frame(PAYLOAD, pid, TAG)
        assert len(bits) == frame_len_bits(len(PAYLOAD), pid)
        frames = find(parse_frames_hard(bits, TAG), profile.name)
        assert frames and frames[0].payload == PAYLOAD
        assert frames[0].offset == 0
        assert frames[0].tag_ok


def test_frame_found_at_arbitrary_offset():
    rng = random.Random(7)
    noise = [rng.randint(0, 1) for _ in range(97)]
    bits = noise + build_frame(b"\xa7\x42", DEFAULT_PROFILE, TAG)
    frames = find(parse_frames_hard(bits, TAG), "standard")
    assert any(f.payload == b"\xa7\x42" and f.offset == 97 for f in frames)


def test_repeated_stream_truncated_from_the_middle():
    """Copy-paste-from-the-middle: cut mid-frame, the next repetition still lands."""
    frame = build_frame(PAYLOAD, DEFAULT_PROFILE, TAG)
    stream = frame * 4
    cut = stream[len(frame) // 2 : len(frame) * 3]
    frames = find(parse_frames_hard(cut, TAG), "standard")
    assert frames and all(f.payload == PAYLOAD for f in frames)


def test_milestone_any_150_bit_window_yields_a_frame():
    """Phase-2 gate: lean frames repeat densely enough that ANY ~150-carrier
    span of the stream contains at least one whole frame."""
    frame = build_frame(PAYLOAD, 0, TAG)
    assert len(frame) <= 75, "lean frame too big for the 150-bit guarantee"
    stream = frame * 40
    for start in range(len(frame)):  # every alignment
        window = stream[start : start + 150]
        frames = find(parse_frames_hard(window, TAG), "lean")
        assert frames and frames[0].payload == PAYLOAD, f"window at {start} failed"


def test_standard_survives_scattered_bit_flips():
    frame = build_frame(b"\xa7\x01\xff", DEFAULT_PROFILE, TAG)
    rng = random.Random(11)
    llrs = bits_to_llrs(frame)
    body_start = len(PROFILES[DEFAULT_PROFILE].sync) + 9 * PROFILES[DEFAULT_PROFILE].header_rep
    for pos in rng.sample(range(body_start, len(llrs)), 6):
        llrs[pos] = -llrs[pos]
    frames = find(parse_frames_soft(llrs, TAG), "standard")
    assert frames and frames[0].payload == b"\xa7\x01\xff"


def test_wrong_lens_random_bits_never_validate():
    rng = random.Random(13)
    llrs = [rng.choice((4.0, -4.0)) for _ in range(6000)]
    assert parse_frames_soft(llrs, TAG) == []


def test_tag_mismatch_is_flagged():
    other = next(t for t in range(8) if t != TAG)
    bits = build_frame(PAYLOAD, DEFAULT_PROFILE, other)
    frames = find(parse_frames_hard(bits, TAG), "standard")
    assert frames and not frames[0].tag_ok


def test_frame_spans_tile_the_frame():
    for pid, profile in PROFILES.items():
        payload = b"\xa7\x42"
        frames = find(parse_frames_hard(build_frame(payload, pid, TAG), TAG), profile.name)
        spans = frame_spans(frames[0])
        assert spans[0]["start"] == 0 and spans[0]["kind"] == "sync"
        assert [s["start"] for s in spans] == [
            sum(t["len"] for t in spans[:i]) for i in range(len(spans))
        ]  # contiguous
        assert sum(s["len"] for s in spans) == frame_len_bits(len(payload), pid)
        kinds = [s["kind"] for s in spans]
        assert kinds[:2] == ["sync", "header"]
        assert ("woven" in kinds) == (profile.conv or profile.depth > 1)


def test_partial_spans_identify_parts_as_they_arrive():
    from rankmark.ecc import bits_to_llrs

    pid = 0  # lean: payload/checksum/parity split out, easy to check
    p = PROFILES[pid]
    full = build_frame(b"\xa7\x42", pid, TAG)

    # only sync has arrived -> just a sync span
    just_sync = partial_spans(bits_to_llrs(full[: len(p.sync)]))
    assert [s["kind"] for s in just_sync] == ["sync"]
    assert just_sync[0]["start"] == 0

    # sync + full header + a few body bits -> sync, header, and a payload span
    upto = len(p.sync) + HEADER_BITS * p.header_rep + 5
    mid = partial_spans(bits_to_llrs(full[:upto]))
    kinds = [s["kind"] for s in mid]
    assert kinds[:2] == ["sync", "header"]
    assert "payload" in kinds  # body layout known from the decoded header length
    assert sum(s["len"] for s in mid) == upto  # clipped exactly to what arrived


def test_partial_spans_empty_on_random_bits():
    import random

    rng = random.Random(5)
    llrs = [rng.choice((4.0, -4.0)) for _ in range(400)]
    # exact-sync requirement makes false positives vanishingly unlikely
    assert partial_spans(llrs) == [] or all(
        s["kind"] == "sync" for s in partial_spans(llrs)
    )


def test_llr_sign_carries_parity_and_damage_is_quiet():
    assert llr_of(0, 3.0, 2.0) > 0  # rank 0 -> bit 0
    assert llr_of(1, 3.0, 2.0) < 0  # rank 1 -> bit 1
    assert abs(llr_of(847, 3.0, 2.0)) < abs(llr_of(1, 3.0, 2.0))  # edits arrive quiet
    assert abs(llr_of(0, 2.05, 2.0)) < abs(llr_of(0, 3.0, 2.0))  # near-gate is fragile
