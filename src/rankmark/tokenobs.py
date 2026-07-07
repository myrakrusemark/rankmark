"""Teacher-forcing scan: one TokenObs per position, the atomic record
that encode, decode, heatmap, and attribution all read."""

from dataclasses import dataclass

import torch

from .models import Lens

GLTR_BUCKETS = (10, 100, 1000)


@dataclass
class TokenObs:
    pos: int
    token_id: int
    rank: int  # 0-indexed rank of realized token in this lens's sorted logits
    logprob: float
    entropy: float  # H(p_t), nats — drives the carrier/null gate
    bucket: int  # GLTR: 0=top10 1=top100 2=top1000 3=beyond


def bucket_of(rank: int) -> int:
    for i, edge in enumerate(GLTR_BUCKETS):
        if rank < edge:
            return i
    return 3


def rank_of(logits: torch.Tensor, token_id: int) -> int:
    """Rank under the frozen tie-break: sort by (-logit, token_id).

    Identical rule on both encode and decode sides; ties resolve to the
    lower token id, so equal-logit tokens with smaller ids rank ahead.
    """
    chosen = logits[token_id]
    greater = (logits > chosen).sum()
    tied_before = (logits[:token_id] == chosen).sum()
    return int(greater + tied_before)


def entropy_of(logits: torch.Tensor) -> float:
    logp = torch.log_softmax(logits.float(), dim=-1)
    return float(-(logp.exp() * logp).sum())


def scan(lens: Lens, token_ids: list[int]) -> list[TokenObs]:
    """Teacher-force the sequence and observe each realized token.

    Position 0 has no context to predict it, so observations start at 1
    (or at 0 when the tokenizer defines a BOS token we can prepend).
    """
    bos = lens.tokenizer.bos_token_id
    if bos is not None and (not token_ids or token_ids[0] != bos):
        ids = [bos, *token_ids]
    else:
        ids = list(token_ids)
    offset = len(ids) - len(token_ids)  # 1 when BOS was prepended, else 0

    input_ids = torch.tensor([ids], device=lens.device)
    with torch.no_grad():
        logits = lens.model(input_ids).logits[0]

    obs = []
    for i in range(1, len(ids)):
        step_logits = logits[i - 1].float()
        tid = ids[i]
        rank = rank_of(step_logits, tid)
        logp = torch.log_softmax(step_logits, dim=-1)[tid]
        obs.append(
            TokenObs(
                pos=i - offset,
                token_id=tid,
                rank=rank,
                logprob=float(logp),
                entropy=entropy_of(step_logits),
                bucket=bucket_of(rank),
            )
        )
    return obs
