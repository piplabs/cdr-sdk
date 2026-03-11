import { describe, it, expect } from "vitest";
import { decryptPartial, encryptForTest } from "../src/ecies.js";

describe("decryptPartial", () => {
  it("decrypts an encrypted partial using ECDH + HKDF + AES-256-GCM", async () => {
    const { secp256k1 } = await import("@noble/curves/secp256k1");
    const recipientPrivKey = secp256k1.utils.randomPrivateKey();
    const recipientPubKey = secp256k1.getPublicKey(recipientPrivKey, false);

    const originalPartial = new TextEncoder().encode("test-partial-decryption-data");
    const encrypted = await encryptForTest(originalPartial, recipientPubKey);

    const decrypted = await decryptPartial({
      encryptedPartial: encrypted.ciphertext,
      ephemeralPubKey: encrypted.ephemeralPubKey,
      recipientPrivKey,
    });

    expect(decrypted).toEqual(originalPartial);
  });

  it("fails with wrong recipient private key", async () => {
    const { secp256k1 } = await import("@noble/curves/secp256k1");
    const recipientPrivKey = secp256k1.utils.randomPrivateKey();
    const recipientPubKey = secp256k1.getPublicKey(recipientPrivKey, false);
    const wrongPrivKey = secp256k1.utils.randomPrivateKey();

    const originalPartial = new TextEncoder().encode("secret");
    const encrypted = await encryptForTest(originalPartial, recipientPubKey);

    await expect(
      decryptPartial({
        encryptedPartial: encrypted.ciphertext,
        ephemeralPubKey: encrypted.ephemeralPubKey,
        recipientPrivKey: wrongPrivKey,
      })
    ).rejects.toThrow();
  });
});
