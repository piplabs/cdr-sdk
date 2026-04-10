/**
 * CometBFT abci_query client for the x/dkg module.
 *
 * story nodes expose x/dkg's gRPC query service but don't run a full
 * gRPC-gateway REST API. CometBFT RPC (port 26657 by default) lets us invoke
 * any registered gRPC query method by sending a protobuf-encoded request as
 * the `data` field and decoding the protobuf response.
 */

import { base64ToBytes } from "./protobuf.js";
import {
  type DKGNetwork,
  type DKGRegistration,
  type DKGPartialDecryptionSubmissionsByRound,
  decodeCDRPartialsResponse,
  decodeLatestActiveResponse,
  decodeVerifiedRegistrationsResponse,
  encodeCDRPartialsRequest,
  encodeLatestActiveRequest,
  encodeVerifiedRegistrationsRequest,
} from "./dkg-proto.js";

interface AbciResponse {
  code: number;
  log: string;
  value: string | null;
}

interface AbciEnvelope {
  jsonrpc: string;
  result?: { response: AbciResponse };
  error?: { code: number; message: string; data?: string };
}

/**
 * Send an abci_query to CometBFT and return the raw response value.
 *
 * @param rpcUrl  CometBFT RPC base URL, e.g. "http://node:26657"
 * @param path    Full gRPC method path, e.g. "/story.dkg.v1.types.Query/GetLatestActiveDKGNetwork"
 * @param data    Protobuf-encoded request bytes (empty for empty messages)
 */
export async function abciQuery(
  rpcUrl: string,
  path: string,
  data: Uint8Array,
): Promise<Uint8Array> {
  const hex = data.length === 0
    ? "0x"
    : "0x" + Array.from(data, (b) => b.toString(16).padStart(2, "0")).join("");

  const base = rpcUrl.replace(/\/+$/, "");
  const url = `${base}/abci_query?path=${encodeURIComponent(`"${path}"`)}&data=${hex}`;

  const resp = await fetch(url, { headers: { Accept: "application/json" } });
  if (!resp.ok) {
    throw new Error(`abci_query HTTP ${resp.status}: ${resp.statusText}`);
  }
  const env = (await resp.json()) as AbciEnvelope;
  if (env.error) {
    throw new Error(`abci_query RPC error: ${env.error.message}`);
  }
  if (!env.result) {
    throw new Error("abci_query: empty result");
  }
  const r = env.result.response;
  if (r.code !== 0) {
    throw new Error(`abci_query ${path}: code=${r.code} log=${r.log}`);
  }
  if (!r.value) {
    return new Uint8Array();
  }
  return base64ToBytes(r.value);
}

const SERVICE = "/story.dkg.v1.types.Query";

export async function queryLatestActiveDKGNetwork(
  rpcUrl: string,
): Promise<DKGNetwork> {
  const bytes = await abciQuery(
    rpcUrl,
    `${SERVICE}/GetLatestActiveDKGNetwork`,
    encodeLatestActiveRequest(),
  );
  return decodeLatestActiveResponse(bytes);
}

export async function queryVerifiedRegistrations(
  rpcUrl: string,
  round: number,
  codeCommitmentHex = "",
): Promise<DKGRegistration[]> {
  const bytes = await abciQuery(
    rpcUrl,
    `${SERVICE}/GetAllVerifiedDKGRegistrations`,
    encodeVerifiedRegistrationsRequest(round, codeCommitmentHex),
  );
  return decodeVerifiedRegistrationsResponse(bytes);
}

/**
 * Query all stored partial decryption submissions for a (uuid, requester) pair.
 *
 * The keeper returns NotFound when there are no submissions yet; this is
 * surfaced as an empty array so pollers can simply retry.
 */
export async function queryCDRPartials(
  rpcUrl: string,
  uuid: number,
  requesterPubKeyHex: string,
): Promise<DKGPartialDecryptionSubmissionsByRound[]> {
  const hex = requesterPubKeyHex.replace(/^0x/i, "");
  try {
    const bytes = await abciQuery(
      rpcUrl,
      `${SERVICE}/GetCDRPartials`,
      encodeCDRPartialsRequest(uuid, hex),
    );
    return decodeCDRPartialsResponse(bytes);
  } catch (e) {
    if (e instanceof Error && /not found/i.test(e.message)) return [];
    throw e;
  }
}
