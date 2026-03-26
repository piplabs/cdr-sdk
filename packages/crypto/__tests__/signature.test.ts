import { describe, it, expect } from "vitest";
import { secp256k1 } from "@noble/curves/secp256k1";
import { keccak_256 as keccak256 } from "@noble/hashes/sha3";
import { RLP } from "@ethereumjs/rlp";
import { verifyPartialSignature } from "../src/signature.js";

/** Reproduce the kernel's signPartialDecryptResponse in JS. */
function kernelSign(params: {
  round: number;
  ciphertext: Uint8Array;
  encryptedPartial: Uint8Array;
  ephemeralPubKey: Uint8Array;
  pubShare: Uint8Array;
  privateKey: Uint8Array;
}): Uint8Array {
  const encoded = RLP.encode([
    params.round,
    params.ciphertext,
    params.encryptedPartial,
    params.ephemeralPubKey,
    params.pubShare,
  ]);
  const hash = keccak256(encoded);

  const sig = secp256k1.sign(hash, params.privateKey);
  const sigBytes = new Uint8Array(65);
  sigBytes.set(sig.toCompactRawBytes(), 0);
  // recovery id: kernel adds 27 if < 27
  sigBytes[64] = sig.recovery + 27;
  return sigBytes;
}

describe("verifyPartialSignature", () => {
  function makeTestData() {
    const privateKey = secp256k1.utils.randomPrivateKey();
    // commPubKey is 64 bytes: uncompressed pubkey without the 0x04 prefix
    const fullPubKey = secp256k1.getPublicKey(privateKey, false);
    const commPubKey = fullPubKey.slice(1); // drop 0x04 prefix → 64 bytes

    const round = 1;
    const ciphertext = new Uint8Array([0xaa, 0xbb, 0xcc]);
    const encryptedPartial = new Uint8Array([0xde, 0xad, 0xbe, 0xef]);
    const ephemeralPubKey = new Uint8Array([0xca, 0xfe, 0x00, 0x00]);
    const pubShare = new Uint8Array([0xba, 0xbe, 0x00, 0x00]);

    const signature = kernelSign({
      round,
      ciphertext,
      encryptedPartial,
      ephemeralPubKey,
      pubShare,
      privateKey,
    });

    return { round, ciphertext, encryptedPartial, ephemeralPubKey, pubShare, signature, commPubKey, privateKey };
  }

  it("returns true for a valid kernel-signed partial", () => {
    const d = makeTestData();
    const result = verifyPartialSignature({
      round: d.round,
      ciphertext: d.ciphertext,
      encryptedPartial: d.encryptedPartial,
      ephemeralPubKey: d.ephemeralPubKey,
      pubShare: d.pubShare,
      signature: d.signature,
      commPubKey: d.commPubKey,
    });
    expect(result).toBe(true);
  });

  it("returns false when encryptedPartial is tampered", () => {
    const d = makeTestData();
    const tampered = new Uint8Array(d.encryptedPartial);
    tampered[0] ^= 0xff;

    const result = verifyPartialSignature({
      round: d.round,
      ciphertext: d.ciphertext,
      encryptedPartial: tampered,
      ephemeralPubKey: d.ephemeralPubKey,
      pubShare: d.pubShare,
      signature: d.signature,
      commPubKey: d.commPubKey,
    });
    expect(result).toBe(false);
  });

  it("returns false when round is wrong", () => {
    const d = makeTestData();
    const result = verifyPartialSignature({
      round: d.round + 1,
      ciphertext: d.ciphertext,
      encryptedPartial: d.encryptedPartial,
      ephemeralPubKey: d.ephemeralPubKey,
      pubShare: d.pubShare,
      signature: d.signature,
      commPubKey: d.commPubKey,
    });
    expect(result).toBe(false);
  });

  it("returns false when commPubKey does not match signer", () => {
    const d = makeTestData();
    const wrongKey = secp256k1.getPublicKey(secp256k1.utils.randomPrivateKey(), false).slice(1);

    const result = verifyPartialSignature({
      round: d.round,
      ciphertext: d.ciphertext,
      encryptedPartial: d.encryptedPartial,
      ephemeralPubKey: d.ephemeralPubKey,
      pubShare: d.pubShare,
      signature: d.signature,
      commPubKey: wrongKey,
    });
    expect(result).toBe(false);
  });

  it("returns false for malformed signature (wrong length)", () => {
    const d = makeTestData();
    const result = verifyPartialSignature({
      round: d.round,
      ciphertext: d.ciphertext,
      encryptedPartial: d.encryptedPartial,
      ephemeralPubKey: d.ephemeralPubKey,
      pubShare: d.pubShare,
      signature: new Uint8Array([0x00, 0x01]),
      commPubKey: d.commPubKey,
    });
    expect(result).toBe(false);
  });

  it("handles round=0 correctly (RLP encodes as empty bytes)", () => {
    const privateKey = secp256k1.utils.randomPrivateKey();
    const commPubKey = secp256k1.getPublicKey(privateKey, false).slice(1);
    const ciphertext = new Uint8Array([0x01]);
    const encryptedPartial = new Uint8Array([0x02]);
    const ephemeralPubKey = new Uint8Array([0x03]);
    const pubShare = new Uint8Array([0x04]);

    const signature = kernelSign({
      round: 0,
      ciphertext,
      encryptedPartial,
      ephemeralPubKey,
      pubShare,
      privateKey,
    });

    const result = verifyPartialSignature({
      round: 0,
      ciphertext,
      encryptedPartial,
      ephemeralPubKey,
      pubShare,
      signature,
      commPubKey,
    });
    expect(result).toBe(true);
  });
});
