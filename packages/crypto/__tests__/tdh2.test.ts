import { describe, it, expect } from "vitest";
import { tdh2Encrypt, tdh2Combine } from "../src/tdh2.js";
import { WasmNotInitializedError } from "../src/errors.js";

describe("tdh2Encrypt", () => {
  it("throws WasmNotInitializedError when WASM is not loaded", async () => {
    await expect(
      tdh2Encrypt({
        plaintext: new Uint8Array([1, 2, 3]),
        globalPubKey: new Uint8Array(32),
        label: new TextEncoder().encode("test"),
      })
    ).rejects.toThrow(WasmNotInitializedError);
  });
});

describe("tdh2Combine", () => {
  it("throws WasmNotInitializedError when WASM is not loaded", async () => {
    await expect(
      tdh2Combine({
        ciphertext: { raw: new Uint8Array(0), label: new Uint8Array(0) },
        partials: [],
        globalPubKey: new Uint8Array(32),
        label: new TextEncoder().encode("test"),
        threshold: 2,
      })
    ).rejects.toThrow(WasmNotInitializedError);
  });
});
