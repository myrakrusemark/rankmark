// Engine worker: owns the lens (the wllama proxy and its inner worker) so the
// per-step logit math stays off the main thread. One message per request;
// engine events are forwarded back as they happen. cancel and unload are
// handled between steps, because the run loop yields on every await.

import { loadLens, currentLens, unloadLens, Cancelled } from "./lens.js";
import { embed } from "./encoder.js";
import { decode } from "./decoder.js";
import { parseMarkCard, textHash } from "./fingerprint.js";

async function ensureLens(args, reqId) {
  const lens = await loadLens(args.rung, {
    threads: args.threads,
    viaBlob: !!args.viaBlob,
    onProgress: p => self.postMessage({ reqId, kind: "progress", data: p }),
  });
  self.postMessage({ reqId, kind: "ready", data: info(lens) });
  return lens;
}

function info(lens) {
  return lens ? {
    model: lens.name, fingerprint: lens.fp, threads: lens.threads,
    cache: lens.cache, weightsSha256: lens.weightsSha256,
    nVocab: lens.nVocab, nCtx: lens.nCtx, eog: [...lens.eogIds], addBos: lens.addBos,
  } : null;
}

self.onmessage = async ev => {
  const { reqId, cmd, args = {} } = ev.data;
  const emit = e => self.postMessage({ reqId, kind: "event", data: e });
  const done = data => self.postMessage({ reqId, kind: "done", data });
  try {
    if (cmd === "cancel") {
      currentLens()?.cancel();
      return done({});
    }
    if (cmd === "unload") {
      await unloadLens();
      return done({});
    }
    if (cmd === "info") return done(info(currentLens()));
    if (cmd === "logitHash") {
      // hash of the logit row after the prompt, for cross-machine comparison
      const lens = await ensureLens(args, reqId);
      const ids = await lens.completionContext(args.prompt);
      const logits = await lens.step(ids, true);
      const digest = await crypto.subtle.digest("SHA-256", logits.buffer.slice(logits.byteOffset, logits.byteOffset + logits.byteLength));
      const hash = [...new Uint8Array(digest)].slice(0, 8).map(b => b.toString(16).padStart(2, "0")).join("");
      return done({ hash, tokens: ids.length, fingerprint: lens.fp, threads: lens.threads });
    }
    if (cmd === "load") {
      await ensureLens(args, reqId);
      return done(info(currentLens()));
    }
    if (cmd === "embed") {
      const lens = await ensureLens(args, reqId);
      const result = await embed(lens, args.opts, emit);
      return done(result);
    }
    if (cmd === "decode") {
      const lens = await ensureLens(args, reqId);
      // a pasted mark card names its lens and hashes the written text; strip
      // the footer before tokenizing, and say "altered" when the hash differs
      const card = parseMarkCard(args.text);
      const text = card ? card.text : args.text;
      const altered = card?.textHash ? (await textHash(text)) !== card.textHash : null;
      const fpMismatch = card ? card.fp !== lens.fp : null;
      if (altered || fpMismatch) emit({ type: "notice", altered, fpMismatch, cardLens: card.rungId });
      const result = await decode(lens, text, args.opts, emit);
      return done({ ...result, card, altered, fpMismatch });
    }
    throw new Error(`unknown command ${cmd}`);
  } catch (err) {
    const cancelled = err instanceof Cancelled;
    self.postMessage({ reqId, kind: cancelled ? "cancelled" : "error", data: { message: String(err && err.message || err) } });
  }
};
