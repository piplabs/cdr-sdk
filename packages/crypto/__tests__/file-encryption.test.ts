import { describe, it, expect } from "vitest";
import { encryptFile, decryptFile } from "../src/file-encryption.js";

describe("encryptFile / decryptFile", () => {
  it("round-trip: decrypt(encrypt(plaintext)) returns original", () => {
    const plaintext = new TextEncoder().encode("hello world");
    const { ciphertext, key } = encryptFile(plaintext);
    const result = decryptFile({ ciphertext, key });
    expect(result).toEqual(plaintext);
  });

  it("produces different ciphertext each call (random key + IV)", () => {
    const plaintext = new TextEncoder().encode("same input");
    const a = encryptFile(plaintext);
    const b = encryptFile(plaintext);
    expect(a.ciphertext).not.toEqual(b.ciphertext);
    expect(a.key).not.toEqual(b.key);
  });

  it("decryption with wrong key throws", () => {
    const plaintext = new TextEncoder().encode("secret");
    const { ciphertext } = encryptFile(plaintext);
    const wrongKey = new Uint8Array(32).fill(0xff);
    expect(() => decryptFile({ ciphertext, key: wrongKey })).toThrow();
  });

  it("handles empty plaintext", () => {
    const plaintext = new Uint8Array(0);
    const { ciphertext, key } = encryptFile(plaintext);
    const result = decryptFile({ ciphertext, key });
    expect(result).toEqual(plaintext);
  });

  it("handles large plaintext (1 MB)", () => {
    const plaintext = new Uint8Array(1024 * 1024).fill(0xab);
    const { ciphertext, key } = encryptFile(plaintext);
    const result = decryptFile({ ciphertext, key });
    expect(result).toEqual(plaintext);
  });

  it("ciphertext is IV (12) + encrypted data + GCM tag (16)", () => {
    const plaintext = new TextEncoder().encode("test");
    const { ciphertext } = encryptFile(plaintext);
    expect(ciphertext.length).toBe(12 + plaintext.length + 16);
  });

  it("key is 32 bytes", () => {
    const { key } = encryptFile(new Uint8Array(10));
    expect(key.length).toBe(32);
  });
});
