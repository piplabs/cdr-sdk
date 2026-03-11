/** Parsed EncryptedPartialDecryptionSubmitted event from the CDR contract */
export interface PartialDecryptionEvent {
  /** Validator address (msg.sender of submitEncryptedPartialDecryption) */
  validator: `0x${string}`;
  /** DKG round number */
  round: number;
  /** Validator's 1-based participant index */
  pid: number;
  /** AES-GCM encrypted partial decryption bytes */
  encryptedPartial: `0x${string}`;
  /** Validator's ephemeral public key — uncompressed secp256k1 (65 bytes) */
  ephemeralPubKey: `0x${string}`;
  /** Validator's Ed25519 public key share with curve code prefix (34 bytes) */
  pubShare: `0x${string}`;
  /** Requester's public key */
  requesterPubKey: `0x${string}`;
  /** Vault UUID */
  uuid: number;
  /** Signature over the partial decryption payload */
  signature: `0x${string}`;
}

/** CDR Vault as stored on-chain */
export interface Vault {
  uuid: number;
  updatable: boolean;
  writeConditionAddr: `0x${string}`;
  readConditionAddr: `0x${string}`;
  writeConditionData: `0x${string}`;
  readConditionData: `0x${string}`;
  encryptedData: `0x${string}`;
}
