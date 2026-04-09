import { describe, it, expect } from "vitest";
import { uuidToLabel } from "../src/label.js";

describe("uuidToLabel", () => {
  it("returns 32-byte Uint8Array of all zeros for uuid 0", () => {
    const label = uuidToLabel(0);
    expect(label).toBeInstanceOf(Uint8Array);
    expect(label.length).toBe(32);
    expect(label.every((b) => b === 0)).toBe(true);
  });

  it("returns 32 bytes with last 4 bytes being big-endian 1 for uuid 1", () => {
    const label = uuidToLabel(1);
    expect(label.length).toBe(32);
    // First 28 bytes should all be zero
    for (let i = 0; i < 28; i++) {
      expect(label[i]).toBe(0);
    }
    // Last 4 bytes: big-endian 1 => 0x00 0x00 0x00 0x01
    expect(label[28]).toBe(0x00);
    expect(label[29]).toBe(0x00);
    expect(label[30]).toBe(0x00);
    expect(label[31]).toBe(0x01);
  });

  it("returns correct big-endian encoding for uuid 256", () => {
    const label = uuidToLabel(256);
    expect(label.length).toBe(32);
    // 256 = 0x00000100 in big-endian
    expect(label[28]).toBe(0x00);
    expect(label[29]).toBe(0x00);
    expect(label[30]).toBe(0x01);
    expect(label[31]).toBe(0x00);
  });

  it("returns 0xFFFFFFFF in last 4 bytes for max uint32 (4294967295)", () => {
    const label = uuidToLabel(4294967295);
    expect(label.length).toBe(32);
    // First 28 bytes should all be zero
    for (let i = 0; i < 28; i++) {
      expect(label[i]).toBe(0);
    }
    // Last 4 bytes: 0xFF 0xFF 0xFF 0xFF
    expect(label[28]).toBe(0xff);
    expect(label[29]).toBe(0xff);
    expect(label[30]).toBe(0xff);
    expect(label[31]).toBe(0xff);
  });

  it("always returns a Uint8Array of length 32", () => {
    const testValues = [0, 1, 42, 1000, 65535, 16777216, 4294967295];
    for (const uuid of testValues) {
      const label = uuidToLabel(uuid);
      expect(label).toBeInstanceOf(Uint8Array);
      expect(label.length).toBe(32);
    }
  });
});
