"""Deterministic lens loading.

A lens is a frozen (model, tokenizer) pair used both to steer generation and
to recover ranks at decode time. Rank recovery requires the decoder to
reproduce the encoder's exact logit ordering, so everything here is pinned:
eval mode, batch size 1, deterministic algorithms, one dtype per lens —
and one device class, recorded in the fingerprint: CUDA and CPU order
their reductions differently, so a text embedded on one does not decode
on the other.
"""

import os

# must be set before the first cuBLAS call or use_deterministic_algorithms
# refuses to run GEMMs on CUDA; harmless on CPU-only machines
os.environ.setdefault("CUBLAS_WORKSPACE_CONFIG", ":4096:8")

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


def load_lens(name: str, dtype: str | None = None, device: str | None = None) -> Lens:
    """Load a lens with the checkpoint's native dtype unless overridden.

    Native dtype (gpt2 -> fp32, Qwen2.5 -> bf16) keeps peak memory at one
    copy of the weights. fp16 is deliberately unsupported: its rank ties
    are a known failure mode.

    `device` defaults to CUDA when available. TF32 stays off in both cuBLAS
    and cuDNN — it truncates mantissas per-kernel, which flips near-tie ranks.
    """
    torch.use_deterministic_algorithms(True)
    torch.backends.cuda.matmul.allow_tf32 = False
    torch.backends.cudnn.allow_tf32 = False

    device = device or ("cuda" if torch.cuda.is_available() else "cpu")
    tokenizer = AutoTokenizer.from_pretrained(name)
    model = AutoModelForCausalLM.from_pretrained(
        name, dtype=DTYPES[dtype] if dtype else "auto", low_cpu_mem_usage=True
    )
    actual = next(model.parameters()).dtype
    if actual not in DTYPES.values():
        raise ValueError(f"{name} loaded as {actual}; only fp32/bf16 lenses are supported")
    model.to(device)
    model.eval()

    import transformers

    fingerprint = {
        "model": name,
        "revision": getattr(model.config, "_commit_hash", None),
        "dtype": str(actual).removeprefix("torch."),
        "device": torch.device(device).type,  # cuda/cpu reductions differ — part of the key
        "torch": torch.__version__,
        "transformers": transformers.__version__,
    }
    return Lens(name=name, model=model, tokenizer=tokenizer, dtype=actual, fingerprint=fingerprint)
