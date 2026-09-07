// A fixed code for short messages: a static Huffman table over English letters,
// space, digits and common punctuation, an escape for any other byte, and an
// end mark. Both sides carry the same table, so no flag is needed. Messages
// come out about a third shorter than UTF-8, which buys copies of the frame.
// Mirrors textcode.py; the code must stay bit-exact with it.

// [symbol, code length] in canonical order: codes are assigned in this order
const TABLE = [[" ", 3], ["a", 4], ["e", 4], ["i", 4], ["n", 4], ["o", 4], ["s", 4], ["t", 4], ["d", 5], ["h", 5], ["l", 5], ["r", 5], ["END", 6], [",", 6], [".", 6], ["c", 6], ["f", 6], ["g", 6], ["m", 6], ["p", 6], ["u", 6], ["w", 6], ["y", 6], ["'", 7], ["E", 7], ["b", 7], ["k", 7], ["v", 7], ["!", 8], ["-", 8], ["?", 8], ["A", 8], ["H", 8], ["I", 8], ["N", 8], ["O", 8], ["R", 8], ["S", 8], ["T", 8], ["\n", 9], ["\"", 9], ["0", 9], ["1", 9], ["2", 9], ["3", 9], ["4", 9], ["5", 9], ["6", 9], ["7", 9], ["8", 9], ["9", 9], [":", 9], ["C", 9], ["D", 9], ["L", 9], ["U", 9], ["W", 9], ["j", 9], ["x", 9], ["(", 10], [")", 10], ["/", 10], [";", 10], ["B", 10], ["F", 10], ["G", 10], ["M", 10], ["P", 10], ["Y", 10], ["q", 10], ["z", 10], ["ESC", 11], ["#", 11], ["$", 11], ["%", 11], ["&", 11], ["*", 11], ["+", 11], ["=", 11], ["@", 11], ["J", 11], ["K", 11], ["Q", 11], ["V", 11], ["X", 11], ["Z", 11], ["_", 11]];
const CODES = new Map();
const BY_CODE = new Map();   // "length:value" -> symbol
{
  let code = 0, len = 0;
  for (const [sym, l] of TABLE) {
    code <<= (l - len); len = l;
    CODES.set(sym, [code, l]);
    BY_CODE.set(`${l}:${code}`, sym);
    code++;
  }
}
const MAXLEN = TABLE[TABLE.length - 1][1];
const utf8 = new TextEncoder();
const utf8d = new TextDecoder();

// the message as bits, escaped bytes for anything outside the table, then END
export function messageBits(text) {
  const bits = [];
  const push = (code, l) => { for (let i = l - 1; i >= 0; i--) bits.push((code >> i) & 1); };
  for (const ch of text) {
    if (CODES.has(ch)) { const [c, l] = CODES.get(ch); push(c, l); continue; }
    for (const b of utf8.encode(ch)) { const [c, l] = CODES.get("ESC"); push(c, l); push(b, 8); }
  }
  const [c, l] = CODES.get("END");
  push(c, l);
  return bits;
}

export function encodeMessage(text) {
  const bits = messageBits(text);
  const out = new Uint8Array(Math.ceil(bits.length / 8));
  bits.forEach((b, i) => { out[i >> 3] |= b << (7 - (i & 7)); });
  return out;
}

// decode as far as the bits go: the text so far, whether END was reached, and
// the bit at which each symbol (letters and escaped bytes) ended
export function decodePrefix(bits) {
  const chunks = [];   // utf8 byte runs and characters, in order
  const ends = [];
  let i = 0, code = 0, len = 0, pendingBytes = [];
  const flush = () => { if (pendingBytes.length) { chunks.push(utf8d.decode(Uint8Array.from(pendingBytes))); pendingBytes = []; } };
  while (i < bits.length) {
    code = (code << 1) | bits[i]; len++; i++;
    const sym = BY_CODE.get(`${len}:${code}`);
    if (sym === undefined) { if (len > MAXLEN) break; continue; }
    code = 0; len = 0;
    if (sym === "END") { flush(); return { text: chunks.join(""), done: true, ends }; }
    if (sym === "ESC") {
      if (i + 8 > bits.length) break;
      let b = 0; for (let k = 0; k < 8; k++) b = (b << 1) | bits[i + k];
      i += 8; pendingBytes.push(b); ends.push(i); continue;
    }
    flush(); chunks.push(sym); ends.push(i);
  }
  flush();
  return { text: chunks.join(""), done: false, ends };
}

export function decodeMessage(bytes) {
  const bits = [];
  for (const b of bytes) for (let i = 7; i >= 0; i--) bits.push((b >> i) & 1);
  return decodePrefix(bits).text;
}

export function decodeHexMessage(hex) {
  if (!hex) return "";
  return decodeMessage(Uint8Array.from(hex.match(/../g).map(h => parseInt(h, 16))));
}
