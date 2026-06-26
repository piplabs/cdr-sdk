/**
 * A collected partial decryption, surfaced from the Story-API REST endpoint
 * `/dkg/cdr_partials`. The keeper has already verified the validator's
 * signature on ingress and dropped the signature bytes (see
 * `story/client/x/dkg/keeper/dkg_handler.go::PartialDecryptionSubmitted`)
 * so the SDK only carries the fields needed for ECIES decrypt + TDH2
 * combine.
 */
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
  /** Vault UUID */
  uuid: number;
  /**
   * TDH2 ciphertext this partial decrypts. Carried per-event because the
   * keeper indexes `/dkg/cdr_partials` by `(round, ciphertext)`; all events
   * returned from a successful `collectPartials` call share the same value
   * (filtered to match the vault's current ciphertext).
   */
  ciphertext: `0x${string}`;
}

/**
 * Tagged reason passed to `onInvalidPartial` callbacks when `collectPartials`
 * drops a validator's submission. Discriminate on `kind` for telemetry /
 * UI / fallback logic instead of regex-matching error messages.
 *
 * Currently only `attestation-rejected` is emitted; the union is open to
 * extension as future failure paths (e.g. stale registry, signature
 * mismatch) are surfaced from the SDK.
 */
export type InvalidPartialReason = {
  kind: "attestation-rejected";
  validator: `0x${string}`;
  pid: number;
  round: number;
};

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
