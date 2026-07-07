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


class StepScorer:
    """Feed tokens one at a time; step() returns the logits for the NEXT position.

    This is the only way rankmark ever computes logits. Encoder and decoder
    must share the exact numerical path — a batched teacher-forcing pass
    reorders bf16 reductions enough to flip near-tie ranks and entropy-gate
    decisions relative to cached incremental generation (~20% bit error
    observed on Qwen2.5-3B before this invariant existed).
    """

    def __init__(self, lens: Lens):
        self.lens = lens
        self._past = None

    def step(self, token_id: int) -> torch.Tensor:
        inp = torch.tensor([[token_id]], device=self.lens.device)
        with torch.no_grad():
            out = self.lens.model(inp, past_key_values=self._past, use_cache=True)
        self._past = out.past_key_values
        return out.logits[0, -1].float()


def scan(lens: Lens, token_ids: list[int]) -> list[TokenObs]:
    """Re-read a sequence step by step and observe each realized token.

    Position 0 has no context to predict it, so observations start at 1
    (or at 0 when the tokenizer defines a BOS token we can prepend).
    """
    bos = lens.tokenizer.bos_token_id
    if bos is not None and (not token_ids or token_ids[0] != bos):
        ids = [bos, *token_ids]
    else:
        ids = list(token_ids)
    offset = len(ids) - len(token_ids)  # 1 when BOS was prepended, else 0

    scorer = StepScorer(lens)
    step_logits = scorer.step(ids[0])
    obs = []
    for i in range(1, len(ids)):
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
        if i < len(ids) - 1:
            step_logits = scorer.step(tid)
    return obs
