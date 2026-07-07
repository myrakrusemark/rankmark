"""Deterministic lens loading.

A lens is a frozen (model, tokenizer) pair used both to steer generation and
to recover ranks at decode time. Rank recovery requires the decoder to
reproduce the encoder's exact logit ordering, so everything here is pinned:
eval mode, batch size 1, deterministic algorithms, one dtype per lens.
"""

from dataclasses import dataclass, field

import torch
from transformers import AutoModelForCausalLM, AutoTokenizer

DTYPES = {"float32": torch.float32, "bfloat16": torch.bfloat16}


@dataclass
class Lens:
    name: str
    model: object
    tokenizer: object
    dtype: torch.dtype
    fingerprint: dict = field(default_factory=dict)

    @property
    def device(self) -> torch.device:
        return next(self.model.parameters()).device


def load_lens(name: str, dtype: str | None = None) -> Lens:
    """Load a lens with the checkpoint's native dtype unless overridden.

    Native dtype (gpt2 -> fp32, Qwen2.5 -> bf16) keeps peak memory at one
    copy of the weights. fp16 is deliberately unsupported: its rank ties
    are a known failure mode.
    """
    torch.use_deterministic_algorithms(True)
    torch.backends.cuda.matmul.allow_tf32 = False

    tokenizer = AutoTokenizer.from_pretrained(name)
    model = AutoModelForCausalLM.from_pretrained(
        name, dtype=DTYPES[dtype] if dtype else "auto", low_cpu_mem_usage=True
    )
    actual = next(model.parameters()).dtype
    if actual not in DTYPES.values():
        raise ValueError(f"{name} loaded as {actual}; only fp32/bf16 lenses are supported")
    model.eval()

    import transformers

    fingerprint = {
        "model": name,
        "revision": getattr(model.config, "_commit_hash", None),
        "dtype": str(actual).removeprefix("torch."),
        "torch": torch.__version__,
        "transformers": transformers.__version__,
    }
    return Lens(name=name, model=model, tokenizer=tokenizer, dtype=actual, fingerprint=fingerprint)
