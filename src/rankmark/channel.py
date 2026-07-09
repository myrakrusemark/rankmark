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
    temperature: float = 0.0  # 0 = greedy (rank 0/1, deterministic). Above 0, sample.
    top_k: int = 48  # sampling candidate window (only used when temperature > 0)
    # Temperature breaks the greedy repetition loops small models fall into: a
    # null samples freely (this is what escapes a loop), a carrier samples among
    # tokens of the RIGHT PARITY. The decoder only reads rank parity, never which
    # token was picked, so rank 7 carries a 1-bit exactly as rank 1 does — the
    # round trip is unchanged, but the text stops looking like a wall of rank-0.


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
    logits: torch.Tensor,
    next_bit: int,
    params: ChannelParams,
    ban_token: int | None = None,
    generator: torch.Generator | None = None,
) -> StepChoice:
    """Pick the next token.

    Greedy (temperature 0): below the gate emit rank 0 (a carrier-null);
    above it emit the top token whose rank parity equals next_bit — rank 0
    for a 0 bit, rank 1 for a 1 bit.

    Temperature > 0: sample instead of taking the top. A null samples across
    the top_k window (breaking the greedy repetition loops small models fall
    into); a carrier samples among top_k tokens of the RIGHT PARITY. Either
    way the decoder only reads rank parity, so a deeper same-parity pick
    carries the same bit — the round trip is identical, the text just stops
    looking like a suspicious wall of rank-0 tokens.

    A banned token (the encoder bans EOS until a whole frame is planted) is
    dropped from the candidates; greedily it is replaced by the next choice
    of the same role — nulls carry nothing, carriers keep their parity.
    """
    logits = logits.float()
    entropy = entropy_of(logits)
    order = sorted_token_ids(logits)
    is_null = entropy < params.tau

    if params.temperature <= 0.0:
        if is_null:
            rank = 1 if int(order[0]) == ban_token else 0
            return StepChoice(int(order[rank]), False, rank, entropy)
        rank = next_bit
        while int(order[rank]) == ban_token:
            rank += 2  # same parity, next-best token
        return StepChoice(int(order[rank]), True, rank, entropy)

    # temperature sampling among candidate ranks of the right role/parity
    k = min(params.top_k, int(order.numel()))
    cand = [r for r in range(k) if is_null or r % 2 == next_bit]
    cand = [r for r in cand if int(order[r]) != ban_token] or cand
    cand_logits = logits[order[cand]]
    probs = torch.softmax(cand_logits / params.temperature, dim=-1)
    rank = cand[int(torch.multinomial(probs, 1, generator=generator))]
    return StepChoice(int(order[rank]), not is_null, rank, entropy)
