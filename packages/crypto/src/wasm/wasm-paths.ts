/**
 * ESM build resolves WASM asset paths via `import.meta.url`. The CJS build
 * uses the sibling `wasm-paths-cjs.cts` polyfill (selected automatically by
 * tshy), which uses `__dirname` because `import.meta` is a syntax error in CJS.
 * `@ts-ignore` is required because TypeScript still type-checks this file
 * against the CommonJS dialect before the polyfill substitution runs.
 */
// @ts-ignore — import.meta only legal in the ESM build
export const wasmBinaryUrl: URL = new URL("cb-mpc-tdh2.wasm", import.meta.url);
// @ts-ignore
export const wasmShimSpecifier: string = new URL("cb-mpc-tdh2.mjs", import.meta.url).href;
