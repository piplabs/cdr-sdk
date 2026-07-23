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
  collected: number;
  needed: number;
  timeoutMs: number;
  constructor(collected: number, needed: number, timeoutMs: number) {
    super(
      `Timed out collecting partials after ${timeoutMs}ms: got ${collected}/${needed}`,
      "PARTIAL_COLLECTION_TIMEOUT",
    );
    this.collected = collected;
    this.needed = needed;
    this.timeoutMs = timeoutMs;
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

export class VaultAllocatedEventNotFoundError extends CDRError {
  constructor() {
    super(
      "VaultAllocated event not found in transaction logs",
      "VAULT_ALLOCATED_EVENT_NOT_FOUND",
    );
  }
}

/**
 * The license terms' minting fee is denominated in a token the SDK cannot
 * auto-wrap. Only the native-token wrapper WIP is supported — pay the fee
 * manually in the terms' currency, then mint without this helper.
 */
export class UnsupportedLicenseCurrencyError extends CDRError {
  currency: `0x${string}`;
  constructor(currency: `0x${string}`) {
    super(
      `License minting fee is denominated in ${currency}, which is not the WIP native-token wrapper — auto-wrapping cannot pay it`,
      "UNSUPPORTED_LICENSE_CURRENCY",
    );
    this.currency = currency;
  }
}

/**
 * A fee-preparation step (wrap / approve) was needed but disabled via
 * `autoWrap: false` / `autoApprove: false`. Perform the step manually or
 * re-enable the flag.
 */
export class LicenseMintPreparationError extends CDRError {
  constructor(message: string) {
    super(message, "LICENSE_MINT_PREPARATION");
  }
}

export class LicenseTokensMintedEventNotFoundError extends CDRError {
  constructor() {
    super(
      "LicenseTokensMinted event not found in transaction logs",
      "LICENSE_TOKENS_MINTED_EVENT_NOT_FOUND",
    );
  }
}

/**
 * A license-mint step (`deposit` / `approve` / `mint`) landed on-chain but
 * its transaction reverted. `step` says which one, so the failure isn't
 * mistaken for a missing mint event.
 */
export class LicenseTransactionRevertedError extends CDRError {
  step: "deposit" | "approve" | "mint";
  txHash: `0x${string}`;
  constructor(step: "deposit" | "approve" | "mint", txHash: `0x${string}`) {
    super(
      `License ${step} transaction ${txHash} reverted`,
      "LICENSE_TRANSACTION_REVERTED",
    );
    this.step = step;
    this.txHash = txHash;
  }
}

/**
 * Thrown by `hexToBytes` when the input is malformed. `reason` discriminates
 * the failure mode so callers can branch without parsing the message:
 *   - `"ODD_LENGTH"`: hex digit count was odd — `length` carries the count.
 *   - `"INVALID_CHAR"`: a non-hex character was encountered — `offset` is
 *     the position (0-based, after the optional `0x` prefix).
 */
export class InvalidHexError extends CDRError {
  reason: "ODD_LENGTH" | "INVALID_CHAR";
  length?: number;
  offset?: number;
  constructor(reason: "ODD_LENGTH", details: { length: number });
  constructor(reason: "INVALID_CHAR", details: { offset: number });
  constructor(
    reason: "ODD_LENGTH" | "INVALID_CHAR",
    details: { length?: number; offset?: number },
  ) {
    const msg =
      reason === "ODD_LENGTH"
        ? `hexToBytes: odd-length hex string (length ${details.length})`
        : `hexToBytes: invalid hex character at offset ${details.offset}`;
    super(msg, "INVALID_HEX");
    this.reason = reason;
    this.length = details.length;
    this.offset = details.offset;
  }
}

/**
 * Thrown by `parseSgxQuote` when the report bytes can't be interpreted as
 * an SGX DCAP v3 quote. `reason` discriminates:
 *   - `"TOO_SHORT"`: byte length below the minimum quote size.
 *   - `"UNSUPPORTED_VERSION"`: quote version header isn't DCAP v3.
 */
export class AttestationQuoteError extends CDRError {
  reason: "TOO_SHORT" | "UNSUPPORTED_VERSION";
  actualLength?: number;
  minLength?: number;
  version?: number;
  expectedVersion?: number;
  constructor(reason: "TOO_SHORT", details: { actualLength: number; minLength: number });
  constructor(
    reason: "UNSUPPORTED_VERSION",
    details: { version: number; expectedVersion: number },
  );
  constructor(
    reason: "TOO_SHORT" | "UNSUPPORTED_VERSION",
    details: {
      actualLength?: number;
      minLength?: number;
      version?: number;
      expectedVersion?: number;
    },
  ) {
    const msg =
      reason === "TOO_SHORT"
        ? `Invalid SGX quote: ${details.actualLength} bytes, minimum ${details.minLength} required`
        : `Unsupported SGX quote version: ${details.version} (expected ${details.expectedVersion} for DCAP v3)`;
    super(msg, "ATTESTATION_QUOTE");
    this.reason = reason;
    this.actualLength = details.actualLength;
    this.minLength = details.minLength;
    this.version = details.version;
    this.expectedVersion = details.expectedVersion;
  }
}

/**
 * Surfaced to the `onInvalidPartial` callback when a validator's partial is
 * rejected by an attestation-based trust set or other per-partial check.
 * Callers can branch on `.reason` instead of pattern-matching the message.
 */
export class InvalidPartialError extends CDRError {
  validator: string;
  pid: number;
  reason: string;
  constructor(validator: string, pid: number, reason: string) {
    super(
      `Partial rejected for validator ${validator} (pid ${pid}): ${reason}`,
      "INVALID_PARTIAL",
    );
    this.validator = validator;
    this.pid = pid;
    this.reason = reason;
  }
}

/**
 * Thrown by `Consumer.read()`'s preflight when the wallet's IP balance is
 * below the configured fee. Raised before the fee-bearing `read` tx is
 * submitted, so no gas is wasted on a tx that would revert on-chain.
 */
export class InsufficientBalanceError extends CDRError {
  balance: bigint;
  required: bigint;
  constructor(balance: bigint, required: bigint, context = "read fee") {
    super(
      `Insufficient balance for ${context}: have ${balance}, need ${required}`,
      "INSUFFICIENT_BALANCE",
    );
    this.balance = balance;
    this.required = required;
  }
}

export class ReadTransactionRevertedError extends CDRError {
  txHash: `0x${string}`;
  reason?: string;
  constructor(txHash: `0x${string}`, reason?: string) {
    super(
      reason
        ? `Read transaction ${txHash} reverted: ${reason}`
        : `Read transaction ${txHash} reverted`,
      "READ_TX_REVERTED",
    );
    this.txHash = txHash;
    this.reason = reason;
  }
}
