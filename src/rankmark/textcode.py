"""A fixed code for short messages: a static Huffman table over English letters,
space, digits and common punctuation, an escape for any other byte, and an end
mark. Mirrors textcode.js; the two must stay bit-exact."""

from __future__ import annotations

# [symbol, code length] in canonical order: codes are assigned in this order
TABLE: list[tuple[str, int]] = [tuple(x) for x in [[" ", 3], ["a", 4], ["e", 4], ["i", 4], ["n", 4], ["o", 4], ["s", 4], ["t", 4], ["d", 5], ["h", 5], ["l", 5], ["r", 5], ["END", 6], [",", 6], [".", 6], ["c", 6], ["f", 6], ["g", 6], ["m", 6], ["p", 6], ["u", 6], ["w", 6], ["y", 6], ["'", 7], ["E", 7], ["b", 7], ["k", 7], ["v", 7], ["!", 8], ["-", 8], ["?", 8], ["A", 8], ["H", 8], ["I", 8], ["N", 8], ["O", 8], ["R", 8], ["S", 8], ["T", 8], ["\n", 9], ["\"", 9], ["0", 9], ["1", 9], ["2", 9], ["3", 9], ["4", 9], ["5", 9], ["6", 9], ["7", 9], ["8", 9], ["9", 9], [":", 9], ["C", 9], ["D", 9], ["L", 9], ["U", 9], ["W", 9], ["j", 9], ["x", 9], ["(", 10], [")", 10], ["/", 10], [";", 10], ["B", 10], ["F", 10], ["G", 10], ["M", 10], ["P", 10], ["Y", 10], ["q", 10], ["z", 10], ["ESC", 11], ["#", 11], ["$", 11], ["%", 11], ["&", 11], ["*", 11], ["+", 11], ["=", 11], ["@", 11], ["J", 11], ["K", 11], ["Q", 11], ["V", 11], ["X", 11], ["Z", 11], ["_", 11]]]

CODES: dict[str, tuple[int, int]] = {}
BY_CODE: dict[tuple[int, int], str] = {}
_code, _len = 0, 0
for _sym, _l in TABLE:
    _code <<= _l - _len
    _len = _l
    CODES[_sym] = (_code, _l)
    BY_CODE[(_l, _code)] = _sym
    _code += 1
MAXLEN = TABLE[-1][1]


def message_bits(text: str) -> list[int]:
    bits: list[int] = []

    def push(code: int, length: int) -> None:
        for i in range(length - 1, -1, -1):
            bits.append((code >> i) & 1)

    for ch in text:
        if ch in CODES:
            push(*CODES[ch])
            continue
        for b in ch.encode("utf-8"):
            push(*CODES["ESC"])
            push(b, 8)
    push(*CODES["END"])
    return bits


def encode_message(text: str) -> bytes:
    bits = message_bits(text)
    out = bytearray((len(bits) + 7) // 8)
    for i, b in enumerate(bits):
        out[i >> 3] |= b << (7 - (i & 7))
    return bytes(out)


def decode_prefix(bits: list[int]) -> tuple[str, bool, list[int]]:
    """(text so far, whether END was reached, bit index at which each symbol ended)."""
    chunks: list[str] = []
    ends: list[int] = []
    pending = bytearray()
    i = code = length = 0

    def flush() -> None:
        nonlocal pending
        if pending:
            chunks.append(pending.decode("utf-8", errors="replace"))
            pending = bytearray()

    while i < len(bits):
        code = (code << 1) | bits[i]
        length += 1
        i += 1
        sym = BY_CODE.get((length, code))
        if sym is None:
            if length > MAXLEN:
                break
            continue
        code = length = 0
        if sym == "END":
            flush()
            return "".join(chunks), True, ends
        if sym == "ESC":
            if i + 8 > len(bits):
                break
            b = 0
            for k in range(8):
                b = (b << 1) | bits[i + k]
            i += 8
            pending.append(b)
            ends.append(i)
            continue
        flush()
        chunks.append(sym)
        ends.append(i)
    flush()
    return "".join(chunks), False, ends


def decode_message(data: bytes) -> str:
    bits = [(b >> i) & 1 for b in data for i in range(7, -1, -1)]
    return decode_prefix(bits)[0]
