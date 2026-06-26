/**
 * CJS polyfill for `wasm-paths.ts`. tshy substitutes this in the CommonJS build
 * because the ESM version uses `import.meta.url`, which is a syntax error in CJS.
 */
// @ts-ignore — `node:url` and `node:path` and `__dirname` are CJS-context globals
import { pathToFileURL } from "node:url";
// @ts-ignore
import { join } from "node:path";

// @ts-ignore — __dirname only exists in the CJS module scope
const here: string = __dirname;

export const wasmBinaryUrl = pathToFileURL(join(here, "cb-mpc-tdh2.wasm"));
export const wasmShimSpecifier = pathToFileURL(join(here, "cb-mpc-tdh2.mjs")).href;
