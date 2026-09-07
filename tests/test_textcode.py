from rankmark.textcode import decode_message, decode_prefix, encode_message, message_bits


def test_round_trips():
    for t in ["hello", "hi there", "Meet me at 9.", "THE QUICK BROWN FOX", "Ünïcode ✓", "", "x" * 40]:
        assert decode_message(encode_message(t)) == t


def test_shorter_than_utf8_for_english():
    assert len(encode_message("hello")) < len("hello".encode())
    assert len(encode_message("the quick brown fox jumps over")) < 30


def test_prefix_decodes_whole_symbols_only():
    bits = message_bits("hello")
    text, done, ends = decode_prefix(bits[:12])
    assert text == "he" and not done and ends == [5, 9]
    text, done, _ = decode_prefix(bits)
    assert text == "hello" and done
