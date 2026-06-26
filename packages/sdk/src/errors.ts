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

export class CidIntegrityError extends CDRError {
  constructor(expected: string, actual: string) {
    super(
      `CID integrity check failed: expected ${expected}, got ${actual}`,
      "CID_INTEGRITY",
    );
  }
}

export class RpcConsensusError extends CDRError {
  constructor(field: string) {
    super(
      `RPC consensus failure: ${field} returned different values across providers`,
      "RPC_CONSENSUS",
    );
  }
}

export type InvalidConditionContractReason =
  | "selector-miss"
  | "ambiguous-fallback";

export class InvalidConditionContractError extends CDRError {
  readonly reason: InvalidConditionContractReason;
  constructor(
    address: string,
    type: "write" | "read",
    reason: InvalidConditionContractReason = "selector-miss",
  ) {
    const detail =
      reason === "ambiguous-fallback"
        ? "preflight conservatively rejected: a catch-all fallback answered an unknown selector by returning a value or reverting with data. If the contract is correct, pass `skipConditionValidation: true` to bypass this preflight"
        : "does not implement the required interface";
    super(
      `${type} condition contract at ${address} ${detail}`,
      "INVALID_CONDITION_CONTRACT",
    );
    this.reason = reason;
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

export class EmptyVaultError extends CDRError {
  uuid: number;
  constructor(uuid: number) {
    super(
      `Vault ${uuid} has no data (encryptedData is empty); upload first or verify the uuid`,
      "EMPTY_VAULT",
    );
    this.uuid = uuid;
  }
}
