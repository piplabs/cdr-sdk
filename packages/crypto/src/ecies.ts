import { secp256k1 } from "@noble/curves/secp256k1";
import { hkdf } from "@noble/hashes/hkdf.js";
import { sha256 } from "@noble/hashes/sha2.js";
import { gcm } from "@noble/ciphers/aes.js";
import { randomBytes } from "@noble/hashes/utils.js";

const HKDF_INFO = new TextEncoder().encode("dkg-tdh2-partial");
const AES_KEY_LENGTH = 32;
const NONCE_LENGTH = 12;

/**
 * Decrypt an encrypted partial decryption from a validator.
 *
 * Protocol (matching Go TEE sidecar):
 *   1. ECDH: sharedSecret = recipientPrivKey * ephemeralPubKey
 *   2. HKDF-SHA256(sharedSecret, info="dkg-tdh2-partial") → 32-byte AES key
 *   3. AES-256-GCM decrypt (nonce = first 12 bytes of encrypted data)
 */
export async function decryptPartial(params: {
  /** AES-GCM encrypted partial (nonce || ciphertext || tag) */
  encryptedPartial: Uint8Array;
  /** Validator's ephemeral public key — uncompressed secp256k1 (65 bytes: 04 || x || y) */
  ephemeralPubKey: Uint8Array;
  /** Requester's secp256k1 private key (32 bytes) */
  recipientPrivKey: Uint8Array;
}): Promise<Uint8Array> {
  const { encryptedPartial, ephemeralPubKey, recipientPrivKey } = params;

  const sharedPoint = secp256k1.getSharedSecret(recipientPrivKey, ephemeralPubKey);
  // x-coordinate only (bytes 1..33 of uncompressed point)
  const sharedSecret = sharedPoint.slice(1, 33);

  const aesKey = hkdf(sha256, sharedSecret, undefined, HKDF_INFO, AES_KEY_LENGTH);

  const nonce = encryptedPartial.slice(0, NONCE_LENGTH);
  const ciphertextWithTag = encryptedPartial.slice(NONCE_LENGTH);

  const aesGcm = gcm(aesKey, nonce);
  return aesGcm.decrypt(ciphertextWithTag);
}

/**
 * Generate an ephemeral secp256k1 keypair for CDR vault read requests.
 * The caller is responsible for zeroing `privateKey` after use.
 */
export function generateEphemeralKeyPair(): {
  privateKey: Uint8Array;
  publicKey: Uint8Array;
} {
  const privateKey = secp256k1.utils.randomPrivateKey();
  const publicKey = secp256k1.getPublicKey(privateKey, false); // uncompressed 65 bytes
  return { privateKey, publicKey };
}

/**
 * Encrypt data to a recipient's public key (test helper, mirrors validator behavior).
 * This function is NOT part of the public API — only used in tests.
 * The barrel export (index.ts) should NOT re-export this function.
 * Tests import it directly from the ecies.ts module.
 */
export async function encryptForTest(
  plaintext: Uint8Array,
  recipientPubKey: Uint8Array,
): Promise<{ ciphertext: Uint8Array; ephemeralPubKey: Uint8Array }> {
  // Generate ephemeral keypair
  const ephPriv = secp256k1.utils.randomPrivateKey();
  const ephPub = secp256k1.getPublicKey(ephPriv, false);

  // ECDH
  const sharedPoint = secp256k1.getSharedSecret(ephPriv, recipientPubKey);
  const sharedSecret = sharedPoint.slice(1, 33);

  // HKDF
  const aesKey = hkdf(sha256, sharedSecret, undefined, HKDF_INFO, AES_KEY_LENGTH);

  // AES-256-GCM encrypt
  const nonce = randomBytes(NONCE_LENGTH);
  const aesGcm = gcm(aesKey, nonce);
  const encrypted = aesGcm.encrypt(plaintext);

  // Prepend nonce
  const ciphertext = new Uint8Array(NONCE_LENGTH + encrypted.length);
  ciphertext.set(nonce, 0);
  ciphertext.set(encrypted, NONCE_LENGTH);

  return { ciphertext, ephemeralPubKey: ephPub };
}
