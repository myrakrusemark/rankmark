"""Error-correction primitives for the v2 frame: RS outer, interleave, conv inner.

Everything here is pure bit/byte logic — no torch, no model. Soft values are
LLRs (log-likelihood ratios): positive means "this bit is probably 0",
negative means "probably 1", magnitude is confidence. Hard bits pass through
as +/- a fixed magnitude.
"""

from reedsolo import ReedSolomonError, RSCodec

HARD_LLR = 4.0

# Rate-1/2 convolutional code, K=7, the classic (171, 133) octal pair.
CONV_K = 7
CONV_POLYS = (0o171, 0o133)
CONV_STATES = 1 << (CONV_K - 1)
CONV_TAIL = CONV_K - 1  # zero-flush bits appended to return the coder to state 0


def bits_to_llrs(bits: list[int]) -> list[float]:
    return [-HARD_LLR if b else HARD_LLR for b in bits]


def llrs_to_bits(llrs: list[float]) -> list[int]:
    return [1 if x < 0 else 0 for x in llrs]


# --- repetition ----------------------------------------------------------


def rep_encode(bits: list[int], factor: int) -> list[int]:
    return [b for b in bits for _ in range(factor)]


def rep_decode_soft(llrs: list[float], factor: int) -> list[float]:
    """Combine repeated transmissions by summing their LLRs."""
    return [sum(llrs[i : i + factor]) for i in range(0, len(llrs), factor)]


# --- block interleave -----------------------------------------------------


def _interleave_order(n: int, depth: int) -> list[int]:
    """Read order for writing row-major into `depth` rows: column by column."""
    return [row * -(-n // depth) + col  # rows are ceil(n/depth) wide
            for col in range(-(-n // depth))
            for row in range(depth)
            if row * -(-n // depth) + col < n]


def interleave(data: bytes, depth: int) -> bytes:
    if depth <= 1:
        return data
    return bytes(data[i] for i in _interleave_order(len(data), depth))


def deinterleave(data: bytes, depth: int) -> bytes:
    if depth <= 1:
        return data
    out = bytearray(len(data))
    for dst, src in enumerate(_interleave_order(len(data), depth)):
        out[src] = data[dst]
    return bytes(out)


# --- Reed-Solomon over GF(2^8) --------------------------------------------


def rs_encode(data: bytes, nsym: int) -> bytes:
    if nsym == 0:
        return data
    return bytes(RSCodec(nsym).encode(data))


def rs_decode(data: bytes, nsym: int) -> bytes | None:
    """Corrected message bytes, or None when RS gives up.

    Note RS can also *miscorrect* heavy noise into a wrong-but-consistent
    codeword — that is exactly why the CRC gate above it exists (the BREW
    false-detection ablation reproduces this).
    """
    if nsym == 0:
        return data
    try:
        decoded = RSCodec(nsym).decode(bytes(data))
    except ReedSolomonError:
        return None
    return bytes(decoded[0] if isinstance(decoded, tuple) else decoded)


# --- convolutional + soft Viterbi -----------------------------------------


def _conv_outputs(state: int, bit: int) -> tuple[int, tuple[int, int]]:
    """(next_state, (out0, out1)) for one input bit from `state`."""
    reg = (bit << (CONV_K - 1)) | state
    outs = tuple(bin(reg & poly).count("1") & 1 for poly in CONV_POLYS)
    return reg >> 1, outs


def conv_encode(bits: list[int]) -> list[int]:
    """Rate-1/2 encode with a zero tail; output is 2*(len(bits)+CONV_TAIL)."""
    out = []
    state = 0
    for bit in [*bits, *([0] * CONV_TAIL)]:
        state, (o0, o1) = _conv_outputs(state, bit)
        out += [o0, o1]
    return out


def viterbi_decode(llrs: list[float], nbits: int) -> list[int] | None:
    """Soft-input Viterbi over the (171,133) trellis.

    `llrs` must cover 2*(nbits+CONV_TAIL) coded bits; returns the `nbits`
    message bits, or None if the stream is too short.
    """
    steps = nbits + CONV_TAIL
    if len(llrs) < 2 * steps:
        return None

    NEG = float("-inf")
    metrics = [NEG] * CONV_STATES
    metrics[0] = 0.0
    history: list[list[int]] = []

    for t in range(steps):
        pair = llrs[2 * t : 2 * t + 2]
        new = [NEG] * CONV_STATES
        back = [0] * CONV_STATES
        for state in range(CONV_STATES):
            if metrics[state] == NEG:
                continue
            for bit in (0, 1):
                nxt, outs = _conv_outputs(state, bit)
                # agreement with the received soft values: +llr for 0, -llr for 1
                m = metrics[state] + sum(
                    llr if o == 0 else -llr for o, llr in zip(outs, pair)
                )
                if m > new[nxt]:
                    new[nxt] = m
                    back[nxt] = (state << 1) | bit
        metrics = new
        history.append(back)

    state = 0  # zero tail forces the end state
    bits: list[int] = []
    for back in reversed(history):
        packed = back[state]
        bits.append(packed & 1)
        state = packed >> 1
    bits.reverse()
    return bits[:nbits]
