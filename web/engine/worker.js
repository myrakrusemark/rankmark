// Inference worker: keeps the heavy transformers.js wasm off the main thread so
// the UI stays responsive and tokens stream in live. One message per request;
// engine events are forwarded back as they happen.

import { loadLens } from "./lens.js";
import { embed } from "./encoder.js";
import { decode } from "./decoder.js";

async function getLens(name, reqId) {
  return loadLens(name, p => self.postMessage({ reqId, kind: "progress", data: p }));
}

self.onmessage = async ev => {
  const { reqId, cmd, args } = ev.data;
  const emit = e => self.postMessage({ reqId, kind: "event", data: e });
  try {
    const lens = await getLens(args.model, reqId);
    self.postMessage({ reqId, kind: "ready", data: { model: args.model } });
    if (cmd === "embed") {
      await embed(lens, args.opts, emit);
      self.postMessage({ reqId, kind: "done", data: {} });
    } else if (cmd === "decode") {
      const result = await decode(lens, args.text, args.opts, emit);
      self.postMessage({ reqId, kind: "done", data: result });
    }
  } catch (err) {
    self.postMessage({ reqId, kind: "error", data: { message: String(err && err.message || err) } });
  }
};
