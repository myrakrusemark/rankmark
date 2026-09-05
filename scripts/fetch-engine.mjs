// Fetch the engine build the registry pins from the wllama fork's GitHub
// release, into web/vendor/, and verify every file's sha256.
//
//   node scripts/fetch-engine.mjs

import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const reg = JSON.parse(readFileSync(join(root, "web/engine/registry.json"), "utf8"));
const { repo, commit, assets } = reg.engine;
if (!assets) throw new Error("registry.engine.assets is missing");
const base = `${repo}/releases/download/engine-${commit}`;

const sha256 = buf => createHash("sha256").update(buf).digest("hex");

for (const [asset, { path, sha256: want }] of Object.entries(assets)) {
  const dest = join(root, "web/vendor", path);
  if (existsSync(dest) && sha256(readFileSync(dest)) === want) {
    console.log(`ok       ${path}`);
    continue;
  }
  const url = `${base}/${asset}`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`${url}: HTTP ${res.status}`);
  const buf = Buffer.from(await res.arrayBuffer());
  const got = sha256(buf);
  if (got !== want) throw new Error(`${asset}: sha256 ${got}, registry says ${want}`);
  mkdirSync(dirname(dest), { recursive: true });
  writeFileSync(dest, buf);
  console.log(`fetched  ${path}  ${(buf.length / 1e6).toFixed(1)} MB`);
}
