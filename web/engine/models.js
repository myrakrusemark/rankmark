// Model registry — the light part (no transformers.js), so the main-thread UI
// can import it for the dropdowns without pulling the inference library in.
// dtype int8 (model_int8.onnx) exists in both repos; 8-bit integer weights keep
// the matmuls deterministic across machines.
export const MODELS = {
  gpt2: { repo: "Xenova/gpt2", dtype: "int8", instruct: false },
  "Qwen2.5-0.5B-Instruct": {
    repo: "onnx-community/Qwen2.5-0.5B-Instruct", dtype: "int8", instruct: true,
  },
};
