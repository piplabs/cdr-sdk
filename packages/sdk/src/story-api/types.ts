/**
 * TypeScript types for Story-API REST responses (decoded shape).
 * Byte fields are `Uint8Array`; large numeric strings are `bigint`.
 */

/** A DKG network at a specific round. */
export interface DKGNetwork {
  round: number;
  /** Block height the round started at. */
  startBlockHeight: bigint;
  /** Block hash of the round-start block. */
  startBlockHash: Uint8Array;
  /**
   * Chain's active consensus validator set at round start (the candidate
   * pool). Length is `>= total` — only `total` of these are actually
   * selected to participate in this DKG round.
   */
  activeValSet: `0x${string}`[];
  /** Number of validators selected from `activeValSet` to participate. */
  total: number;
  /** Threshold needed to combine partials. */
  threshold: number;
  /** 0 Unspecified, 1 Registration, 2 Dealing, 3 Finalization, 4 Active, 5 Failed, 6 Ended. */
  stage: number;
  /** Whether this round was resharing from a prior network. */
  isResharing: boolean;
  /** TDH2 group public key. */
  globalPublicKey: Uint8Array;
  /**
   * Public commitment coefficients of the DKG sharing polynomial
   * (Feldman VSS). Length equals `threshold`. `publicCoeffs[0]` is the
   * polynomial's constant term and equals `globalPublicKey`.
   */
  publicCoeffs: Uint8Array[];
}

/** A single validator's DKG registration record. */
export interface DKGRegistration {
  round: number;
  validatorAddr: `0x${string}`;
  /** 1-based participant index assigned by the keeper. */
  index: number;
  /** Per-round DKG public key. */
  dkgPubKey: Uint8Array;
  /** Validator's signing public key (used to verify partial-decryption signatures). */
  commPubKey: Uint8Array;
  /** Per-round public key share (only present for Finalized status). */
  pubKeyShare?: Uint8Array;
  /** SGX attestation report (~4.7 KiB). */
  enclaveReport: Uint8Array;
  /** 0 Unspecified, 1 Verified, 2 Finalized, 3 Invalidated. */
  status: number;
  codeCommitment: Uint8Array;
  /** 32-byte big-endian enclave-type tag. */
  enclaveType: Uint8Array;
}

/** A single encrypted partial-decryption submission. */
export interface DKGPartialDecryptionSubmission {
  validator: `0x${string}`;
  round: number;
  /** Validator's 1-based participant index in the round. */
  pid: number;
  /** AES-GCM encrypted partial decryption bytes. */
  encryptedPartial: Uint8Array;
  /** Validator's ephemeral secp256k1 public key (uncompressed, 65 bytes). */
  ephemeralPubKey: Uint8Array;
  /** Validator's per-round public key share. */
  pubShare: Uint8Array;
  /** 32-byte big-endian uuid (lower 4 bytes carry the value). */
  label: Uint8Array;
  /** TDH2 ciphertext the partial decrypts. */
  ciphertext: Uint8Array;
}

/**
 * Partial-decryption submissions grouped by `(round, ciphertext)`.
 * Multiple groups may be returned when a request crosses a round transition.
 */
export interface DKGPartialDecryptionSubmissionsByRound {
  round: number;
  submissions: DKGPartialDecryptionSubmission[];
  ciphertext: Uint8Array;
  threshold: number;
  /** Whether the keeper has observed enough submissions to combine. */
  thresholdMet: boolean;
}
