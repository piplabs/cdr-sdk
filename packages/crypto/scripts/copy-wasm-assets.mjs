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

for (const target of targets) {
  if (!existsSync(target)) mkdirSync(target, { recursive: true });
  for (const asset of assets) {
    cpSync(join(src, asset), join(target, asset));
  }
}
