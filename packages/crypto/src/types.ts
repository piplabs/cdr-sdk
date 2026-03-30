/** TDH2 ciphertext produced by tdh2Encrypt, stored on-chain as encryptedData */
export interface TDH2Ciphertext {
  /** Full serialized ciphertext in cb-mpc format */
  raw: Uint8Array;
  /** Label used during encryption (binds ciphertext to a context) */
  label: Uint8Array;
}

/** Decrypted partial from a single validator, ready for tdh2Combine */
export interface DecryptedPartial {
  /** Validator name (used as key in the access structure) */
  name: string;
  /** Ed25519 public share with curve code prefix (0x043f + 32 bytes = 34 bytes) */
  pubShare: Uint8Array;
  /** Raw decrypted partial decryption bytes */
  partial: Uint8Array;
}
