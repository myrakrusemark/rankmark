"""The echo: a message pressed into the text with no frame around it. The packet
is the model tag, the coded message and a checksum; every carrier word votes
for one packet bit, chosen by the words just before it. Slots come in runs: a
hash of the previous k token ids either opens a new run at the slot it names
(about one word in eight) or continues the run one slot on. Mirrors echo.js;
the two must stay bit-exact."""

from __future__ import annotations

from dataclasses import dataclass

from .channel import bits_to_bytes, bits_to_int, bytes_to_bits, crc16, int_to_bits

TAG_BITS = 3
CRC_BYTES = 2
K = 4
ANCHOR_EVERY = 8
MAX_BYTES = 8


def echo_len(payload_len: int) -> int:
    return TAG_BITS + 8 * (payload_len + CRC_BYTES)


def build_echo(payload: bytes, tag: int) -> list[int]:
    if not 1 <= len(payload) <= MAX_BYTES:
        raise ValueError(f"echo payload must be 1..{MAX_BYTES} bytes")
    c = crc16(payload)
    return int_to_bits(tag, TAG_BITS) + bytes_to_bits(payload) + bytes_to_bits(bytes([(c >> 8) & 0xFF, c & 0xFF]))


def echo_hash(ids: list[int]) -> int:
    h = 2166136261
    for i in ids:
        h = ((h ^ (i & 0xFFFFFFFF)) * 16777619) & 0xFFFFFFFF
    return h


class EchoSlots:
    def __init__(self, n: int) -> None:
        self.n = n
        self.start: int | None = None
        self.offset = 0

    def next(self, prev_ids: list[int]) -> int:
        h = echo_hash(prev_ids)
        if self.start is None or (h >> 8) % ANCHOR_EVERY == 0:
            self.start = (h >> 11) % self.n
            self.offset = 0
        else:
            self.offset += 1
        return (self.start + self.offset) % self.n


@dataclass
class EchoResult:
    valid: bool
    payload: bytes | None
    tag: int
    tag_ok: bool
    votes: list[int]
    min_votes: int
    covered: int
    bits: list[int]


def parse_echo(llrs: list[float], slots: list[int | None], n: int, lens_tag: int | None = None) -> EchoResult:
    total = [0.0] * n
    votes = [0] * n
    for llr, j in zip(llrs, slots):
        if j is None:
            continue
        total[j] += llr
        votes[j] += 1
    bits = [1 if x < 0 else 0 for x in total]
    tag = bits_to_int(bits[:TAG_BITS])
    body = bits_to_bytes(bits[TAG_BITS:])
    payload_len = len(body) - CRC_BYTES
    payload, got = body[:payload_len], body[payload_len:]
    c = crc16(payload)
    valid = payload_len >= 1 and got == bytes([(c >> 8) & 0xFF, c & 0xFF])
    return EchoResult(valid, payload if valid else None, tag, lens_tag is None or tag == lens_tag,
                      votes, min(votes) if votes else 0, sum(1 for v in votes if v), bits)


def echo_lengths() -> list[int]:
    return [echo_len(i + 1) for i in range(MAX_BYTES)]
