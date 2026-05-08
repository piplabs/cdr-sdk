import { describe, it, expect } from "vitest";
import {
  base64ToBytes,
  bytesToBase64,
  hexToBytes,
  bytesToHex,
} from "../src/story-api/bytes.js";

describe("story-api/bytes", () => {
  describe("base64ToBytes / bytesToBase64", () => {
    it("round-trips arbitrary bytes", () => {
      const samples = [
        new Uint8Array([]),
        new Uint8Array([0]),
        new Uint8Array([0, 0]),
        new Uint8Array([0, 0, 0]),
        new Uint8Array([0xff, 0x00, 0xa5, 0x12]),
        new Uint8Array(32).fill(0xab),
      ];
      for (const bytes of samples) {
        expect(base64ToBytes(bytesToBase64(bytes))).toEqual(bytes);
      }
    });

    it("decodes a known fixture (Aeneid round-6 globalPublicKey)", () => {
      const b64 = "zSYlIvKyXT2G29HgM7wkqzzfzOs/PWAJCqIP+YYeJAM=";
      const decoded = base64ToBytes(b64);
      expect(decoded.length).toBe(32);
      expect(bytesToHex(decoded)).toBe(
        "cd262522f2b25d3d86dbd1e033bc24ab3cdfcceb3f3d60090aa20ff9861e2403",
      );
    });

    it("encodes empty bytes to empty string and back", () => {
      expect(bytesToBase64(new Uint8Array(0))).toBe("");
      expect(base64ToBytes("")).toEqual(new Uint8Array(0));
    });
  });

  describe("hexToBytes / bytesToHex", () => {
    it("round-trips arbitrary bytes", () => {
      const samples = [
        new Uint8Array([]),
        new Uint8Array([0]),
        new Uint8Array([0xff]),
        new Uint8Array([0x00, 0xff, 0x80, 0x01]),
        new Uint8Array(64).fill(0x42),
      ];
      for (const bytes of samples) {
        expect(hexToBytes(bytesToHex(bytes))).toEqual(bytes);
      }
    });

    it("accepts 0x prefix (lowercase)", () => {
      expect(hexToBytes("0xdeadbeef")).toEqual(
        new Uint8Array([0xde, 0xad, 0xbe, 0xef]),
      );
    });

    it("accepts 0X prefix (uppercase)", () => {
      expect(hexToBytes("0XDEADBEEF")).toEqual(
        new Uint8Array([0xde, 0xad, 0xbe, 0xef]),
      );
    });

    it("accepts no prefix", () => {
      expect(hexToBytes("deadbeef")).toEqual(
        new Uint8Array([0xde, 0xad, 0xbe, 0xef]),
      );
    });

    it("decodes a known fixture (DevNet globalPubKey hex form)", () => {
      const hex =
        "83c3fc34a2561ffee9a8d419629b83306610d4f31d39de63fee38b6b10477d37";
      const decoded = hexToBytes(hex);
      expect(decoded.length).toBe(32);
      expect(bytesToHex(decoded)).toBe(hex);
    });

    it("preserves leading-zero bytes when encoding", () => {
      expect(bytesToHex(new Uint8Array([0x01, 0x02, 0x03]))).toBe("010203");
      expect(bytesToHex(new Uint8Array([0x00, 0x00, 0x01]))).toBe("000001");
    });

    it("rejects odd-length hex", () => {
      expect(() => hexToBytes("abc")).toThrow(/odd-length/);
      expect(() => hexToBytes("0xabc")).toThrow(/odd-length/);
    });

    it("rejects invalid hex characters", () => {
      expect(() => hexToBytes("xx")).toThrow(/invalid hex character/);
      expect(() => hexToBytes("a!")).toThrow(/invalid hex character/);
    });

    it("encodes empty bytes to empty string", () => {
      expect(bytesToHex(new Uint8Array(0))).toBe("");
    });
  });

  describe("cross-encoding (same value, hex vs base64)", () => {
    it("hex form and base64 form decode to identical bytes", () => {
      // Aeneid round-6 globalPublicKey appears as both encodings on different endpoints.
      const hexForm =
        "cd262522f2b25d3d86dbd1e033bc24ab3cdfcceb3f3d60090aa20ff9861e2403";
      const base64Form = "zSYlIvKyXT2G29HgM7wkqzzfzOs/PWAJCqIP+YYeJAM=";
      expect(Array.from(hexToBytes(hexForm))).toEqual(
        Array.from(base64ToBytes(base64Form)),
      );
    });
  });
});
