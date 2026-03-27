import { gcm } from "@noble/ciphers/aes.js";
import { randomBytes } from "@noble/hashes/utils.js";

const AES_KEY_LENGTH = 32;
const IV_LENGTH = 12;

/** Encrypt file content with a random AES-256-GCM key.
 *  Returns ciphertext (IV || encrypted || GCM tag) and the 32-byte key. */
export function encryptFile(plaintext: Uint8Array): {
  ciphertext: Uint8Array;
  key: Uint8Array;
} {
  const key = randomBytes(AES_KEY_LENGTH);
  const iv = randomBytes(IV_LENGTH);
  const aesGcm = gcm(key, iv);
  const encrypted = aesGcm.encrypt(plaintext);

  const ciphertext = new Uint8Array(IV_LENGTH + encrypted.length);
  ciphertext.set(iv, 0);
  ciphertext.set(encrypted, IV_LENGTH);

  return { ciphertext, key };
}

/** Decrypt file content given the AES-256-GCM key.
 *  Expects ciphertext format: IV (12 bytes) || encrypted || GCM tag. */
export function decryptFile(params: {
  ciphertext: Uint8Array;
  key: Uint8Array;
}): Uint8Array {
  const { ciphertext, key } = params;
  const iv = ciphertext.slice(0, IV_LENGTH);
  const encrypted = ciphertext.slice(IV_LENGTH);
  const aesGcm = gcm(key, iv);
  return aesGcm.decrypt(encrypted);
}
