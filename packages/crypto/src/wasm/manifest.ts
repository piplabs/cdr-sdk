/**
 * Expected SHA-256 hashes for WASM binaries.
 *
 * UPDATE REQUIRED when piplabs/cb-mpc-fork releases a new WASM build:
 *   1. Build new WASM: `cd cb-mpc-fork && bash wasm/build-wasm-module.sh`
 *   2. Copy cb-mpc-tdh2.wasm and cb-mpc-tdh2.js to this directory
 *   3. Compute hash: `shasum -a 256 cb-mpc-tdh2.wasm`
 *   4. Update the hash below
 *   5. Run `pnpm test` to verify initWasm succeeds with the new hash
 */
export const WASM_MANIFEST = {
  "cb-mpc-tdh2.wasm": "8b5698a8b66d1bf2b854430197bab75bf3127b0ea3400401698ac4461018256a",
} as const;
