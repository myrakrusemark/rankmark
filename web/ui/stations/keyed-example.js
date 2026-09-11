// A small, explicitly illustrative keyed choice channel, not payload encryption.
const encoder = new TextEncoder();
export const choices = [
  ['The ', ['last', 'final']], [' boat ', ['reached', 'entered']],
  [' the harbor as the sky ', ['darkened', 'dimmed']], ['. A ', ['tired', 'weary']],
  [' sailor ', ['stepped', 'climbed']], [' onto the ', ['quiet', 'silent']],
  [' dock. She ', ['noticed', 'spotted']], [' a ', ['small', 'little']],
  [' lantern beside the ', ['old', 'weathered']], [' gate. Its light ', ['flickered', 'shimmered']],
  [' as she ', ['walked', 'headed']], [' toward the ', ['sleeping', 'slumbering']],
];
const ending = ' town.';
async function keyFor(passphrase) {
  if (!passphrase) throw new Error('Enter an example passphrase.');
  return crypto.subtle.importKey('raw', encoder.encode(passphrase), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
}
async function preferred(key, context) {
  const signature = await crypto.subtle.sign('HMAC', key, encoder.encode('rankmark-choice-illustration-v1:' + context));
  return new Uint8Array(signature)[0] & 1;
}
export async function writeExample(passphrase) {
  const key = await keyFor(passphrase);
  let context = '';
  const selected = [];
  for (const [prefix, words] of choices) {
    context += prefix;
    const pick = await preferred(key, context);
    selected.push(pick);
    context += words[pick];
  }
  return { selected, text: context + ending };
}
export async function checkExample(passphrase, selected) {
  const key = await keyFor(passphrase);
  let context = '';
  const matches = [];
  for (let i = 0; i < choices.length; i++) {
    const [prefix, words] = choices[i];
    context += prefix;
    matches.push(await preferred(key, context) === selected[i]);
    context += words[selected[i]];
  }
  return matches;
}
export function initKeyedExample(root) {
  const q = s => root.querySelector(s);
  let passage = null;
  let revision = 0;
  const output = q('[data-key-text]');
  const status = q('[data-key-status]');
  function render(matches) {
    output.replaceChildren();
    choices.forEach(([prefix, words], i) => {
      output.append(document.createTextNode(prefix));
      const word = document.createElement('span');
      word.textContent = words[passage.selected[i]];
      word.className = matches ? (matches[i] ? 'key-match' : 'key-miss') : 'key-word';
      word.title = matches ? (matches[i] ? 'Favored by the reader’s key' : 'Not favored by the reader’s key') : 'A choice made using the writer’s key';
      output.append(word);
    });
    output.append(document.createTextNode(ending));
  }
  async function write() {
    const version = ++revision;
    try {
      const result = await writeExample(q('[data-writer-key]').value);
      if (version !== revision) return;
      passage = result; render();
      status.textContent = 'Twelve word choices carry the pattern. Now check them with the reader’s passphrase.';
      q('[data-check-key]').disabled = false;
    } catch (e) { if (version === revision) status.textContent = e.message; }
  }
  async function check() {
    if (!passage) return;
    const version = ++revision;
    const key = q('[data-reader-key]').value;
    try {
      const matches = await checkExample(key, passage.selected);
      if (version !== revision) return;
      render(matches);
      const count = matches.filter(Boolean).length;
      status.textContent = `${count} of 12 choices match this reader’s key. ${count === 12 ? 'Every choice follows its pattern.' : 'Underlined words match; crossed-out words do not.'} This is a pattern score, not proof of authorship.`;
    } catch (e) { if (version === revision) status.textContent = e.message; }
  }
  q('[data-write-key]').addEventListener('click', write);
  q('[data-check-key]').addEventListener('click', check);
  for (const selector of ['[data-writer-key]', '[data-reader-key]']) q(selector).addEventListener('input', () => {
    revision++;
    if (passage) render();
    status.textContent = selector.includes('writer') ? 'Press Make the choices to use the changed writer passphrase.' : 'Press Check the pattern to use the changed reader passphrase.';
  });
}
if (typeof document !== 'undefined') {
  const root = document.querySelector('#keyed-example');
  if (root) initKeyedExample(root);
}
