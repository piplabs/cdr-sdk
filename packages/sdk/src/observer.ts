import {
  getAbiItem,
  parseEventLogs,
  toBytes,
  type Log,
  type PublicClient,
} from "viem";
import { cdrAbi, dkgAbi, contractAddresses, type Network } from "@piplabs/cdr-contracts";
import { CURVE_ED25519 } from "@piplabs/cdr-crypto";
import type { Vault } from "./types.js";

// ---------------------------------------------------------------------------
// Response shapes from /api/dkg/*
// ---------------------------------------------------------------------------

interface DKGNetworkJSON {
  round: number;
  startBlockHeight: string;
  activeValSet: string[];
  total: number;
  threshold: number;
  stage: number;
  isResharing: boolean;
  globalPublicKeyHex: string;
  publicCoeffsHex: string[];
  isUpgrade: boolean;
}

interface DKGRegistrationJSON {
  round: number;
  validatorAddr: string;
  index: number;
  commPubKeyHex: string;
  pubKeyShareHex: string;
  status: number;
  codeCommitmentHex: string;
}

// ---------------------------------------------------------------------------

/**
 * Observer queries CDR contract state (EVM) and the x/dkg module state
 * (Cosmos, via the demo's Next.js /api/dkg routes which use CometBFT's
 * abci_query under the hood).
 */
export class Observer {
  /** Many RPCs reject or time out on wide eth_getLogs ranges; chunk to stay under typical caps. */
  private static readonly DKG_LOGS_BLOCK_CHUNK = 8192n;

  /** Default lookback window: ~7 days at ~2 s/block. Avoids scanning from block 0 on long chains. */
  private static readonly DEFAULT_LOOKBACK_BLOCKS = 302_400n;

  private publicClient: PublicClient;
  private network: Network;
  private apiBase: string;
  private minThresholdRatio?: number;

  constructor(params: {
    network: Network;
    publicClient: PublicClient;
    /**
     * Base path for the demo's DKG API routes. Defaults to "/api/dkg" which
     * works for browser-origin requests. Can be overridden with an absolute
     * URL when calling from a Node.js environment (tests, server scripts).
     */
    apiBase?: string;
    /** Minimum threshold ratio override (0-1). Applied on top of the API-reported threshold. */
    minThresholdRatio?: number;
  }) {
    this.publicClient = params.publicClient;
    this.network = params.network;
    this.apiBase = params.apiBase ?? "/api/dkg";
    this.minThresholdRatio = params.minThresholdRatio;
  }

  // -----------------------------------------------------------------------
  // Internal: /api/dkg fetch helpers
  // -----------------------------------------------------------------------

  private async fetchJSON<T>(path: string): Promise<T> {
    const url = `${this.apiBase}/${path}`;
    const resp = await fetch(url, { headers: { Accept: "application/json" } });
    if (!resp.ok) {
      const text = await resp.text().catch(() => "");
      throw new Error(`${url} → HTTP ${resp.status}: ${text || resp.statusText}`);
    }
    return (await resp.json()) as T;
  }

  private async getLatestActiveNetwork(): Promise<DKGNetworkJSON> {
    const { network } = await this.fetchJSON<{ network: DKGNetworkJSON }>(
      "latest_active",
    );
    return network;
  }

  // -----------------------------------------------------------------------
  // CDR contract reads (EVM contract state, not events)
  // -----------------------------------------------------------------------

  /**
   * Get a vault's details by UUID.
   * @example
   * ```ts
   * const vault = await observer.getVault(42);
   * console.log(vault.readConditionAddr);
   * ```
   */
  async getVault(uuid: number): Promise<Vault> {
    const result = await this.publicClient.readContract({
      address: contractAddresses[this.network].cdr,
      abi: cdrAbi,
      functionName: "vaults",
      args: [uuid],
    });
    return { uuid, ...result } as unknown as Vault;
  }

  /**
   * Get current allocation fee.
   * @example
   * ```ts
   * const fee = await observer.getAllocateFee();
   * ```
   */
  async getAllocateFee(): Promise<bigint> {
    return this.publicClient.readContract({
      address: contractAddresses[this.network].cdr,
      abi: cdrAbi,
      functionName: "allocateFee",
    });
  }

  /**
   * Get current write fee.
   * @example
   * ```ts
   * const fee = await observer.getWriteFee();
   * ```
   */
  async getWriteFee(): Promise<bigint> {
    return this.publicClient.readContract({
      address: contractAddresses[this.network].cdr,
      abi: cdrAbi,
      functionName: "writeFee",
    });
  }

  /**
   * Get current read fee.
   * @example
   * ```ts
   * const fee = await observer.getReadFee();
   * ```
   */
  async getReadFee(): Promise<bigint> {
    return this.publicClient.readContract({
      address: contractAddresses[this.network].cdr,
      abi: cdrAbi,
      functionName: "readFee",
    });
  }

  /**
   * Get the maximum allowed encrypted data size for vault writes.
   * @example
   * ```ts
   * const maxSize = await observer.getMaxEncryptedDataSize();
   * ```
   */
  async getMaxEncryptedDataSize(): Promise<bigint> {
    return this.publicClient.readContract({
      address: contractAddresses[this.network].cdr,
      abi: cdrAbi,
      functionName: "maxEncryptedDataSize",
    });
  }

  /**
   * Get DKG operational threshold (basis-points constant from the DKG contract).
   * @example
   * ```ts
   * const threshold = await observer.getOperationalThreshold();
   * ```
   */
  async getOperationalThreshold(): Promise<bigint> {
    return this.publicClient.readContract({
      address: contractAddresses[this.network].dkg,
      abi: dkgAbi,
      functionName: "operationalThreshold",
    });
  }

  // -----------------------------------------------------------------------
  // DKG queries — backed by x/dkg keeper via CometBFT abci_query
  // -----------------------------------------------------------------------

  /**
   * Get the DKG global public key from the latest active network.
   * Returns the raw bytes of the globalPubKey (Ed25519 point with curve-code prefix).
   * @example
   * ```ts
   * const globalPubKey = await observer.getGlobalPubKey();
   * ```
   */
  async getGlobalPubKey(): Promise<Uint8Array> {
    const network = await this.getLatestActiveNetwork();
    const rawPoint = hexToBytes(network.globalPublicKeyHex);

    // The keeper stores a raw 32-byte Ed25519 point. The WASM TDH2 functions
    // expect a 2-byte curve-code prefix (0x043f for Ed25519).
    if (rawPoint.length === 32) {
      const prefixed = new Uint8Array(34);
      prefixed[0] = (CURVE_ED25519 >> 8) & 0xff; // 0x04
      prefixed[1] = CURVE_ED25519 & 0xff;         // 0x3f
      prefixed.set(rawPoint, 2);
      return prefixed;
    }

    return rawPoint;
  }

  /**
   * Number of participants in the latest active DKG round.
   * @example
   * ```ts
   * const count = await observer.getParticipantCount();
   * ```
   */
  async getParticipantCount(): Promise<number> {
    const network = await this.getLatestActiveNetwork();
    return network.total;
  }

  /**
   * Minimum number of partial decryptions required to combine a plaintext.
   * Reads directly from the DKG network state rather than recomputing from
   * `operational_threshold`. If `minThresholdRatio` was set on the Observer,
   * returns max(API threshold, ceil(participants * minThresholdRatio)).
   * @example
   * ```ts
   * const threshold = await observer.getThreshold();
   * ```
   */
  async getThreshold(): Promise<number> {
    const network = await this.getLatestActiveNetwork();
    if (this.minThresholdRatio !== undefined) {
      const overrideThreshold = Math.ceil(network.total * this.minThresholdRatio);
      return Math.max(network.threshold, overrideThreshold);
    }
    return network.threshold;
  }

  /**
   * Map of validator address (lowercase) → commPubKey bytes, from verified
   * DKG registrations. The commPubKey is the uncompressed secp256k1 public
   * key used by the validator's TEE to sign partial decryption responses.
   *
   * @example
   * ```ts
   * const validators = await observer.getRegisteredValidators();
   * for (const [addr, commKey] of validators) {
   *   console.log(addr, commKey.length);
   * }
   * ```
   */
  async getRegisteredValidators(params?: {
    round?: number;
    codeCommitmentHex?: string;
  }): Promise<Map<string, Uint8Array>> {
    let round = params?.round;
    const codeCommitmentHex = params?.codeCommitmentHex ?? "";
    if (round === undefined) {
      round = (await this.getLatestActiveNetwork()).round;
    }

    const search = new URLSearchParams({
      round: String(round),
      code_commitment_hex: codeCommitmentHex,
    });
    const { registrations } = await this.fetchJSON<{
      registrations: DKGRegistrationJSON[];
    }>(`verified_registrations?${search.toString()}`);

    const validators = new Map<string, Uint8Array>();
    for (const reg of registrations) {
      validators.set(reg.validatorAddr.toLowerCase(), hexToBytes(reg.commPubKeyHex));
    }
    return validators;
  }

  // -----------------------------------------------------------------------
  // Validator attestations — sourced from EVM DKG Registered events, since
  // the cosmos /api/dkg endpoint does not expose raw SGX quotes.
  // -----------------------------------------------------------------------

  /**
   * Fetch DKG logs for a single event type in block chunks (avoids RPC range / size limits).
   */
  private async fetchDkgEventLogs(
    client: PublicClient,
    eventName: "Registered",
    fromBlock: bigint,
    toBlock: bigint,
  ): Promise<Log[]> {
    const dkgAddress = contractAddresses[this.network].dkg;
    const event = getAbiItem({ abi: dkgAbi, name: eventName });
    const chunk = Observer.DKG_LOGS_BLOCK_CHUNK;
    const logs: Log[] = [];
    let start = fromBlock;

    while (start <= toBlock) {
      const end = start + chunk - 1n <= toBlock ? start + chunk - 1n : toBlock;
      const chunkLogs = await client.getLogs({
        address: dkgAddress,
        event,
        fromBlock: start,
        toBlock: end,
      });
      logs.push(...chunkLogs);
      start = end + 1n;
    }

    return logs;
  }

  /**
   * Get validator attestation reports (raw SGX quotes) from DKG Registered events.
   * Returns a map of validator address → enclaveReport bytes (most recent per validator).
   *
   * Use with `verifyAttestation()` to verify each validator's TEE enclave
   * before trusting their partial decryptions.
   *
   * @example
   * ```ts
   * import { verifyAttestation } from "@piplabs/cdr-sdk";
   * const attestations = await observer.getValidatorAttestations();
   * for (const [addr, report] of attestations) {
   *   const result = await verifyAttestation(report, { expectedMrEnclave: "0x..." });
   *   console.log(addr, result.valid);
   * }
   * ```
   */
  async getValidatorAttestations(params?: {
    fromBlock?: bigint;
    round?: number;
  }): Promise<Map<string, Uint8Array>> {
    const toBlock = await this.publicClient.getBlockNumber();
    const fromBlock = params?.fromBlock ??
      (toBlock > Observer.DEFAULT_LOOKBACK_BLOCKS
        ? toBlock - Observer.DEFAULT_LOOKBACK_BLOCKS
        : 0n);

    const rawLogs = await this.fetchDkgEventLogs(
      this.publicClient,
      "Registered",
      fromBlock,
      toBlock,
    );

    const parsed = parseEventLogs({
      abi: dkgAbi,
      logs: rawLogs,
      eventName: "Registered",
    });

    const attestations = new Map<string, Uint8Array>();
    for (const log of parsed) {
      if (params?.round !== undefined && log.args.round !== params.round) {
        continue;
      }
      const addr = log.args.validatorAddr.toLowerCase() as `0x${string}`;
      attestations.set(addr, toBytes(log.args.enclaveReport));
    }

    // Fallback: if lookback window found nothing and the caller did NOT
    // explicitly provide fromBlock, scan from block 0.
    if (attestations.size === 0 && !params?.fromBlock && fromBlock > 0n) {
      return this.getValidatorAttestations({ fromBlock: 0n, round: params?.round });
    }

    return attestations;
  }
}

// ---------------------------------------------------------------------------

function hexToBytes(hex: string): Uint8Array {
  const clean = hex.startsWith("0x") ? hex.slice(2) : hex;
  if (clean.length === 0) return new Uint8Array();
  if (clean.length % 2 !== 0) throw new Error(`invalid hex length: ${clean.length}`);
  const out = new Uint8Array(clean.length / 2);
  for (let i = 0; i < out.length; i++) {
    out[i] = parseInt(clean.substring(i * 2, i * 2 + 2), 16);
  }
  return out;
}
