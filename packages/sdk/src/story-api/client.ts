/**
 * Story-API REST client — 6 wrappers around /dkg/* endpoints.
 *
 *   /dkg/latest_active                  → queryLatestActiveDKGNetwork
 *   /dkg/dkg_network?round=N            → queryDKGNetwork
 *   /dkg/global_public_key              → queryGlobalPubKey
 *   /dkg/registrations?round=N          → queryAllRegistrations
 *   /dkg/registrations/verified?round=N → queryVerifiedRegistrations
 *   /dkg/cdr_partials                   → queryCDRPartials
 */

import { hexToBytes } from "./bytes.js";
import {
  decodeDKGNetwork,
  decodeDKGRegistration,
  decodeSubmissionsByRound,
  type RawDKGNetwork,
  type RawDKGRegistration,
  type RawSubmissionsByRound,
} from "./decoders.js";
import { StoryApiNotFoundError } from "./errors.js";
import { fetchJSON, joinPath, type QueryOptions } from "./transport.js";
import type {
  DKGNetwork,
  DKGRegistration,
  DKGPartialDecryptionSubmissionsByRound,
} from "./types.js";

export type { QueryOptions } from "./transport.js";

/** GET /dkg/latest_active — current active DKG network. */
export async function queryLatestActiveDKGNetwork(opts: QueryOptions): Promise<DKGNetwork> {
  const url = joinPath(opts.apiUrl, "/dkg/latest_active");
  const msg = await fetchJSON<{ network: RawDKGNetwork }>(url, opts);
  return decodeDKGNetwork(msg.network);
}

/** GET /dkg/dkg_network?round=N — historical DKG network for a specific round. */
export async function queryDKGNetwork(
  opts: QueryOptions & { round: number },
): Promise<DKGNetwork> {
  const url = joinPath(opts.apiUrl, `/dkg/dkg_network?round=${opts.round}`);
  const msg = await fetchJSON<{ network: RawDKGNetwork }>(url, opts);
  return decodeDKGNetwork(msg.network);
}

/** GET /dkg/global_public_key — TDH2 group public key. */
export async function queryGlobalPubKey(opts: QueryOptions): Promise<Uint8Array> {
  const url = joinPath(opts.apiUrl, "/dkg/global_public_key");
  const msg = await fetchJSON<{ public_key: string }>(url, opts);
  return hexToBytes(msg.public_key);
}

/**
 * GET /dkg/registrations?round=N — all registrations for the round
 * (any status). Use when you need commPubKeys for finalized rounds.
 * Returns `[]` on 404.
 */
export async function queryAllRegistrations(
  opts: QueryOptions & { round: number },
): Promise<DKGRegistration[]> {
  const url = joinPath(opts.apiUrl, `/dkg/registrations?round=${opts.round}`);
  try {
    const msg = await fetchJSON<{ registrations: RawDKGRegistration[] }>(url, opts);
    return (msg.registrations ?? []).map(decodeDKGRegistration);
  } catch (err) {
    if (err instanceof StoryApiNotFoundError) return [];
    throw err;
  }
}

/**
 * GET /dkg/registrations/verified?round=N — only `Verified`-status entries.
 *
 * ⚠️ Caveat: this endpoint is empty for most usable rounds. `Verified`
 * (status=1) is only a transient state during the Dealing stage; once a round
 * reaches Active or Ended, the keeper has transitioned all entries to
 * `Finalized` (status=2), and this endpoint returns `null`/`[]`. Verified
 * empirically against DevNet on 2026-04-28: for the currently-active round 4
 * `/registrations` returned 3 entries with `status=[2,2,2]` while
 * `/registrations/verified` returned `null`.
 *
 * For most callers, prefer {@link queryAllRegistrations} and filter on the
 * SDK side by `status === 2` (Finalized).
 */
export async function queryVerifiedRegistrations(
  opts: QueryOptions & { round: number },
): Promise<DKGRegistration[]> {
  const url = joinPath(opts.apiUrl, `/dkg/registrations/verified?round=${opts.round}`);
  try {
    const msg = await fetchJSON<{ registrations: RawDKGRegistration[] }>(url, opts);
    return (msg.registrations ?? []).map(decodeDKGRegistration);
  } catch (err) {
    if (err instanceof StoryApiNotFoundError) return [];
    throw err;
  }
}

/**
 * GET /dkg/cdr_partials — partial-decryption submissions for
 * `(uuid, requesterPubKey)`, grouped by round. Safe to poll: returns `[]`
 * when no partials yet.
 *
 * `requesterPubKeyHex` is the uncompressed secp256k1 public key in hex
 * (130 chars, with or without `0x` prefix).
 */
export async function queryCDRPartials(
  opts: QueryOptions & { uuid: number; requesterPubKeyHex: string },
): Promise<DKGPartialDecryptionSubmissionsByRound[]> {
  const hex = opts.requesterPubKeyHex.startsWith("0x") || opts.requesterPubKeyHex.startsWith("0X")
    ? opts.requesterPubKeyHex.slice(2)
    : opts.requesterPubKeyHex;
  const url = joinPath(
    opts.apiUrl,
    `/dkg/cdr_partials?uuid=${opts.uuid}&requester_pub_key_hex=${hex}`,
  );
  try {
    const msg = await fetchJSON<{ submissions: RawSubmissionsByRound[] }>(url, opts);
    return (msg.submissions ?? []).map(decodeSubmissionsByRound);
  } catch (err) {
    if (err instanceof StoryApiNotFoundError) return [];
    throw err;
  }
}
