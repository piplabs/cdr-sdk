/**
 * Raw JSON → typed shape decoders for /dkg/* responses.
 * Converts snake_case to camelCase, base64 to `Uint8Array`, numeric strings
 * to `bigint`.
 */

import { base64ToBytes } from "./bytes.js";
import { IncompleteDKGNetworkError } from "./errors.js";
import type {
  DKGNetwork,
  DKGRegistration,
  DKGPartialDecryptionSubmission,
  DKGPartialDecryptionSubmissionsByRound,
} from "./types.js";

// ---------------------------------------------------------------------------
// Raw JSON shapes (one per response payload)
// ---------------------------------------------------------------------------

/**
 * Raw `/dkg/{latest_active,dkg_network}` response shape. Several fields are
 * stage-conditional: the keeper populates `start_block_height`,
 * `start_block_hash`, `active_val_set`, `global_public_key`, and
 * `public_coeffs` only once the round has progressed far enough to define
 * them. For rounds in Registration / Dealing / Finalization / Failed stages,
 * one or more of these will be absent. `decodeDKGNetwork` enforces presence
 * and throws {@link IncompleteDKGNetworkError} if any required field is
 * missing.
 */
export interface RawDKGNetwork {
  round: number;
  start_block_height?: string;
  start_block_hash?: string;
  active_val_set?: string[];
  total: number;
  threshold: number;
  stage: number;
  is_resharing: boolean;
  global_public_key?: string;
  public_coeffs?: string[];
}

export interface RawDKGRegistration {
  round: number;
  validator_addr: string;
  index: number;
  dkg_pub_key: string;
  comm_pub_key: string;
  pub_key_share?: string;
  enclave_report: string;
  status: number;
  code_commitment: string;
  enclave_type: string;
}

export interface RawSubmission {
  validator: string;
  round: number;
  pid: number;
  encrypted_partial: string;
  ephemeral_pub_key: string;
  pub_share: string;
  label: string;
  ciphertext: string;
}

export interface RawSubmissionsByRound {
  round: number;
  submissions: RawSubmission[];
  ciphertext: string;
  threshold: number;
  threshold_met: boolean;
}

// ---------------------------------------------------------------------------
// Decoders
// ---------------------------------------------------------------------------

export function decodeDKGNetwork(raw: RawDKGNetwork): DKGNetwork {
  const missing: string[] = [];
  if (raw.start_block_height === undefined) missing.push("start_block_height");
  if (raw.start_block_hash === undefined) missing.push("start_block_hash");
  if (raw.active_val_set === undefined) missing.push("active_val_set");
  if (raw.global_public_key === undefined) missing.push("global_public_key");
  if (raw.public_coeffs === undefined) missing.push("public_coeffs");
  if (missing.length > 0) {
    throw new IncompleteDKGNetworkError(raw.round, raw.stage, missing);
  }
  return {
    round: raw.round,
    startBlockHeight: BigInt(raw.start_block_height!),
    startBlockHash: base64ToBytes(raw.start_block_hash!),
    activeValSet: raw.active_val_set!.map((a) => a.toLowerCase() as `0x${string}`),
    total: raw.total,
    threshold: raw.threshold,
    stage: raw.stage,
    isResharing: raw.is_resharing,
    globalPublicKey: base64ToBytes(raw.global_public_key!),
    publicCoeffs: raw.public_coeffs!.map(base64ToBytes),
  };
}

export function decodeDKGRegistration(raw: RawDKGRegistration): DKGRegistration {
  return {
    round: raw.round,
    validatorAddr: raw.validator_addr.toLowerCase() as `0x${string}`,
    index: raw.index,
    dkgPubKey: base64ToBytes(raw.dkg_pub_key),
    commPubKey: base64ToBytes(raw.comm_pub_key),
    pubKeyShare: raw.pub_key_share ? base64ToBytes(raw.pub_key_share) : undefined,
    enclaveReport: base64ToBytes(raw.enclave_report),
    status: raw.status,
    codeCommitment: base64ToBytes(raw.code_commitment),
    enclaveType: base64ToBytes(raw.enclave_type),
  };
}

export function decodeSubmission(raw: RawSubmission): DKGPartialDecryptionSubmission {
  return {
    validator: raw.validator.toLowerCase() as `0x${string}`,
    round: raw.round,
    pid: raw.pid,
    encryptedPartial: base64ToBytes(raw.encrypted_partial),
    ephemeralPubKey: base64ToBytes(raw.ephemeral_pub_key),
    pubShare: base64ToBytes(raw.pub_share),
    label: base64ToBytes(raw.label),
    ciphertext: base64ToBytes(raw.ciphertext),
  };
}

export function decodeSubmissionsByRound(
  raw: RawSubmissionsByRound,
): DKGPartialDecryptionSubmissionsByRound {
  return {
    round: raw.round,
    submissions: (raw.submissions ?? []).map(decodeSubmission),
    ciphertext: base64ToBytes(raw.ciphertext),
    threshold: raw.threshold,
    thresholdMet: raw.threshold_met,
  };
}
