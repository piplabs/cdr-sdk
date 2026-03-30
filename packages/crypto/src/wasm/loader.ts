/**
 * TypeScript loader for the cb-mpc TDH2 WASM module.
 *
 * Usage:
 *   import { initWasm, getWasm } from "./loader.js";
 *   await initWasm();
 *   const wasm = getWasm();
 *   const raw = wasm.tdh2Encrypt(globalPubKey, plaintext, label);
 */

import createCbMpcModule from "./cb-mpc-tdh2.js";

/** Opaque WASM module instance */
interface EmscriptenModule {
  _malloc(size: number): number;
  _free(ptr: number): void;
  _wasm_tdh2_pub_key_from_point(data: number, size: number, outHandle: number): number;
  _wasm_tdh2_free_pub_key(handle: number): void;
  _wasm_tdh2_encrypt(
    handle: number,
    plainPtr: number, plainSize: number,
    labelPtr: number, labelSize: number,
    outPtrPtr: number, outSizePtr: number,
  ): number;
  _wasm_tdh2_verify(
    handle: number,
    ctPtr: number, ctSize: number,
    labelPtr: number, labelSize: number,
  ): number;
  _wasm_ac_new_node(nodeType: number, namePtr: number, nameSize: number, threshold: number): number;
  _wasm_ac_add_child(parent: number, child: number): void;
  _wasm_ac_new(root: number, curveCode: number): number;
  _wasm_ac_free(handle: number): void;
  _wasm_tdh2_combine(
    acHandle: number, pubKeyHandle: number, n: number,
    namesData: number, namesSizes: number,
    pubSharesData: number, pubSharesSizes: number,
    ctData: number, ctSize: number,
    labelData: number, labelSize: number,
    partialsData: number, partialsSizes: number,
    outPtrPtr: number, outSizePtr: number,
  ): number;
  _wasm_ptr_size(): number;
  HEAPU8: Uint8Array;
  HEAP32: Int32Array;
  getValue(ptr: number, type: string): number;
  setValue(ptr: number, value: number, type: string): void;
}

/** Ed25519 curve code in cb-mpc (NID_ED25519 = 0x043f = 1087) */
export const CURVE_ED25519 = 1087;

/**
 * High-level wrapper around the cb-mpc TDH2 WASM module.
 * Exposed as CbMpcWasm for consumers that need the type.
 */
export class CbMpcWasm {
  private M: EmscriptenModule;

  constructor(module: EmscriptenModule) {
    this.M = module;
  }

  /**
   * Encrypt plaintext to a TDH2 public key.
   *
   * @param globalPubKey  Serialized EC point (curve-code prefixed) — the DKG global public key
   * @param plaintext     Data to encrypt
   * @param label         Associated data label
   * @returns Serialized TDH2 ciphertext bytes
   */
  tdh2Encrypt(globalPubKey: Uint8Array, plaintext: Uint8Array, label: Uint8Array): Uint8Array {
    const M = this.M;

    const pointPtr = this.allocBytes(globalPubKey);
    const handlePtr = M._malloc(4);
    try {
      let rv = M._wasm_tdh2_pub_key_from_point(pointPtr, globalPubKey.length, handlePtr);
      if (rv !== 0) throw new Error(`wasm_tdh2_pub_key_from_point failed: ${rv}`);
      const pkHandle = M.getValue(handlePtr, "i32");

      const plainPtr = this.allocBytes(plaintext);
      const labelPtr = this.allocBytes(label);
      const outPtrPtr = M._malloc(4);
      const outSizePtr = M._malloc(4);
      try {
        rv = M._wasm_tdh2_encrypt(
          pkHandle,
          plainPtr, plaintext.length,
          labelPtr, label.length,
          outPtrPtr, outSizePtr,
        );
        if (rv !== 0) throw new Error(`wasm_tdh2_encrypt failed: ${rv}`);
        return this.readResult(outPtrPtr, outSizePtr);
      } finally {
        M._free(plainPtr);
        M._free(labelPtr);
        M._free(outPtrPtr);
        M._free(outSizePtr);
        M._wasm_tdh2_free_pub_key(pkHandle);
      }
    } finally {
      M._free(pointPtr);
      M._free(handlePtr);
    }
  }

  /**
   * Verify a TDH2 ciphertext against a public key and label.
   */
  tdh2Verify(globalPubKey: Uint8Array, ciphertext: Uint8Array, label: Uint8Array): boolean {
    const M = this.M;

    const pointPtr = this.allocBytes(globalPubKey);
    const handlePtr = M._malloc(4);
    try {
      let rv = M._wasm_tdh2_pub_key_from_point(pointPtr, globalPubKey.length, handlePtr);
      if (rv !== 0) throw new Error(`wasm_tdh2_pub_key_from_point failed: ${rv}`);
      const pkHandle = M.getValue(handlePtr, "i32");

      const ctPtr = this.allocBytes(ciphertext);
      const labelPtr = this.allocBytes(label);
      try {
        rv = M._wasm_tdh2_verify(pkHandle, ctPtr, ciphertext.length, labelPtr, label.length);
        return rv === 0;
      } finally {
        M._free(ctPtr);
        M._free(labelPtr);
        M._wasm_tdh2_free_pub_key(pkHandle);
      }
    } finally {
      M._free(pointPtr);
      M._free(handlePtr);
    }
  }

  tdh2Combine(
    names: string[],
    pubShares: Uint8Array[],
    partials: Uint8Array[],
    globalPubKey: Uint8Array,
    ciphertext: Uint8Array,
    label: Uint8Array,
    threshold: number,
  ): Uint8Array {
    const M = this.M;
    const n = partials.length;
    const encoder = new TextEncoder();

    const namesBufs = names.map((name) => encoder.encode(name));

    // Create public key
    const pointPtr = this.allocBytes(globalPubKey);
    const handlePtr = M._malloc(4);
    let rv = M._wasm_tdh2_pub_key_from_point(pointPtr, globalPubKey.length, handlePtr);
    if (rv !== 0) {
      M._free(pointPtr);
      M._free(handlePtr);
      throw new Error(`wasm_tdh2_pub_key_from_point failed: ${rv}`);
    }
    const pkHandle = M.getValue(handlePtr, "i32");
    M._free(pointPtr);
    M._free(handlePtr);

    // Build access structure: threshold gate with n leaf children
    // node_e enum: NONE=0, LEAF=1, AND=2, OR=3, THRESHOLD=4
    const NODE_LEAF = 1;
    const NODE_THRESHOLD = 4;
    const rootNameBytes = encoder.encode("root");
    const rootNamePtr = this.allocBytes(rootNameBytes);
    const rootHandle = M._wasm_ac_new_node(NODE_THRESHOLD, rootNamePtr, rootNameBytes.length, threshold);
    M._free(rootNamePtr);

    for (let i = 0; i < n; i++) {
      const namePtr = this.allocBytes(namesBufs[i]);
      const leafHandle = M._wasm_ac_new_node(NODE_LEAF, namePtr, namesBufs[i].length, 0);
      M._free(namePtr);
      M._wasm_ac_add_child(rootHandle, leafHandle);
    }

    const acHandle = M._wasm_ac_new(rootHandle, CURVE_ED25519);

    const { dataPtr: namesDataPtr, sizesPtr: namesSizesPtr } = this.allocConcatArrays(namesBufs);
    const { dataPtr: pubSharesDataPtr, sizesPtr: pubSharesSizesPtr } = this.allocConcatArrays(pubShares);
    const { dataPtr: partialsDataPtr, sizesPtr: partialsSizesPtr } = this.allocConcatArrays(partials);

    const ctPtr = this.allocBytes(ciphertext);
    const labelPtr = this.allocBytes(label);
    const outPtrPtr = M._malloc(4);
    const outSizePtr = M._malloc(4);

    try {
      rv = M._wasm_tdh2_combine(
        acHandle, pkHandle, n,
        namesDataPtr, namesSizesPtr,
        pubSharesDataPtr, pubSharesSizesPtr,
        ctPtr, ciphertext.length,
        labelPtr, label.length,
        partialsDataPtr, partialsSizesPtr,
        outPtrPtr, outSizePtr,
      );
      if (rv !== 0) throw new Error(`wasm_tdh2_combine failed: ${rv}`);
      return this.readResult(outPtrPtr, outSizePtr);
    } finally {
      M._free(namesDataPtr);
      M._free(namesSizesPtr);
      M._free(pubSharesDataPtr);
      M._free(pubSharesSizesPtr);
      M._free(partialsDataPtr);
      M._free(partialsSizesPtr);
      M._free(ctPtr);
      M._free(labelPtr);
      M._free(outPtrPtr);
      M._free(outSizePtr);
      M._wasm_ac_free(acHandle);
      M._wasm_tdh2_free_pub_key(pkHandle);
    }
  }

  private allocBytes(data: Uint8Array): number {
    const ptr = this.M._malloc(data.length);
    this.M.HEAPU8.set(data, ptr);
    return ptr;
  }

  private allocConcatArrays(arrays: Uint8Array[]): { dataPtr: number; sizesPtr: number } {
    const totalSize = arrays.reduce((sum, a) => sum + a.length, 0);
    const dataPtr = this.M._malloc(totalSize || 1);
    const sizesPtr = this.M._malloc(arrays.length * 4);

    let offset = 0;
    for (let i = 0; i < arrays.length; i++) {
      this.M.HEAPU8.set(arrays[i], dataPtr + offset);
      this.M.HEAP32[(sizesPtr >> 2) + i] = arrays[i].length;
      offset += arrays[i].length;
    }

    return { dataPtr, sizesPtr };
  }

  private readResult(outPtrPtr: number, outSizePtr: number): Uint8Array {
    const dataPtr = this.M.getValue(outPtrPtr, "i32");
    const dataSize = this.M.getValue(outSizePtr, "i32");
    const result = new Uint8Array(dataSize);
    result.set(this.M.HEAPU8.subarray(dataPtr, dataPtr + dataSize));
    this.M._free(dataPtr);
    return result;
  }
}

let wasmInstance: CbMpcWasm | null = null;

/**
 * Initialize the WASM module. Must be called once before using tdh2Encrypt/tdh2Combine.
 * Subsequent calls are no-ops and return immediately.
 */
export async function initWasm(): Promise<void> {
  if (wasmInstance) return;

  const Module = await createCbMpcModule() as unknown as EmscriptenModule;

  const ptrSize = Module._wasm_ptr_size();
  if (ptrSize !== 4) {
    console.warn(`Unexpected WASM pointer size: ${ptrSize} (expected 4)`);
  }

  wasmInstance = new CbMpcWasm(Module);
}

/**
 * Return the initialized WASM instance, or null if initWasm() has not been called.
 */
export function getWasm(): CbMpcWasm | null {
  return wasmInstance;
}

/**
 * Reset the WASM instance. Primarily for use in tests.
 */
export function resetWasm(): void {
  wasmInstance = null;
}

/**
 * Inject a pre-built CbMpcWasm instance. For use in tests only.
 */
export function setWasmForTesting(instance: CbMpcWasm): void {
  wasmInstance = instance;
}
