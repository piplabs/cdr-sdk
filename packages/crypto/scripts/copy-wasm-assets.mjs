#!/usr/bin/env node
/**
 * Copy the Emscripten shim and the WASM binary into both tshy dist trees.
 * tshy compiles TypeScript but does not relocate non-TS assets, and the
 * `loader.ts` polyfills (`wasm-paths.ts` / `wasm-paths-cjs.cts`) expect the
 * assets to sit next to the compiled loader in each dialect.
 */
import { cpSync, existsSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const pkgRoot = join(here, "..");
const src = join(pkgRoot, "src/wasm");
const targets = [
  join(pkgRoot, "dist/esm/wasm"),
  join(pkgRoot, "dist/commonjs/wasm"),
];
const assets = ["cb-mpc-tdh2.mjs", "cb-mpc-tdh2.wasm"];

// Preflight: validate every source asset before any copy. cpSync's native
// ENOENT is technically a real error but doesn't make it clear that this is
// the WASM copy step or what the developer should do next.
const missing = assets.filter((asset) => !existsSync(join(src, asset)));
if (missing.length > 0) {
  console.error("copy-wasm-assets: missing source asset(s) in packages/crypto/src/wasm/:");
  for (const m of missing) console.error(`  - ${m}`);
  console.error("");
  console.error("Expected the Emscripten shim (cb-mpc-tdh2.mjs) and WASM binary");
  console.error("(cb-mpc-tdh2.wasm) alongside loader.ts. Restore from git or rebuild");
  console.error("the WASM toolchain — `pnpm build` cannot complete without them.");
  process.exit(1);
}

for (const target of targets) {
  if (!existsSync(target)) mkdirSync(target, { recursive: true });
  for (const asset of assets) {
    cpSync(join(src, asset), join(target, asset));
  }
}
