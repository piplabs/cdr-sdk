import { RLP } from "@ethereumjs/rlp";
import { secp256k1 } from "@noble/curves/secp256k1";
import { keccak_256 as keccak256Noble } from "@noble/hashes/sha3.js";
import { bytesToHex } from "@noble/hashes/utils.js";

/**
 * Verify a partial decryption signature produced by the story-kernel TEE.
 *
 * Reproduces the kernel's signing protocol:
 * 1. RLP encode [Round, Ciphertext, EncryptedPartial, EphemeralPubKey, PubShare]
 * 2. Keccak256 hash the encoded bytes
 * 3. Recover the secp256k1 public key from the signature
 * 4. Compare the recovered address with the expected address derived from commPubKey
 *
 * @returns true if the signature is valid and was produced by the holder of commPubKey
 */
export function verifyPartialSignature(params: {
  round: number;
  ciphertext: Uint8Array;
  encryptedPartial: Uint8Array;
  ephemeralPubKey: Uint8Array;
  pubShare: Uint8Array;
  /** 65-byte secp256k1 signature (r || s || v), where v is 27 or 28 */
  signature: Uint8Array;
  /** 64-byte uncompressed public key (without 0x04 prefix) from DKG Registered event */
  commPubKey: Uint8Array;
}): boolean {
  const { round, ciphertext, encryptedPartial, ephemeralPubKey, pubShare, signature, commPubKey } = params;

  if (signature.length !== 65) return false;
  if (commPubKey.length !== 64) return false;

  try {
    // 1. RLP encode the signature material (matches Go struct field order).
    // @ethereumjs/rlp encodes numbers as minimal big-endian bytes, matching Go's RLP uint encoding.
    const encoded = RLP.encode([round, ciphertext, encryptedPartial, ephemeralPubKey, pubShare]);

    // 2. Keccak256 hash
    const respHash = keccak256Noble(encoded);

    // 3. Normalize recovery ID and recover public key
    let recoveryId = signature[64];
    if (recoveryId >= 27) recoveryId -= 27;

    const r = signature.slice(0, 32);
    const s = signature.slice(32, 64);

    const sig = new secp256k1.Signature(
      BigInt("0x" + bytesToHex(r)),
      BigInt("0x" + bytesToHex(s)),
    ).addRecoveryBit(recoveryId);

    const recoveredPubKey = sig.recoverPublicKey(respHash).toRawBytes(false);
    // recoveredPubKey is 65 bytes (0x04 || x || y), drop prefix to get 64 bytes
    const recoveredRaw = recoveredPubKey.slice(1);

    // 4. Compare addresses: keccak256(pubkey)[12:32]
    const recoveredAddr = keccak256Noble(recoveredRaw).slice(12);
    const expectedAddr = keccak256Noble(commPubKey).slice(12);

    return recoveredAddr.length === expectedAddr.length &&
      recoveredAddr.every((byte, i) => byte === expectedAddr[i]);
  } catch {
    return false;
  }
}
