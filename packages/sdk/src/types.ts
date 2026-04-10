/**
 * A collected partial decryption, either from an EVM
 * EncryptedPartialDecryptionSubmitted event (evm-events mode) or from the
 * x/dkg keeper via abci_query (cosmos-abci mode).
 *
 * `requesterPubKey` and `signature` are present only in evm-events mode.
 * The keeper does not persist them: signatures are verified on ingress and
 * dropped (see story/client/x/dkg/keeper/dkg_handler.go PartialDecryptionSubmitted),
 * and the requester key is the query parameter that scopes the lookup.
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
  /** Requester's public key. Populated from EVM events only. */
  requesterPubKey?: `0x${string}`;
  /** TEE signature over the partial decryption payload. Populated from EVM events only. */
  signature?: `0x${string}`;
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
