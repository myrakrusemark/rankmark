// Assemble the static site into dist/ and deploy it to Cloudflare Pages.
//
//   node scripts/deploy.mjs            # build dist/ and deploy
//   node scripts/deploy.mjs --dry      # build dist/ only
//
// Needs: wrangler logged in (npx wrangler whoami) with pages:write, and the
// engine fetched (scripts/fetch-engine.mjs runs first).

import { cpSync, mkdirSync, rmSync, existsSync, readdirSync, statSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { execSync } from "node:child_process";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const web = join(root, "web");
const dist = join(web, "dist");
const PROJECT = process.env.PAGES_PROJECT || "watermark";
const dry = process.argv.includes("--dry");

execSync(`node ${join(root, "scripts/fetch-engine.mjs")}`, { stdio: "inherit" });

rmSync(dist, { recursive: true, force: true });
mkdirSync(dist, { recursive: true });
for (const entry of ["index.html", "_headers", "styles", "ui", "engine", "data", "vendor"]) {
  const src = join(web, entry);
  if (!existsSync(src)) throw new Error(`missing ${entry}`);
  cpSync(src, join(dist, entry), { recursive: true });
}
// the engine registry ships; the spike and CI harnesses do not
const size = dir => readdirSync(dir).reduce((s, f) => { const p = join(dir, f); const st = statSync(p); return s + (st.isDirectory() ? size(p) : st.size); }, 0);
console.log(`dist/ ready: ${(size(dist) / 1e6).toFixed(1)} MB`);

if (dry) process.exit(0);
execSync(`npx wrangler pages deploy "${dist}" --project-name ${PROJECT} --branch main --commit-dirty=true`, { stdio: "inherit", cwd: root });
