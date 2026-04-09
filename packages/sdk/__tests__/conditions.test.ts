import { describe, it, expect } from "vitest";
import { decodeAbiParameters } from "viem";
import { conditions } from "../src/conditions.js";

describe("conditions", () => {
  const ZERO_ADDRESS = "0x0000000000000000000000000000000000000000" as const;
  const CONDITION_ADDR = "0x1111111111111111111111111111111111111111" as const;

  describe("open", () => {
    it("returns the supplied address and conditionData of 0x", () => {
      const result = conditions.open({ address: CONDITION_ADDR });
      expect(result).toEqual({
        address: CONDITION_ADDR,
        conditionData: "0x",
      });
    });

    it("works with zero address", () => {
      const result = conditions.open({ address: ZERO_ADDRESS });
      expect(result.address).toBe(ZERO_ADDRESS);
      expect(result.conditionData).toBe("0x");
    });
  });

  describe("ownerOnly", () => {
    it("returns correct ABI-encoded conditionData containing the owner address", () => {
      const owner = "0xaAaAaAaaAaAaAaaAaAAAAAAAAaaaAaAaAaaAaaAa" as const;
      const result = conditions.ownerOnly({ address: CONDITION_ADDR, owner });

      expect(result.address).toBe(CONDITION_ADDR);
      // Decode the conditionData and verify it contains the owner address
      const [decoded] = decodeAbiParameters(
        [{ type: "address" }],
        result.conditionData,
      );
      expect(decoded.toLowerCase()).toBe(owner.toLowerCase());
    });
  });

  describe("tokenGate", () => {
    it("returns correct ABI-encoded data with token address and minBalance", () => {
      const token = "0xbBbBBBBbbBBBbbbBbbBbbbbBBbBbbbbBbBbbBBbB" as const;
      const minBalance = 1000n;
      const result = conditions.tokenGate({
        address: CONDITION_ADDR,
        token,
        minBalance,
      });

      expect(result.address).toBe(CONDITION_ADDR);
      const [decodedToken, decodedBalance] = decodeAbiParameters(
        [{ type: "address" }, { type: "uint256" }],
        result.conditionData,
      );
      expect(decodedToken.toLowerCase()).toBe(token.toLowerCase());
      expect(decodedBalance).toBe(minBalance);
    });
  });

  describe("merkle", () => {
    it("returns correct ABI-encoded merkle root", () => {
      const root =
        "0xabcdef1234567890abcdef1234567890abcdef1234567890abcdef1234567890" as const;
      const result = conditions.merkle({ address: CONDITION_ADDR, root });

      expect(result.address).toBe(CONDITION_ADDR);
      const [decodedRoot] = decodeAbiParameters(
        [{ type: "bytes32" }],
        result.conditionData,
      );
      expect(decodedRoot).toBe(root);
    });
  });

  describe("custom", () => {
    it("passes through address and data unchanged", () => {
      const customData = "0xdeadbeef" as const;
      const result = conditions.custom({
        address: CONDITION_ADDR,
        conditionData: customData,
      });

      expect(result.address).toBe(CONDITION_ADDR);
      expect(result.conditionData).toBe(customData);
    });

    it("does not modify arbitrary hex data", () => {
      const longData =
        "0x00112233445566778899aabbccddeeff00112233445566778899aabbccddeeff" as const;
      const result = conditions.custom({
        address: CONDITION_ADDR,
        conditionData: longData,
      });
      expect(result).toEqual({
        address: CONDITION_ADDR,
        conditionData: longData,
      });
    });
  });
});
