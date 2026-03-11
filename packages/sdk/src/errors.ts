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
