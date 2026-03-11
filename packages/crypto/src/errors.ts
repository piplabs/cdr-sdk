export class CDRCryptoError extends Error {
  code: string;
  constructor(message: string, code: string) {
    super(message);
    this.name = "CDRCryptoError";
    this.code = code;
  }
}

export class WasmNotInitializedError extends CDRCryptoError {
  constructor() {
    super("WASM module not initialized. Call initWasm() first.", "WASM_NOT_INITIALIZED");
  }
}

export class InvalidCiphertextError extends CDRCryptoError {
  constructor(detail?: string) {
    super(`Invalid ciphertext${detail ? `: ${detail}` : ""}`, "INVALID_CIPHERTEXT");
  }
}

export class InsufficientPartialsError extends CDRCryptoError {
  constructor(have: number, need: number) {
    super(`Insufficient partials: have ${have}, need ${need}`, "INSUFFICIENT_PARTIALS");
  }
}
