"""Decode: re-read text through a lens, recover ranks, gate, parse frames.

No stored per-text state — encoder and decoder share only the algorithm and
tau. If the lens doesn't match the generator, the gate desyncs and the CRC
fails: that failure is the attribution signal.
"""

from dataclasses import dataclass, field

from .channel import ChannelParams, Frame, parse_frames
from .models import Lens
from .tokenobs import TokenObs, scan


@dataclass
class DecodeResult:
    obs: list[TokenObs]
    carrier_positions: list[int]
    bits: list[int]
    frames: list[Frame]
    fingerprint: dict = field(default_factory=dict)

    @property
    def valid(self) -> bool:
        return bool(self.frames)

    @property
    def payload(self) -> bytes | None:
        return self.frames[0].payload if self.frames else None


def gate_bits(obs: list[TokenObs], params: ChannelParams) -> tuple[list[TokenObs], list[int]]:
    """Re-apply the entropy gate and read carrier parities."""
    carriers = [o for o in obs if o.entropy >= params.tau]
    return carriers, [o.rank % 2 for o in carriers]


def decode(lens: Lens, text: str, params: ChannelParams | None = None) -> DecodeResult:
    params = params or ChannelParams()
    ids = lens.tokenizer(text, add_special_tokens=False).input_ids
    obs = scan(lens, ids)
    carriers, bits = gate_bits(obs, params)
    return DecodeResult(
        obs=obs,
        carrier_positions=[o.pos for o in carriers],
        bits=bits,
        frames=parse_frames(bits),
        fingerprint=lens.fingerprint,
    )
