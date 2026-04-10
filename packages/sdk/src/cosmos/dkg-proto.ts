/**
 * Hand-written protobuf codecs for the x/dkg query messages the SDK consumes.
 *
 * Schemas mirror story/client/proto/story/dkg/v1/types/{query,types}.proto.
 * Only fields the SDK reads are decoded; unknown fields are skipped.
 */

import { Reader, Writer } from "./protobuf.js";

// ---------------------------------------------------------------------------
// Decoded shapes
// ---------------------------------------------------------------------------

export interface DKGNetwork {
  round: number;
  startBlockHeight: bigint;
  startBlockHash: Uint8Array;
  activeValSet: string[];
  total: number;
  threshold: number;
  stage: number;
  isResharing: boolean;
  globalPublicKey: Uint8Array;
  publicCoeffs: Uint8Array[];
  isUpgrade: boolean;
}

export interface DKGRegistration {
  round: number;
  validatorAddr: string;
  index: number;
  dkgPubKey: Uint8Array;
  commPubKey: Uint8Array;
  pubKeyShare: Uint8Array;
  enclaveReport: Uint8Array;
  status: number;
  codeCommitment: Uint8Array;
  enclaveType: Uint8Array;
}

/**
 * As stored by the x/dkg keeper. Note: the keeper does NOT persist the
 * TEE signature or requester_pub_key — those are verified on ingress
 * (see story/client/x/dkg/keeper/dkg_handler.go:PartialDecryptionSubmitted)
 * and dropped before storage.
 */
export interface DKGPartialDecryptionSubmission {
  validator: string;
  round: number;
  pid: number;
  encryptedPartial: Uint8Array;
  ephemeralPubKey: Uint8Array;
  pubShare: Uint8Array;
  label: Uint8Array;
  ciphertext: Uint8Array;
}

export interface DKGPartialDecryptionSubmissionsByRound {
  round: number;
  submissions: DKGPartialDecryptionSubmission[];
  ciphertext: Uint8Array;
  threshold: number;
  thresholdMet: boolean;
}

// ---------------------------------------------------------------------------
// Decoders
// ---------------------------------------------------------------------------

export function decodeDKGNetwork(bytes: Uint8Array): DKGNetwork {
  const r = new Reader(bytes);
  const out: DKGNetwork = {
    round: 0,
    startBlockHeight: 0n,
    startBlockHash: new Uint8Array(),
    activeValSet: [],
    total: 0,
    threshold: 0,
    stage: 0,
    isResharing: false,
    globalPublicKey: new Uint8Array(),
    publicCoeffs: [],
    isUpgrade: false,
  };
  while (!r.eof) {
    const { field, wireType } = r.readTag();
    switch (field) {
      case 1: out.round = r.readUint32(); break;
      case 2: out.startBlockHeight = r.readInt64(); break;
      case 3: out.startBlockHash = copy(r.readLenDelim()); break;
      case 4: out.activeValSet.push(r.readString()); break;
      case 5: out.total = r.readUint32(); break;
      case 6: out.threshold = r.readUint32(); break;
      case 7: out.stage = r.readUint32(); break;
      case 8: out.isResharing = r.readBool(); break;
      case 9: out.globalPublicKey = copy(r.readLenDelim()); break;
      case 10: out.publicCoeffs.push(copy(r.readLenDelim())); break;
      case 11: out.isUpgrade = r.readBool(); break;
      default: r.skipField(wireType);
    }
  }
  return out;
}

export function decodeDKGRegistration(bytes: Uint8Array): DKGRegistration {
  const r = new Reader(bytes);
  const out: DKGRegistration = {
    round: 0,
    validatorAddr: "",
    index: 0,
    dkgPubKey: new Uint8Array(),
    commPubKey: new Uint8Array(),
    pubKeyShare: new Uint8Array(),
    enclaveReport: new Uint8Array(),
    status: 0,
    codeCommitment: new Uint8Array(),
    enclaveType: new Uint8Array(),
  };
  while (!r.eof) {
    const { field, wireType } = r.readTag();
    switch (field) {
      case 1: out.round = r.readUint32(); break;
      case 2: out.validatorAddr = r.readString(); break;
      case 3: out.index = r.readUint32(); break;
      case 4: out.dkgPubKey = copy(r.readLenDelim()); break;
      case 5: out.commPubKey = copy(r.readLenDelim()); break;
      case 6: out.pubKeyShare = copy(r.readLenDelim()); break;
      case 7: out.enclaveReport = copy(r.readLenDelim()); break;
      case 8: out.status = r.readUint32(); break;
      case 9: out.codeCommitment = copy(r.readLenDelim()); break;
      case 10: out.enclaveType = copy(r.readLenDelim()); break;
      default: r.skipField(wireType);
    }
  }
  return out;
}

export function decodePartialDecryptionSubmission(
  bytes: Uint8Array,
): DKGPartialDecryptionSubmission {
  const r = new Reader(bytes);
  const out: DKGPartialDecryptionSubmission = {
    validator: "",
    round: 0,
    pid: 0,
    encryptedPartial: new Uint8Array(),
    ephemeralPubKey: new Uint8Array(),
    pubShare: new Uint8Array(),
    label: new Uint8Array(),
    ciphertext: new Uint8Array(),
  };
  while (!r.eof) {
    const { field, wireType } = r.readTag();
    switch (field) {
      case 1: out.validator = r.readString(); break;
      case 2: out.round = r.readUint32(); break;
      case 3: out.pid = r.readUint32(); break;
      case 4: out.encryptedPartial = copy(r.readLenDelim()); break;
      case 5: out.ephemeralPubKey = copy(r.readLenDelim()); break;
      case 6: out.pubShare = copy(r.readLenDelim()); break;
      case 7: out.label = copy(r.readLenDelim()); break;
      case 8: out.ciphertext = copy(r.readLenDelim()); break;
      default: r.skipField(wireType);
    }
  }
  return out;
}

export function decodePartialsByRound(
  bytes: Uint8Array,
): DKGPartialDecryptionSubmissionsByRound {
  const r = new Reader(bytes);
  const out: DKGPartialDecryptionSubmissionsByRound = {
    round: 0,
    submissions: [],
    ciphertext: new Uint8Array(),
    threshold: 0,
    thresholdMet: false,
  };
  while (!r.eof) {
    const { field, wireType } = r.readTag();
    switch (field) {
      case 1: out.round = r.readUint32(); break;
      case 2: out.submissions.push(decodePartialDecryptionSubmission(r.readLenDelim())); break;
      case 3: out.ciphertext = copy(r.readLenDelim()); break;
      case 4: out.threshold = r.readUint32(); break;
      case 5: out.thresholdMet = r.readBool(); break;
      default: r.skipField(wireType);
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// Response envelope decoders
// ---------------------------------------------------------------------------

/** QueryGetLatestActiveDKGNetworkResponse { DKGNetwork network = 1; } */
export function decodeLatestActiveResponse(bytes: Uint8Array): DKGNetwork {
  const r = new Reader(bytes);
  let network: DKGNetwork | null = null;
  while (!r.eof) {
    const { field, wireType } = r.readTag();
    if (field === 1 && wireType === 2) {
      network = decodeDKGNetwork(r.readLenDelim());
    } else {
      r.skipField(wireType);
    }
  }
  if (!network) throw new Error("latest_active: missing network field");
  return network;
}

/** QueryGetAllVerifiedDKGRegistrationsResponse { repeated DKGRegistration registrations = 1; } */
export function decodeVerifiedRegistrationsResponse(
  bytes: Uint8Array,
): DKGRegistration[] {
  const r = new Reader(bytes);
  const out: DKGRegistration[] = [];
  while (!r.eof) {
    const { field, wireType } = r.readTag();
    if (field === 1 && wireType === 2) {
      out.push(decodeDKGRegistration(r.readLenDelim()));
    } else {
      r.skipField(wireType);
    }
  }
  return out;
}

/** QueryGetCDRPartialsResponse { repeated DKGPartialDecryptionSubmissionsByRound submissions = 1; } */
export function decodeCDRPartialsResponse(
  bytes: Uint8Array,
): DKGPartialDecryptionSubmissionsByRound[] {
  const r = new Reader(bytes);
  const out: DKGPartialDecryptionSubmissionsByRound[] = [];
  while (!r.eof) {
    const { field, wireType } = r.readTag();
    if (field === 1 && wireType === 2) {
      out.push(decodePartialsByRound(r.readLenDelim()));
    } else {
      r.skipField(wireType);
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// Request encoders
// ---------------------------------------------------------------------------

/** QueryGetLatestActiveDKGNetworkRequest (empty) */
export function encodeLatestActiveRequest(): Uint8Array {
  return new Uint8Array();
}

/** QueryGetAllVerifiedDKGRegistrationsRequest { uint32 round = 1; string code_commitment_hex = 2; } */
export function encodeVerifiedRegistrationsRequest(
  round: number,
  codeCommitmentHex: string,
): Uint8Array {
  return new Writer()
    .writeUint32(1, round)
    .writeString(2, codeCommitmentHex)
    .finish();
}

/** QueryGetCDRPartialsRequest { uint32 uuid = 1; string requester_pub_key_hex = 2; } */
export function encodeCDRPartialsRequest(
  uuid: number,
  requesterPubKeyHex: string,
): Uint8Array {
  return new Writer()
    .writeUint32(1, uuid)
    .writeString(2, requesterPubKeyHex)
    .finish();
}

// ---------------------------------------------------------------------------
// Encoders used only by tests to produce golden response bytes.
// ---------------------------------------------------------------------------

export function encodeDKGNetwork(n: DKGNetwork): Uint8Array {
  const w = new Writer()
    .writeUint32(1, n.round)
    .writeBytes(3, n.startBlockHash);
  // startBlockHeight (int64, field 2) — emit only if nonzero
  if (n.startBlockHeight !== 0n) {
    w.writeTag(2, 0).writeVarint(n.startBlockHeight);
  }
  for (const v of n.activeValSet) w.writeString(4, v);
  w.writeUint32(5, n.total)
    .writeUint32(6, n.threshold)
    .writeUint32(7, n.stage)
    .writeBool(8, n.isResharing)
    .writeBytes(9, n.globalPublicKey);
  for (const pc of n.publicCoeffs) w.writeBytes(10, pc);
  w.writeBool(11, n.isUpgrade);
  return w.finish();
}

export function encodeDKGRegistration(reg: DKGRegistration): Uint8Array {
  return new Writer()
    .writeUint32(1, reg.round)
    .writeString(2, reg.validatorAddr)
    .writeUint32(3, reg.index)
    .writeBytes(4, reg.dkgPubKey)
    .writeBytes(5, reg.commPubKey)
    .writeBytes(6, reg.pubKeyShare)
    .writeBytes(7, reg.enclaveReport)
    .writeUint32(8, reg.status)
    .writeBytes(9, reg.codeCommitment)
    .writeBytes(10, reg.enclaveType)
    .finish();
}

export function encodePartialDecryptionSubmission(
  s: DKGPartialDecryptionSubmission,
): Uint8Array {
  return new Writer()
    .writeString(1, s.validator)
    .writeUint32(2, s.round)
    .writeUint32(3, s.pid)
    .writeBytes(4, s.encryptedPartial)
    .writeBytes(5, s.ephemeralPubKey)
    .writeBytes(6, s.pubShare)
    .writeBytes(7, s.label)
    .writeBytes(8, s.ciphertext)
    .finish();
}

export function encodePartialsByRound(
  p: DKGPartialDecryptionSubmissionsByRound,
): Uint8Array {
  const w = new Writer().writeUint32(1, p.round);
  for (const s of p.submissions) {
    w.writeMessage(2, encodePartialDecryptionSubmission(s));
  }
  w.writeBytes(3, p.ciphertext)
    .writeUint32(4, p.threshold)
    .writeBool(5, p.thresholdMet);
  return w.finish();
}

export function encodeLatestActiveResponse(n: DKGNetwork): Uint8Array {
  return new Writer().writeMessage(1, encodeDKGNetwork(n)).finish();
}

export function encodeVerifiedRegistrationsResponse(
  regs: DKGRegistration[],
): Uint8Array {
  const w = new Writer();
  for (const reg of regs) w.writeMessage(1, encodeDKGRegistration(reg));
  return w.finish();
}

export function encodeCDRPartialsResponse(
  rounds: DKGPartialDecryptionSubmissionsByRound[],
): Uint8Array {
  const w = new Writer();
  for (const p of rounds) w.writeMessage(1, encodePartialsByRound(p));
  return w.finish();
}

// ---------------------------------------------------------------------------

function copy(view: Uint8Array): Uint8Array {
  return new Uint8Array(view);
}
