"""Arm A channel: entropy-gated rank parity.

The bit layer only — how one payload bit becomes one token choice, plus the
shared bit/byte/CRC helpers. The frame around the bits (sync, header, ECC,
the attribution gate) lives in framing.py.
"""

from dataclasses import dataclass

import torch

from .tokenobs import entropy_of


@dataclass
class ChannelParams:
    tau: float = 2.0  # entropy gate, nats: below this a step is a carrier-null
    profile: int = 1  # frame profile id, see framing.PROFILES
    window: int | None = None  # bound rank context to this many tokens; None = full prefix.
    # Full-context ranks die under head-truncation (every downstream near-tie
    # flips); a window makes cut damage end after `window` tokens by construction.


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


def sorted_token_ids(logits: torch.Tensor) -> torch.Tensor:
    """Descending by logit; ties resolve to the lower token id (stable sort).

    This is the same ordering rank_of() implies — the one rule both sides share.
    """
    return torch.sort(logits, descending=True, stable=True).indices


@dataclass
class StepChoice:
    token_id: int
    planted: bool
    rank: int  # rank actually emitted: 0 for nulls, the bit value otherwise
    entropy: float


def encode_step(
    logits: torch.Tensor, next_bit: int, params: ChannelParams, ban_token: int | None = None
) -> StepChoice:
    """Pick the next token.

    Below the entropy gate: emit rank 0 as a carrier-null, plant nothing.
    Above it: emit the highest-probability token whose rank parity equals
    next_bit — rank 0 for a 0 bit, rank 1 for a 1 bit.

    A banned token (the encoder bans EOS until a whole frame is planted, so
    the model can't end the text before the message is in) is replaced by
    the next-best choice that changes nothing for the decoder: nulls carry
    no bits, and carriers skip to the next rank of the SAME parity.
    """
    logits = logits.float()
    entropy = entropy_of(logits)
    order = sorted_token_ids(logits)
    if entropy < params.tau:
        rank = 1 if int(order[0]) == ban_token else 0
        return StepChoice(int(order[rank]), False, rank, entropy)
    rank = next_bit
    while int(order[rank]) == ban_token:
        rank += 2  # same parity, next-best token
    return StepChoice(int(order[rank]), True, rank, entropy)
