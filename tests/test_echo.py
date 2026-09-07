from rankmark.echo import EchoSlots, build_echo, echo_hash, echo_len, echo_lengths, parse_echo
from rankmark.ecc import bits_to_llrs
from rankmark.framing import tag_of
from rankmark.textcode import encode_message


def test_packet_and_hash():
    payload = encode_message("hello")
    tag = tag_of("Qwen3-1.7B-Q8_0")
    packet = build_echo(payload, tag)
    assert len(packet) == echo_len(len(payload)) == 3 + 32 + 16
    assert echo_hash([]) == 2166136261
    assert echo_hash([1, 2, 3, 4]) != echo_hash([1, 2, 3, 5])
    assert echo_lengths()[0] == 27 and len(echo_lengths()) == 8


def test_votes_decode_and_survive_flips():
    payload = encode_message("hello")
    tag = tag_of("Qwen3-1.7B-Q8_0")
    packet = build_echo(payload, tag)
    n = len(packet)
    ids = [((i * 7919 + 13) % 1000) + 1 for i in range(600)]
    rule = EchoSlots(n)
    slots, stream = [], []
    for i in range(4, len(ids)):
        if ids[i] % 5 != 0:
            j = rule.next(ids[i - 4:i])
            slots.append(j)
            stream.append(packet[j])
    clean = parse_echo(bits_to_llrs(stream), slots, n, tag)
    assert clean.valid and clean.payload == payload and clean.min_votes >= 2
    damaged = [1 - b if (i * 101) % 10 == 0 else b for i, b in enumerate(stream)]
    assert parse_echo(bits_to_llrs(damaged), slots, n, tag).payload == payload
    assert not parse_echo(bits_to_llrs(stream), [j % echo_len(3) for j in slots], echo_len(3), tag).valid
