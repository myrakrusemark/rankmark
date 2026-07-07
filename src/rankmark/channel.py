"""Arm A channel: entropy-gated rank parity, and the self-clocking frame.

A frame is [ MAGIC(16) | LEN(8) | PAYLOAD | CRC16 ], repeated back-to-back
for as long as generation runs. MAGIC gives the decoder sync without knowing
where the watermark starts; CRC16 over LEN+PAYLOAD is the validation gate —
a wrong-lens decode passing both is ~2^-32 per offset.
"""

from dataclasses import dataclass

import torch

from .tokenobs import entropy_of

MAGIC = 0xB65D
MAGIC_BITS = 16
LEN_BITS = 8
CRC_BITS = 16
MIN_FRAME_BITS = MAGIC_BITS + LEN_BITS + 8 + CRC_BITS


@dataclass
class ChannelParams:
    tau: float = 2.0  # entropy gate, nats: below this a step is a carrier-null


@dataclass
class Frame:
    offset: int  # bit offset where MAGIC matched
    payload: bytes


def crc16(data: bytes) -> int:
    """CRC-16/CCITT-FALSE."""
    crc = 0xFFFF
    for byte in data:
        crc ^= byte << 8
        for _ in range(8):
            crc = ((crc << 1) ^ 0x1021) & 0xFFFF if crc & 0x8000 else (crc << 1) & 0xFFFF
    return crc


def int_to_bits(value: int, width: int) -> list[int]:
    return [(value >> (width - 1 - i)) & 1 for i in range(width)]


def bits_to_int(bits: list[int]) -> int:
    value = 0
    for bit in bits:
        value = (value << 1) | bit
    return value


def bytes_to_bits(data: bytes) -> list[int]:
    return [bit for byte in data for bit in int_to_bits(byte, 8)]


def bits_to_bytes(bits: list[int]) -> bytes:
    return bytes(bits_to_int(bits[i : i + 8]) for i in range(0, len(bits), 8))


def frame_bits(payload: bytes) -> list[int]:
    if not 1 <= len(payload) <= 255:
        raise ValueError("payload must be 1..255 bytes")
    body = bytes([len(payload)]) + payload
    return int_to_bits(MAGIC, MAGIC_BITS) + bytes_to_bits(body) + int_to_bits(crc16(body), CRC_BITS)


def parse_frames(bits: list[int]) -> list[Frame]:
    """Slide over every bit offset looking for MAGIC, then CRC-validate."""
    frames = []
    for off in range(len(bits) - MIN_FRAME_BITS + 1):
        if bits_to_int(bits[off : off + MAGIC_BITS]) != MAGIC:
            continue
        length = bits_to_int(bits[off + MAGIC_BITS : off + MAGIC_BITS + LEN_BITS])
        end = off + MAGIC_BITS + LEN_BITS + 8 * length + CRC_BITS
        if length == 0 or end > len(bits):
            continue
        body = bits_to_bytes(bits[off + MAGIC_BITS : end - CRC_BITS])
        if crc16(body) == bits_to_int(bits[end - CRC_BITS : end]):
            frames.append(Frame(offset=off, payload=body[1:]))
    return frames


def sorted_token_ids(logits: torch.Tensor) -> torch.Tensor:
    """Descending by logit; ties resolve to the lower token id (stable sort).

    This is the same ordering rank_of() implies — the one rule both sides share.
    """
    return torch.sort(logits, descending=True, stable=True).indices


def encode_step(logits: torch.Tensor, next_bit: int, params: ChannelParams) -> tuple[int, bool]:
    """Pick the next token. Returns (token_id, bit_was_planted).

    Below the entropy gate: emit rank 0 as a carrier-null, plant nothing.
    Above it: emit the highest-probability token whose rank parity equals
    next_bit — rank 0 for a 0 bit, rank 1 for a 1 bit.
    """
    logits = logits.float()
    if entropy_of(logits) < params.tau:
        return int(logits.argmax()), False
    order = sorted_token_ids(logits)
    return int(order[next_bit]), True
