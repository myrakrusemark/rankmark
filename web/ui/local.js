// Run it locally: the same code on your own machine, for models bigger than
// a browser will hold, and a field that checks whether a local server answers.

export function initLocal(root) {
  const q = s => root.querySelector(s);
  q("[data-check]").addEventListener("click", async () => {
    const url = q("[data-url]").value.trim().replace(/\/$/, "");
    const out = q("[data-local-out]");
    out.textContent = "checking";
    try {
      const res = await fetch(`${url}/api/models`, { mode: "cors" });
      const d = await res.json();
      out.textContent = `answering. models: ${(d.models || []).join(", ") || "none listed"}`;
    } catch (err) {
      out.textContent = `no answer at ${url}: ${err.message}`;
    }
  });
}
