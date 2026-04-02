export class CDRError extends Error {
  code: string;
  constructor(message: string, code: string) {
    super(message);
    this.name = "CDRError";
    this.code = code;
  }
}

export class WalletClientRequiredError extends CDRError {
  constructor() {
    super("WalletClient is required for write operations", "WALLET_CLIENT_REQUIRED");
  }
}

export class PartialCollectionTimeoutError extends CDRError {
  constructor(collected: number, needed: number, timeoutMs: number) {
    super(
      `Timed out collecting partials after ${timeoutMs}ms: got ${collected}/${needed}`,
      "PARTIAL_COLLECTION_TIMEOUT",
    );
  }
}

export class ContractRevertError extends CDRError {
  reason: string;
  constructor(reason: string) {
    super(`Contract reverted: ${reason}`, "CONTRACT_REVERT");
    this.reason = reason;
  }
}

export class InvalidParamsError extends CDRError {
  constructor(message: string) {
    super(message, "INVALID_PARAMS");
  }
}

export class ObserverRequiredError extends CDRError {
  constructor() {
    super("globalPubKey and threshold are required when no Observer is configured", "OBSERVER_REQUIRED");
  }
}

export class LabelMismatchError extends CDRError {
  constructor(expected: string, actual: string) {
    super(
      `TDH2 ciphertext label mismatch: expected ${expected}, got ${actual}`,
      "LABEL_MISMATCH",
    );
  }
}

export class ContentSizeExceededError extends CDRError {
  actual: number;
  max: bigint;
  constructor(actual: number, max: bigint) {
    super(
      `Vault payload size ${actual} bytes exceeds max ${max} bytes`,
      "CONTENT_SIZE_EXCEEDED",
    );
    this.actual = actual;
    this.max = max;
  }
}
