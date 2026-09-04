"""Emit reference vectors from the Python channel/framing stack as JSON.

The JS port must reproduce every one of these bit-for-bit.
"""
import json
import random

from rankmark.channel import crc16
from rankmark.ecc import (
    conv_encode, deinterleave, interleave, rs_decode, rs_encode, viterbi_decode,
)
from rankmark.framing import (
    PROFILES, build_frame, frame_len_bits, parse_frames_soft, tag_of,
)
from rankmark.framing import _checksum  # noqa: intentional — verifying internals
from rankmark.ecc import bits_to_llrs

rng = random.Random(1234)
V = {}

# crc16 / crc32 / tag
import zlib
V["crc"] = [
    {"data": list(b"hello"), "crc16": crc16(b"hello"), "crc32": zlib.crc32(b"hello")},
    {"data": list(b"rankmark v2"), "crc16": crc16(b"rankmark v2"), "crc32": zlib.crc32(b"rankmark v2")},
    {"data": list(bytes(range(20))), "crc16": crc16(bytes(range(20))), "crc32": zlib.crc32(bytes(range(20)))},
]
V["tag"] = {name: tag_of(name) for name in ["gpt2", "Qwen/Qwen2.5-0.5B-Instruct", "Qwen/Qwen2.5-3B"]}

# RS encode + correct-under-noise round trips for each nsym used
V["rs"] = []
for nsym in (2, 4, 8):
    for _ in range(6):
        data = bytes(rng.randrange(256) for _ in range(rng.randint(1, 12)))
        enc = rs_encode(data, nsym)
        # corrupt up to nsym//2 symbols (RS correction limit)
        corr = bytearray(enc)
        nerr = rng.randint(0, nsym // 2)
        for pos in rng.sample(range(len(corr)), nerr):
            corr[pos] ^= rng.randint(1, 255)
        dec = rs_decode(bytes(corr), nsym)
        V["rs"].append({
            "nsym": nsym, "data": list(data), "encoded": list(enc),
            "corrupted": list(corr), "nerr": nerr,
            "decoded": list(dec) if dec is not None else None,
        })

# interleave round trips
V["interleave"] = []
for depth in (1, 4, 8):
    data = bytes(rng.randrange(256) for _ in range(rng.randint(5, 30)))
    il = interleave(data, depth)
    V["interleave"].append({
        "depth": depth, "data": list(data), "interleaved": list(il),
        "roundtrip": list(deinterleave(il, depth)),
    })

# conv encode + viterbi round trip
V["conv"] = []
for _ in range(5):
    n = rng.randint(8, 40)
    bits = [rng.randint(0, 1) for _ in range(n)]
    coded = conv_encode(bits)
    llrs = bits_to_llrs(coded)
    dec = viterbi_decode(llrs, n)
    V["conv"].append({"bits": bits, "coded": coded, "decoded": dec})

# full frame build for every profile + a clean parse round trip
V["frame"] = []
for pid, p in PROFILES.items():
    for payload in [b"\xa7", b"hi", b"meet me at noon"]:
        if not (1 <= len(payload) <= 63):
            continue
        tag = tag_of("gpt2")
        frame = build_frame(payload, pid, tag)
        llrs = bits_to_llrs(frame)
        parsed = parse_frames_soft(llrs, tag)
        V["frame"].append({
            "profile": pid, "payload": list(payload), "tag": tag,
            "frame": frame, "frame_len_bits": frame_len_bits(len(payload), pid),
            "parsed": [{"offset": f.offset, "payload": list(f.payload),
                        "profile": f.profile, "tag": f.tag} for f in parsed],
        })

# a repeated stream with a wrong-tag scan (should not validate under other tag)
tag_gpt2 = tag_of("gpt2")
frame = build_frame(b"\x2a", 0, tag_gpt2)
stream = frame * 3
V["repeat"] = {
    "profile": 0, "payload": [0x2a], "tag": tag_gpt2,
    "stream": bits_to_llrs(stream),
    "parsed_right": [{"offset": f.offset, "payload": list(f.payload)}
                     for f in parse_frames_soft(bits_to_llrs(stream), tag_gpt2)],
    "parsed_wrong_tag": [{"offset": f.offset} for f in parse_frames_soft(bits_to_llrs(stream), (tag_gpt2 + 1) & 7)],
}

print(json.dumps(V))
