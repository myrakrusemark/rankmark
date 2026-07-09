"""The v2 self-clocking frame: [ SYNC | HEADER | ECC( PAYLOAD || CRC ) ] repeated.

The decoder knows nothing about where the watermark starts — it slides a
correlator over the carrier bit-stream looking for each profile's SYNC
pattern, reads the tiny repetition-coded header (payload length + namespace
tag), then peels the body back through the ECC stack. The CRC at the center
is the attribution gate: a wrong-lens decode desyncs the entropy gate, and
whatever bits it reads will not checksum-validate.

Profiles own their whole frame geometry (sync length, header repetition,
gate width, ECC stack), because they trade capacity against robustness:

  lean      Barker-13 sync, header x2, CRC16 gate, RS(+2). 71-bit frame for a
            1-byte payload — small enough that any ~150-carrier span of a
            repeated stream contains one whole frame (the Phase-2 milestone).
  standard  31-chip m-sequence, header x3, CRC32 gate, RS(+4) + interleave +
            rate-1/2 convolutional inner code with soft Viterbi.
  robust    header x5, MAGIC16+CRC32 gate (~2^-48 with header consistency),
            RS(+8), deeper interleave.

Deviation from the build plan noted: the plan sketches one fixed geometry
(31-chip sync, header x5). At measured capacity (~63 carrier bits per 500
Qwen tokens at tau=2.0) that geometry cannot meet its own milestone gate, so
geometry moved into the profile and the scan tries each known profile.
"""

import zlib
from dataclasses import dataclass

from .channel import bits_to_bytes, bits_to_int, bytes_to_bits, crc16, int_to_bits
from .ecc import (
    HARD_LLR,
    bits_to_llrs,
    conv_encode,
    CONV_TAIL,
    deinterleave,
    interleave,
    llrs_to_bits,
    rep_decode_soft,
    rep_encode,
    rs_decode,
    rs_encode,
    viterbi_decode,
)

MAGIC = 0xB65D

BARKER_13 = [1, 1, 1, 1, 1, 0, 0, 1, 1, 0, 1, 0, 1]
# 31-chip m-sequence from the x^5 + x^2 + 1 LFSR, seed 1.
MSEQ_31 = [1, 0, 0, 0, 0, 1, 0, 1, 0, 1, 1, 1, 0, 1, 1,
           0, 0, 0, 1, 1, 1, 1, 1, 0, 0, 1, 1, 0, 1, 0, 0]

LEN_BITS = 6  # payload length in bytes, 1..63
TAG_BITS = 3  # namespace tag: which model family claims this frame
HEADER_BITS = LEN_BITS + TAG_BITS


@dataclass(frozen=True)
class Profile:
    name: str
    sync: tuple[int, ...]
    sync_tol: int  # chips allowed to mismatch during the scan
    header_rep: int
    crc_bytes: int  # 2 = CRC16, 4 = CRC32, 6 = MAGIC16 + CRC32
    rs_nsym: int
    conv: bool
    depth: int  # interleave depth over the RS codeword


PROFILES: dict[int, Profile] = {
    0: Profile("lean", tuple(BARKER_13), 1, 2, 2, 2, False, 1),
    1: Profile("standard", tuple(MSEQ_31), 3, 3, 4, 4, True, 4),
    2: Profile("robust", tuple(MSEQ_31), 5, 5, 6, 8, True, 8),
}
DEFAULT_PROFILE = 1


@dataclass
class DecodedFrame:
    offset: int  # carrier-bit offset where SYNC matched
    payload: bytes
    profile: str
    tag: int
    tag_ok: bool
    sync_errors: int


def tag_of(model_name: str) -> int:
    return crc16(model_name.encode()) & ((1 << TAG_BITS) - 1)


def _checksum(payload: bytes, crc_bytes: int) -> bytes:
    if crc_bytes == 2:
        return crc16(payload).to_bytes(2)
    crc = zlib.crc32(payload).to_bytes(4)
    return crc if crc_bytes == 4 else MAGIC.to_bytes(2) + crc


def _body_coded_bits(payload_len: int, p: Profile) -> int:
    nbits = 8 * (payload_len + p.crc_bytes + p.rs_nsym)
    return 2 * (nbits + CONV_TAIL) if p.conv else nbits


def frame_len_bits(payload_len: int, profile_id: int) -> int:
    p = PROFILES[profile_id]
    return len(p.sync) + HEADER_BITS * p.header_rep + _body_coded_bits(payload_len, p)


def build_frame(payload: bytes, profile_id: int, tag: int) -> list[int]:
    p = PROFILES[profile_id]
    if not 1 <= len(payload) <= (1 << LEN_BITS) - 1:
        raise ValueError(f"payload must be 1..{(1 << LEN_BITS) - 1} bytes")

    body = interleave(rs_encode(payload + _checksum(payload, p.crc_bytes), p.rs_nsym), p.depth)
    body_bits = bytes_to_bits(body)
    if p.conv:
        body_bits = conv_encode(body_bits)

    header = int_to_bits(len(payload), LEN_BITS) + int_to_bits(tag, TAG_BITS)
    return list(p.sync) + rep_encode(header, p.header_rep) + body_bits


def _decode_body(llrs: list[float], payload_len: int, p: Profile) -> bytes | None:
    nbits = 8 * (payload_len + p.crc_bytes + p.rs_nsym)
    bits = viterbi_decode(llrs, nbits) if p.conv else llrs_to_bits(llrs)
    if bits is None:
        return None
    decoded = rs_decode(deinterleave(bits_to_bytes(bits), p.depth), p.rs_nsym)
    if decoded is None:
        return None
    payload = decoded[:payload_len]
    if decoded[payload_len:] != _checksum(payload, p.crc_bytes):
        return None
    return payload


def parse_frames_soft(llrs: list[float], lens_tag: int | None = None) -> list[DecodedFrame]:
    """Scan every offset under every profile geometry; return gate-passing frames.

    Frames whose header tag disagrees with `lens_tag` are kept but flagged
    tag_ok=False — the caller treats them as collision artifacts (a frame
    CRC-passing under lens M but carrying another family's tag is rejected
    from attribution, per the Phase-3 consistency rule).
    """
    hard = llrs_to_bits(llrs)
    frames = []
    for p in PROFILES.values():
        sync_len, hdr_len = len(p.sync), HEADER_BITS * p.header_rep
        for off in range(len(llrs) - sync_len - hdr_len + 1):
            errs = sum(b != s for b, s in zip(hard[off : off + sync_len], p.sync))
            if errs > p.sync_tol:
                continue
            hdr_soft = rep_decode_soft(llrs[off + sync_len : off + sync_len + hdr_len],
                                       p.header_rep)
            hdr = llrs_to_bits(hdr_soft)
            payload_len = bits_to_int(hdr[:LEN_BITS])
            tag = bits_to_int(hdr[LEN_BITS:])
            if payload_len == 0:
                continue
            start = off + sync_len + hdr_len
            end = start + _body_coded_bits(payload_len, p)
            if end > len(llrs):
                continue
            payload = _decode_body(llrs[start:end], payload_len, p)
            if payload is None:
                continue
            frames.append(DecodedFrame(
                offset=off,
                payload=payload,
                profile=p.name,
                tag=tag,
                tag_ok=lens_tag is None or tag == lens_tag,
                sync_errors=errs,
            ))
    return frames


def parse_frames_hard(bits: list[int], lens_tag: int | None = None) -> list[DecodedFrame]:
    return parse_frames_soft(bits_to_llrs(bits), lens_tag)


def frame_layout(payload_len: int, p: Profile) -> list[tuple[str, int]]:
    """(kind, bit-length) parts of one frame, in wire order from its sync.

    Profiles without an inner code expose payload / checksum / parity
    separately; conv or interleaved profiles braid the body, so it is one
    'woven' span.
    """
    parts = [("sync", len(p.sync)), ("header", HEADER_BITS * p.header_rep)]
    if p.conv or p.depth > 1:
        parts.append(("woven", _body_coded_bits(payload_len, p)))
    else:
        parts += [("payload", 8 * payload_len),
                  ("checksum", 8 * p.crc_bytes),
                  ("parity", 8 * p.rs_nsym)]
    return parts


def _spans_from(layout: list[tuple[str, int]], offset: int, limit: int) -> list[dict]:
    spans, cur = [], offset
    for kind, n in layout:
        if cur >= limit:
            break
        spans.append({"kind": kind, "start": cur, "len": min(n, limit - cur)})
        cur += n
    return spans


def frame_spans(frame: DecodedFrame) -> list[dict]:
    """Labelled bit ranges of a fully decoded (checksum-valid) frame."""
    p = next(q for q in PROFILES.values() if q.name == frame.profile)
    layout = frame_layout(len(frame.payload), p)
    total = sum(n for _, n in layout)
    return _spans_from(layout, frame.offset, frame.offset + total)


def partial_spans(llrs: list[float]) -> list[dict]:
    """Tentative labelling of the frame currently arriving at the tail — sync
    the moment it correlates, header once its bits land, and the body regions
    as they stream in, BEFORE the checksum confirms anything.

    Requires an EXACT sync match (not the tolerance parse_frames_soft allows):
    on the author's own lens real syncs are planted exactly, so this lights up
    true frames as they assemble while a random wrong-lens stream shows nothing.
    Display only — parse_frames_soft remains the source of truth.
    """
    hard = llrs_to_bits(llrs)
    n = len(hard)
    best = None  # (offset, profile) — the latest exact sync = frame in progress
    for p in PROFILES.values():
        sync_len = len(p.sync)
        for off in range(n - sync_len, -1, -1):
            if all(b == s for b, s in zip(hard[off : off + sync_len], p.sync)):
                if best is None or off > best[0]:
                    best = (off, p)
                break
    if best is None:
        return []
    off, p = best
    hdr_len = HEADER_BITS * p.header_rep
    hdr_start = off + len(p.sync)
    # can't read the body layout until the whole header has arrived
    if hdr_start + hdr_len > n:
        return _spans_from([("sync", len(p.sync)), ("header", hdr_len)], off, n)
    hdr = llrs_to_bits(rep_decode_soft(llrs[hdr_start : hdr_start + hdr_len], p.header_rep))
    payload_len = bits_to_int(hdr[:LEN_BITS])
    if not 1 <= payload_len <= (1 << LEN_BITS) - 1:
        return _spans_from([("sync", len(p.sync)), ("header", hdr_len)], off, n)
    return _spans_from(frame_layout(payload_len, p), off, n)


def llr_of(rank: int, entropy: float, tau: float) -> float:
    """Per-carrier soft bit from what the lens saw at that position.

    Sign carries the parity (positive = bit 0). Magnitude is a heuristic
    confidence: a marked token sits at rank 0/1, so higher ranks smell like
    edit damage; entropy sitting right on the gate means the carrier/null
    decision itself is fragile.
    """
    conf = HARD_LLR if rank <= 1 else (1.0 if rank < 10 else 0.3)
    conf *= max(0.25, min(1.0, abs(entropy - tau)))
    return conf if rank % 2 == 0 else -conf
