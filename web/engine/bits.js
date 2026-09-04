// Bit/byte/CRC helpers — port of channel.py's shared helpers plus the CRC32
// framing.py takes from zlib. Pure integer logic: exact in every JS engine.

export function crc16(data) { // CRC-16/CCITT-FALSE over a Uint8Array
  let crc = 0xffff;
  for (const byte of data) {
    crc ^= byte << 8;
    for (let i = 0; i < 8; i++) {
      crc = crc & 0x8000 ? ((crc << 1) ^ 0x1021) & 0xffff : (crc << 1) & 0xffff;
    }
  }
  return crc;
}

// standard CRC-32 (IEEE 802.3, reflected) — matches Python's zlib.crc32
const CRC32_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

export function crc32(data) {
  let c = 0xffffffff;
  for (const byte of data) c = CRC32_TABLE[(c ^ byte) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

export function intToBits(value, width) {
  const out = new Array(width);
  for (let i = 0; i < width; i++) out[i] = (value >>> (width - 1 - i)) & 1;
  return out;
}

export function bitsToInt(bits) {
  let v = 0;
  for (const b of bits) v = (v << 1) | b;
  return v >>> 0;
}

export function bytesToBits(data) {
  const out = [];
  for (const byte of data) for (let i = 7; i >= 0; i--) out.push((byte >>> i) & 1);
  return out;
}

export function bitsToBytes(bits) {
  const out = new Uint8Array(bits.length >> 3);
  for (let i = 0; i < out.length; i++) {
    let v = 0;
    for (let j = 0; j < 8; j++) v = (v << 1) | bits[i * 8 + j];
    out[i] = v;
  }
  return out;
}

export function concatBytes(...parts) {
  const total = parts.reduce((n, p) => n + p.length, 0);
  const out = new Uint8Array(total);
  let at = 0;
  for (const p of parts) { out.set(p, at); at += p.length; }
  return out;
}

export function bytesEqual(a, b) {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}

export const hexToBytes = hex =>
  new Uint8Array((hex.match(/../g) || []).map(h => parseInt(h, 16)));

export const bytesToHex = bytes =>
  [...bytes].map(b => b.toString(16).padStart(2, "0")).join("");
