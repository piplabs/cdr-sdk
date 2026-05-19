/**
 * Dual-package hazard regression test.
 *
 * `@piplabs/cdr-crypto` ships both ESM and CommonJS builds. When a consumer
 * mixes `import` and `require()` in one process, Node loads the package twice
 * — once per format — yielding two separate module copies. Without a shared
 * singleton, `initWasm()` on one side would leave `getWasm()` returning null
 * on the other.
 *
 * `loader.ts` mitigates this by hoisting the WASM instance to
 * `globalThis[Symbol.for("@piplabs/cdr-crypto:wasmInstance")]`. This test
 * guards that invariant: loading the built ESM and CommonJS dists and asserting
 * that a single `initWasm()` call is visible from both sides.
 *
 * Requires `pnpm build` to have run (turbo's test task depends on build).
 */
import { describe, it, expect, beforeAll } from "vitest";
import { createRequire } from "node:module";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";

const here = fileURLToPath(new URL(".", import.meta.url));
const esmEntry = new URL("../dist/esm/index.js", import.meta.url);
const cjsEntry = new URL("../dist/commonjs/index.js", import.meta.url);

describe("dual-package hazard", () => {
  beforeAll(() => {
    if (!existsSync(fileURLToPath(esmEntry)) || !existsSync(fileURLToPath(cjsEntry))) {
      throw new Error(
        "Built dist trees missing — run `pnpm build` first. " +
        "(turbo's test task should chain build, so this is unexpected in CI.)",
      );
    }
  });

  it("ESM and CJS load as separate module copies", async () => {
    const esm = await import(esmEntry.href);
    const require = createRequire(`${here}placeholder`);
    const cjs = require(fileURLToPath(cjsEntry));
    expect(esm.initWasm).toBeTypeOf("function");
    expect(cjs.initWasm).toBeTypeOf("function");
    // Different module objects — confirms the hazard surface exists.
    expect(esm.initWasm).not.toBe(cjs.initWasm);
  });

  it("initWasm() from one dialect is visible to getWasm() in the other", async () => {
    const esm = await import(esmEntry.href);
    const require = createRequire(`${here}placeholder`);
    const cjs = require(fileURLToPath(cjsEntry));

    // Reset both sides so this test is independent of order.
    esm.resetWasm();
    cjs.resetWasm();
    expect(esm.getWasm()).toBeNull();
    expect(cjs.getWasm()).toBeNull();

    // Initialize via ESM only.
    await esm.initWasm();

    const fromEsm = esm.getWasm();
    const fromCjs = cjs.getWasm();
    expect(fromEsm).not.toBeNull();
    expect(fromCjs).not.toBeNull();
    // Same instance — confirms the globalThis singleton bridges both copies.
    expect(fromEsm).toBe(fromCjs);
  });

  it("initWasm() from CJS is visible to ESM", async () => {
    const esm = await import(esmEntry.href);
    const require = createRequire(`${here}placeholder`);
    const cjs = require(fileURLToPath(cjsEntry));

    esm.resetWasm();
    cjs.resetWasm();

    await cjs.initWasm();
    expect(esm.getWasm()).toBe(cjs.getWasm());
    expect(esm.getWasm()).not.toBeNull();
  });
});
