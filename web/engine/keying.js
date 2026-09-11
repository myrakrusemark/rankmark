// Experimental context-keyed parity. This changes the carrier mapping, not
// payload confidentiality or authentication. The passphrase never enters a footer.
const utf8 = new TextEncoder();
export async function keyFor(passphrase = '') {
  if (!passphrase) return null;
  const material = await crypto.subtle.importKey('raw', utf8.encode(passphrase), 'PBKDF2', false, ['deriveKey']);
  return crypto.subtle.deriveKey({ name: 'PBKDF2', hash: 'SHA-256', iterations: 210000,
    salt: utf8.encode('rankmark-context-key-v1') }, material,
    { name: 'HMAC', hash: 'SHA-256', length: 256 }, false, ['sign']);
}
export async function keyBit(key, history) {
  if (!key) return 0;
  const context = utf8.encode('rankmark-parity-v1:' + history.slice(-8).join(','));
  return new Uint8Array(await crypto.subtle.sign('HMAC', key, context))[0] & 1;
}
