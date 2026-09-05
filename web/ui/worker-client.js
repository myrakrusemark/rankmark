// Main-thread client for engine/worker.js: one promise per job, events pumped
// to the caller's hooks, cancel and unload as plain commands.

export class EngineClient {
  constructor() {
    this.worker = new Worker(new URL("../engine/worker.js", import.meta.url), { type: "module" });
    this.pending = new Map();
    this.next = 1;
    this.worker.onmessage = ev => {
      const { reqId, kind, data } = ev.data;
      const p = this.pending.get(reqId);
      if (!p) return;
      if (kind === "event") p.onEvent?.(data);
      else if (kind === "progress") p.onProgress?.(data);
      else if (kind === "ready") p.onReady?.(data);
      else if (kind === "done") { this.pending.delete(reqId); p.resolve(data); }
      else if (kind === "cancelled") { this.pending.delete(reqId); p.resolve({ cancelled: true }); }
      else if (kind === "error") { this.pending.delete(reqId); p.reject(new Error(data.message)); }
    };
    this.worker.onerror = e => { for (const p of this.pending.values()) p.reject(new Error(e.message || "worker error")); this.pending.clear(); };
  }
  run(cmd, args = {}, hooks = {}) {
    return new Promise((resolve, reject) => {
      const reqId = this.next++;
      this.pending.set(reqId, { resolve, reject, ...hooks });
      this.worker.postMessage({ reqId, cmd, args });
    });
  }
  cancel() { return this.run("cancel"); }
  unload() { return this.run("unload"); }
  info() { return this.run("info"); }
  get busy() { return [...this.pending.values()].some(p => p.job); }
}
