import { describe, it, expect } from "vitest";
import {
  CDRError,
  WalletClientRequiredError,
  PartialCollectionTimeoutError,
  ContractRevertError,
  InvalidParamsError,
  ObserverRequiredError,
  CidIntegrityError,
  RpcConsensusError,
  InvalidConditionContractError,
  LabelMismatchError,
  ContentSizeExceededError,
  VaultAllocatedEventNotFoundError,
  InvalidHexError,
  AttestationQuoteError,
  InvalidPartialError,
  InsufficientBalanceError,
  EmptyVaultError,
} from "../src/errors.js";

describe("errors", () => {
  describe("CDRError", () => {
    it("has code and message properties", () => {
      const err = new CDRError("test message", "TEST_CODE");
      expect(err.code).toBe("TEST_CODE");
      expect(err.message).toBe("test message");
      expect(err.name).toBe("CDRError");
      expect(err).toBeInstanceOf(Error);
    });
  });

  describe("WalletClientRequiredError", () => {
    it('has code "WALLET_CLIENT_REQUIRED"', () => {
      const err = new WalletClientRequiredError();
      expect(err.code).toBe("WALLET_CLIENT_REQUIRED");
      expect(err.message).toContain("WalletClient");
      expect(err).toBeInstanceOf(CDRError);
    });
  });

  describe("PartialCollectionTimeoutError", () => {
    it("includes collected, needed, and timeoutMs in message", () => {
      const err = new PartialCollectionTimeoutError(3, 5, 30000);
      expect(err.code).toBe("PARTIAL_COLLECTION_TIMEOUT");
      expect(err.message).toContain("30000");
      expect(err.message).toContain("3");
      expect(err.message).toContain("5");
      expect(err).toBeInstanceOf(CDRError);
    });
  });

  describe("ContractRevertError", () => {
    it("has reason property", () => {
      const err = new ContractRevertError("insufficient balance");
      expect(err.code).toBe("CONTRACT_REVERT");
      expect(err.reason).toBe("insufficient balance");
      expect(err.message).toContain("insufficient balance");
      expect(err).toBeInstanceOf(CDRError);
    });
  });

  describe("InvalidParamsError", () => {
    it('has code "INVALID_PARAMS"', () => {
      const err = new InvalidParamsError("missing field X");
      expect(err.code).toBe("INVALID_PARAMS");
      expect(err.message).toBe("missing field X");
      expect(err).toBeInstanceOf(CDRError);
    });
  });

  describe("ObserverRequiredError", () => {
    it('has code "OBSERVER_REQUIRED"', () => {
      const err = new ObserverRequiredError();
      expect(err.code).toBe("OBSERVER_REQUIRED");
      expect(err.message).toContain("globalPubKey");
      expect(err).toBeInstanceOf(CDRError);
    });
  });

  describe("CidIntegrityError", () => {
    it("includes expected and actual CIDs in message", () => {
      const err = new CidIntegrityError("QmExpected", "QmActual");
      expect(err.code).toBe("CID_INTEGRITY");
      expect(err.message).toContain("QmExpected");
      expect(err.message).toContain("QmActual");
      expect(err).toBeInstanceOf(CDRError);
    });
  });

  describe("RpcConsensusError", () => {
    it("includes field name in message", () => {
      const err = new RpcConsensusError("blockNumber");
      expect(err.code).toBe("RPC_CONSENSUS");
      expect(err.message).toContain("blockNumber");
      expect(err).toBeInstanceOf(CDRError);
    });
  });

  describe("InvalidConditionContractError", () => {
    it("includes address and type in message", () => {
      const addr = "0x1234567890abcdef1234567890abcdef12345678";
      const err = new InvalidConditionContractError(addr, "write");
      expect(err.code).toBe("INVALID_CONDITION_CONTRACT");
      expect(err.message).toContain(addr);
      expect(err.message).toContain("write");
      expect(err).toBeInstanceOf(CDRError);
    });

    it("works with read type as well", () => {
      const addr = "0xdeadbeefdeadbeefdeadbeefdeadbeefdeadbeef";
      const err = new InvalidConditionContractError(addr, "read");
      expect(err.message).toContain("read");
      expect(err.message).toContain(addr);
    });
  });

  describe("LabelMismatchError", () => {
    it("includes expected and actual hex strings in message", () => {
      const expected = "0xaabb";
      const actual = "0xccdd";
      const err = new LabelMismatchError(expected, actual);
      expect(err.code).toBe("LABEL_MISMATCH");
      expect(err.message).toContain(expected);
      expect(err.message).toContain(actual);
      expect(err).toBeInstanceOf(CDRError);
    });
  });

  describe("ContentSizeExceededError", () => {
    it("has actual (number) and max (bigint) properties", () => {
      const err = new ContentSizeExceededError(2048, 1024n);
      expect(err.code).toBe("CONTENT_SIZE_EXCEEDED");
      expect(err.actual).toBe(2048);
      expect(err.max).toBe(1024n);
      expect(err.message).toContain("2048");
      expect(err.message).toContain("1024");
      expect(err).toBeInstanceOf(CDRError);
    });
  });

  describe("VaultAllocatedEventNotFoundError", () => {
    it('has code "VAULT_ALLOCATED_EVENT_NOT_FOUND"', () => {
      const err = new VaultAllocatedEventNotFoundError();
      expect(err.code).toBe("VAULT_ALLOCATED_EVENT_NOT_FOUND");
      expect(err.message).toContain("VaultAllocated event not found");
      expect(err).toBeInstanceOf(CDRError);
    });
  });

  describe("InvalidHexError", () => {
    it('ODD_LENGTH carries length and code "INVALID_HEX"', () => {
      const err = new InvalidHexError("ODD_LENGTH", { length: 13 });
      expect(err.code).toBe("INVALID_HEX");
      expect(err.reason).toBe("ODD_LENGTH");
      expect(err.length).toBe(13);
      expect(err.offset).toBeUndefined();
      expect(err.message).toContain("odd-length");
      expect(err.message).toContain("13");
      expect(err).toBeInstanceOf(CDRError);
    });

    it("INVALID_CHAR carries offset", () => {
      const err = new InvalidHexError("INVALID_CHAR", { offset: 4 });
      expect(err.reason).toBe("INVALID_CHAR");
      expect(err.offset).toBe(4);
      expect(err.length).toBeUndefined();
      expect(err.message).toContain("invalid hex character");
      expect(err.message).toContain("4");
    });
  });

  describe("AttestationQuoteError", () => {
    it("TOO_SHORT carries actualLength and minLength, message preserves prior format", () => {
      const err = new AttestationQuoteError("TOO_SHORT", {
        actualLength: 431,
        minLength: 432,
      });
      expect(err.code).toBe("ATTESTATION_QUOTE");
      expect(err.reason).toBe("TOO_SHORT");
      expect(err.actualLength).toBe(431);
      expect(err.minLength).toBe(432);
      expect(err.message).toBe(
        "Invalid SGX quote: 431 bytes, minimum 432 required",
      );
      expect(err).toBeInstanceOf(CDRError);
    });

    it("UNSUPPORTED_VERSION carries version and expectedVersion", () => {
      const err = new AttestationQuoteError("UNSUPPORTED_VERSION", {
        version: 4,
        expectedVersion: 3,
      });
      expect(err.reason).toBe("UNSUPPORTED_VERSION");
      expect(err.version).toBe(4);
      expect(err.expectedVersion).toBe(3);
      expect(err.message).toContain("Unsupported SGX quote version: 4");
      expect(err.message).toContain("expected 3");
    });
  });

  describe("InvalidPartialError", () => {
    it("carries validator, pid, reason and uses code INVALID_PARTIAL", () => {
      const err = new InvalidPartialError(
        "0x0000000000000000000000000000000000000001",
        7,
        "attestation rejected",
      );
      expect(err.code).toBe("INVALID_PARTIAL");
      expect(err.validator).toBe("0x0000000000000000000000000000000000000001");
      expect(err.pid).toBe(7);
      expect(err.reason).toBe("attestation rejected");
      expect(err.message).toContain("pid 7");
      expect(err.message).toContain("attestation rejected");
      expect(err).toBeInstanceOf(CDRError);
    });
  });

  describe("InsufficientBalanceError", () => {
    it("carries balance and required (bigint)", () => {
      const err = new InsufficientBalanceError(10n, 100n);
      expect(err.code).toBe("INSUFFICIENT_BALANCE");
      expect(err.balance).toBe(10n);
      expect(err.required).toBe(100n);
      expect(err.message).toContain("10");
      expect(err.message).toContain("100");
      expect(err).toBeInstanceOf(CDRError);
    });
  });

  describe("all errors extend CDRError", () => {
    it("every error class is an instance of CDRError and Error", () => {
      const errors = [
        new WalletClientRequiredError(),
        new PartialCollectionTimeoutError(1, 2, 3000),
        new ContractRevertError("revert"),
        new InvalidParamsError("bad"),
        new ObserverRequiredError(),
        new CidIntegrityError("a", "b"),
        new RpcConsensusError("field"),
        new InvalidConditionContractError("0x00", "write"),
        new LabelMismatchError("0x11", "0x22"),
        new ContentSizeExceededError(100, 50n),
        new EmptyVaultError(42),
        new VaultAllocatedEventNotFoundError(),
        new InvalidHexError("ODD_LENGTH", { length: 3 }),
        new InvalidHexError("INVALID_CHAR", { offset: 0 }),
        new AttestationQuoteError("TOO_SHORT", { actualLength: 1, minLength: 2 }),
        new AttestationQuoteError("UNSUPPORTED_VERSION", { version: 4, expectedVersion: 3 }),
        new InvalidPartialError("0xabc", 1, "reason"),
        new InsufficientBalanceError(1n, 2n),
      ];

      for (const err of errors) {
        expect(err).toBeInstanceOf(CDRError);
        expect(err).toBeInstanceOf(Error);
      }
    });
  });
});
