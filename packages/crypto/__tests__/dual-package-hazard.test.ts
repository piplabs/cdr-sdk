/**
 * Dual-package hazard + concurrent-init regression tests.
 *
 * `@piplabs/cdr-crypto` ships both ESM and CommonJS builds. Two invariants
 * `loader.ts` is responsible for, both verified here against the actual
 * built dist trees:
 *
 * 1. **Singleton visibility across dialects.** When a consumer mixes `import`
 *    and `require()`, Node loads the package twice (one module copy per
 *    format). The WASM instance is hoisted to
 *    `globalThis[Symbol.for("@piplabs/cdr-crypto:wasmInstance")]` so both
 *    copies converge on one CbMpcWasm.
 *
 * 2. **Concurrent init deduplication.** `initWasm()` has multiple awaits
 *    between its early-return guard and the final assignment. Without
 *    deduplication, concurrent callers would each load the WASM. The
 *    in-flight Promise is hoisted to
 *    `globalThis[Symbol.for("@piplabs/cdr-crypto:wasmInitPromise")]` so
 *    concurrent callers — within one dialect or across both — await the
 *    same promise.
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
const wasmInitPromiseKey = Symbol.for("@piplabs/cdr-crypto:wasmInitPromise");

function getInFlightInit(): unknown {
  return (globalThis as unknown as Record<symbol, unknown>)[wasmInitPromiseKey];
}

describe("dual-package hazard", () => {
  beforeAll(() => {
    // Check both entry points AND the WASM assets. A previous version of
    // this guard only checked the entries — running `pnpm test` from inside
    // the crypto package after a `clean` (skipping turbo's build chain)
    // would surface as a deep ENOENT inside verifyWasmHash rather than a
    // clear setup error.
    const required = [
      fileURLToPath(esmEntry),
      fileURLToPath(cjsEntry),
      fileURLToPath(new URL("../dist/esm/wasm/cb-mpc-tdh2.wasm", import.meta.url)),
      fileURLToPath(new URL("../dist/commonjs/wasm/cb-mpc-tdh2.wasm", import.meta.url)),
    ];
    const missing = required.filter((p) => !existsSync(p));
    if (missing.length > 0) {
      throw new Error(
        "Built dist tree incomplete — run `pnpm build` first. Missing:\n" +
        missing.map((p) => `  - ${p}`).join("\n"),
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

  it("concurrent initWasm() calls within one dialect converge to a single instance", async () => {
    const esm = await import(esmEntry.href);
    esm.resetWasm();
    expect(esm.getWasm()).toBeNull();

    // Three concurrent calls — without the WASM_INIT_PROMISE_KEY guard each
    // would pass the early-return check before any reached the final
    // assignment, redundantly loading the WASM. With the guard, all three
    // observe the same in-flight promise and resolve together.
    const first = esm.initWasm();
    const inFlight = getInFlightInit();
    expect(inFlight).toBeInstanceOf(Promise);

    const second = esm.initWasm();
    const third = esm.initWasm();
    expect(getInFlightInit()).toBe(inFlight);

    await Promise.all([first, second, third]);
    expect(getInFlightInit()).toBeUndefined();

    const instance = esm.getWasm();
    expect(instance).not.toBeNull();
    // A follow-up call after the race resolves is a true no-op — same
    // instance, no re-init.
    await esm.initWasm();
    expect(esm.getWasm()).toBe(instance);
  });

  it("concurrent initWasm() across dialects share one in-flight init", async () => {
    const esm = await import(esmEntry.href);
    const require = createRequire(`${here}placeholder`);
    const cjs = require(fileURLToPath(cjsEntry));

    esm.resetWasm();
    cjs.resetWasm();
    expect(esm.getWasm()).toBeNull();
    expect(cjs.getWasm()).toBeNull();

    // Race init across dialects. The promise slot lives on globalThis via
    // Symbol.for, so whichever dialect wins the synchronous race to write
    // the slot, the other's await joins the same promise rather than
    // starting a parallel WASM load.
    const esmInit = esm.initWasm();
    const inFlight = getInFlightInit();
    expect(inFlight).toBeInstanceOf(Promise);

    const cjsInit = cjs.initWasm();
    expect(getInFlightInit()).toBe(inFlight);

    await Promise.all([esmInit, cjsInit]);
    expect(getInFlightInit()).toBeUndefined();

    const fromEsm = esm.getWasm();
    const fromCjs = cjs.getWasm();
    expect(fromEsm).not.toBeNull();
    expect(fromCjs).toBe(fromEsm);
  });
});
