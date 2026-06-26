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

    it("exposes collected, needed, and timeoutMs as public fields", () => {
      const err = new PartialCollectionTimeoutError(3, 5, 30000);
      expect(err.collected).toBe(3);
      expect(err.needed).toBe(5);
      expect(err.timeoutMs).toBe(30000);
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

    it("exposes reason field, defaulting to selector-miss", () => {
      const addr = "0x1234567890abcdef1234567890abcdef12345678";
      const defaultErr = new InvalidConditionContractError(addr, "write");
      expect(defaultErr.reason).toBe("selector-miss");

      const ambiguousErr = new InvalidConditionContractError(
        addr,
        "read",
        "ambiguous-fallback",
      );
      expect(ambiguousErr.reason).toBe("ambiguous-fallback");
      // Message routes users to the escape hatch so they can self-diagnose
      // the false-negative branch (Diamond proxies, deliberate payload-
      // reverting fallbacks) without having to read the SDK source.
      expect(ambiguousErr.message).toContain("skipConditionValidation");
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
      ];

      for (const err of errors) {
        expect(err).toBeInstanceOf(CDRError);
        expect(err).toBeInstanceOf(Error);
      }
    });
  });
});
