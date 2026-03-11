import { getWasm } from "./wasm/loader.js";
import { WasmNotInitializedError, InsufficientPartialsError, InvalidCiphertextError } from "./errors.js";
import type { TDH2Ciphertext, DecryptedPartial } from "./types.js";

/**
 * Encrypt plaintext using TDH2 threshold encryption.
 *
 * The ciphertext can only be decrypted by collecting >= threshold partial
 * decryptions from DKG committee validators and combining them.
 */
export async function tdh2Encrypt(params: {
  plaintext: Uint8Array;
  /** 32-byte Ed25519 global DKG public key */
  globalPubKey: Uint8Array;
  label: Uint8Array;
}): Promise<TDH2Ciphertext> {
  const wasm = getWasm();
  if (!wasm) throw new WasmNotInitializedError();

  const raw = wasm.tdh2Encrypt(params.globalPubKey, params.plaintext, params.label);
  return { raw, label: params.label };
}

/**
 * Combine threshold partial decryptions to recover the plaintext.
 *
 * Internally builds a cb-mpc access structure from the partials' PIDs and
 * the threshold value, then calls TDH2Combine.
 */
export async function tdh2Combine(params: {
  ciphertext: TDH2Ciphertext;
  partials: DecryptedPartial[];
  globalPubKey: Uint8Array;
  label: Uint8Array;
  threshold: number;
}): Promise<Uint8Array> {
  const wasm = getWasm();
  if (!wasm) throw new WasmNotInitializedError();

  const { ciphertext, partials, globalPubKey, label, threshold } = params;

  if (partials.length < threshold) {
    throw new InsufficientPartialsError(partials.length, threshold);
  }

  if (ciphertext.raw.length === 0) {
    throw new InvalidCiphertextError("empty ciphertext");
  }

  const pids = partials.map((p) => p.pid);
  const pubShares = partials.map((p) => p.pubShare);
  const partialBytes = partials.map((p) => p.partial);

  return wasm.tdh2Combine(threshold, pids, pubShares, partialBytes, globalPubKey, ciphertext.raw, label);
}
