import {
  getAbiItem,
  parseEventLogs,
  toBytes,
  toHex,
  type Log,
  type PublicClient,
} from "viem";
import { cdrAbi, dkgAbi, contractAddresses, type Network } from "@piplabs/cdr-contracts";
import { CURVE_ED25519 } from "@piplabs/cdr-crypto";
import type { Vault } from "./types.js";
import { RpcConsensusError } from "./errors.js";
import {
  queryLatestActiveDKGNetwork,
  queryVerifiedRegistrations,
} from "./cosmos/abci-query.js";
import type { DKGNetwork } from "./cosmos/dkg-proto.js";

/**
 * Which backend to use for DKG queries.
 *
 * - `evm-events`: scan DKG contract Finalized/Registered events via the
 *   provided publicClient. Works against any EVM RPC.
 * - `cosmos-abci`: query the x/dkg keeper directly via CometBFT abci_query
 *   (port 26657). Avoids wide eth_getLogs ranges and requires only one
 *   non-EVM endpoint.
 */
export type DkgSource = "evm-events" | "cosmos-abci";

// ---------------------------------------------------------------------------

/**
 * Observer queries CDR contract state (EVM) and DKG module state.
 *
 * DKG state can come from two sources, selected via the `dkgSource` option:
 *   - `evm-events` (default): scans DKG contract events via viem
 *   - `cosmos-abci`: queries the x/dkg keeper via CometBFT abci_query
 *
 * CDR reads (vault, fees, maxEncryptedDataSize) and validator attestation
 * reports always come from EVM — the x/dkg keeper does not expose SGX quotes.
 */
export class Observer {
  /** Many RPCs reject or time out on wide eth_getLogs ranges; chunk to stay under typical caps. */
  private static readonly DKG_LOGS_BLOCK_CHUNK = 8192n;

  /** Default lookback window: ~7 days at ~2 s/block. Avoids scanning from block 0 on long chains. */
  private static readonly DEFAULT_LOOKBACK_BLOCKS = 302_400n;

  private publicClient: PublicClient;
  private network: Network;
  readonly dkgSource: DkgSource;
  readonly cometRpcUrl: string | undefined;
  private minThresholdRatio?: number;
  private validationClients?: PublicClient[];

  constructor(params: {
    network: Network;
    publicClient: PublicClient;
    /** DKG query backend. Defaults to `"evm-events"`. */
    dkgSource?: DkgSource;
    /**
     * CometBFT RPC base URL (e.g. `"http://node:26657"`). Required when
     * `dkgSource === "cosmos-abci"`.
     */
    cometRpcUrl?: string;
    /** Minimum threshold ratio override (0-1). */
    minThresholdRatio?: number;
    /** Additional RPC clients for cross-validating critical on-chain reads (evm-events mode only). */
    validationClients?: PublicClient[];
  }) {
    this.publicClient = params.publicClient;
    this.network = params.network;
    this.dkgSource = params.dkgSource ?? "evm-events";
    this.cometRpcUrl = params.cometRpcUrl;
    this.minThresholdRatio = params.minThresholdRatio;
    this.validationClients = params.validationClients;

    if (this.dkgSource === "cosmos-abci" && !this.cometRpcUrl) {
      throw new Error(
        'Observer: cometRpcUrl is required when dkgSource is "cosmos-abci"',
      );
    }
  }

  // =======================================================================
  // CDR contract reads (always EVM)
  // =======================================================================

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

  /** Get current allocation fee. */
  async getAllocateFee(): Promise<bigint> {
    return this.publicClient.readContract({
      address: contractAddresses[this.network].cdr,
      abi: cdrAbi,
      functionName: "allocateFee",
    });
  }

  /** Get current write fee. */
  async getWriteFee(): Promise<bigint> {
    return this.publicClient.readContract({
      address: contractAddresses[this.network].cdr,
      abi: cdrAbi,
      functionName: "writeFee",
    });
  }

  /** Get current read fee. */
  async getReadFee(): Promise<bigint> {
    return this.publicClient.readContract({
      address: contractAddresses[this.network].cdr,
      abi: cdrAbi,
      functionName: "readFee",
    });
  }

  /** Get the maximum allowed encrypted data size for vault writes. */
  async getMaxEncryptedDataSize(): Promise<bigint> {
    return this.publicClient.readContract({
      address: contractAddresses[this.network].cdr,
      abi: cdrAbi,
      functionName: "maxEncryptedDataSize",
    });
  }

  /** Get DKG operational threshold (basis-points constant from the DKG contract). */
  async getOperationalThreshold(): Promise<bigint> {
    return this.publicClient.readContract({
      address: contractAddresses[this.network].dkg,
      abi: dkgAbi,
      functionName: "operationalThreshold",
    });
  }

  // =======================================================================
  // DKG queries — dispatched to either EVM events or cosmos REST API
  // =======================================================================

  /**
   * Get the DKG global public key from the active round.
   * Returns the raw bytes of the globalPubKey (Ed25519 point with curve-code prefix).
   * @example
   * ```ts
   * const globalPubKey = await observer.getGlobalPubKey();
   * ```
   */
  async getGlobalPubKey(params?: { fromBlock?: bigint }): Promise<Uint8Array> {
    const rawPoint =
      this.dkgSource === "cosmos-abci"
        ? await this.getGlobalPubKeyFromCosmos()
        : await this.getGlobalPubKeyFromEvents(params);

    // Both sources return the raw 32-byte Ed25519 point. The WASM TDH2
    // functions expect a 2-byte curve-code prefix (0x043f for Ed25519).
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
   * Get the number of participants in the active DKG round.
   * @example
   * ```ts
   * const count = await observer.getParticipantCount();
   * ```
   */
  async getParticipantCount(params?: { fromBlock?: bigint }): Promise<number> {
    if (this.dkgSource === "cosmos-abci") {
      const network = await this.getLatestActiveNetwork();
      return network.total;
    }
    const parsed = await this.getFinalizedEvents(params);
    const { events } = await this.getActiveRound(parsed);
    return events.length;
  }

  /**
   * Get the absolute threshold (minimum number of partial decryptions needed).
   * - In `evm-events` mode: computes `ceil(participants * operationalThreshold / 1000)`.
   * - In `cosmos-abci` mode: reads `threshold` directly from DKG network state.
   * If `minThresholdRatio` was set, returns `max(sourceThreshold, ceil(participants * minThresholdRatio))`.
   */
  async getThreshold(params?: { fromBlock?: bigint }): Promise<number> {
    let sourceThreshold: number;
    let participantCount: number;

    if (this.dkgSource === "cosmos-abci") {
      const network = await this.getLatestActiveNetwork();
      sourceThreshold = network.threshold;
      participantCount = network.total;
    } else {
      const [operationalThreshold, count] = await Promise.all([
        this.getOperationalThreshold(),
        this.getParticipantCount(params),
      ]);
      participantCount = count;
      sourceThreshold = Math.ceil(
        participantCount * Number(operationalThreshold) / 1000,
      );
    }

    if (this.minThresholdRatio !== undefined) {
      const overrideThreshold = Math.ceil(participantCount * this.minThresholdRatio);
      return Math.max(sourceThreshold, overrideThreshold);
    }
    return sourceThreshold;
  }

  /**
   * Get a map of validator address → commPubKey bytes for the active round.
   * The commPubKey is the uncompressed secp256k1 public key used by the
   * validator's TEE to sign partial decryption responses.
   *
   * In `evm-events` mode, reads DKG `Registered` events; `fromBlock` controls
   * the lookback window and `round` filters events. In `cosmos-abci` mode,
   * queries the x/dkg keeper's GetAllVerifiedDKGRegistrations via abci_query;
   * `codeCommitmentHex` narrows the result to a specific enclave code commitment.
   */
  async getRegisteredValidators(params?: {
    fromBlock?: bigint;
    round?: number;
    codeCommitmentHex?: string;
  }): Promise<Map<string, Uint8Array>> {
    if (this.dkgSource === "cosmos-abci") {
      return this.getRegisteredValidatorsFromCosmos(params);
    }
    return this.getRegisteredValidatorsFromEvents(params);
  }

  // =======================================================================
  // Validator attestations — always EVM (cosmos API does not expose quotes)
  // =======================================================================

  /**
   * Get validator attestation reports (raw SGX quotes) from DKG Registered events.
   * Returns a map of validator address → enclaveReport bytes (most recent per validator).
   *
   * Use with `verifyAttestation()` to verify each validator's TEE enclave
   * before trusting their partial decryptions.
   *
   * Note: sourced from EVM events regardless of `dkgSource`, because the
   * x/dkg keeper does not expose raw SGX quotes.
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

  // =======================================================================
  // Private: EVM event-scanning implementation
  // =======================================================================

  /** Fetch DKG logs for a single event type in block chunks. */
  private async fetchDkgEventLogs(
    client: PublicClient,
    eventName: "Finalized" | "Registered",
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

  /** Get parsed Finalized events from the DKG contract. */
  // eslint-disable-next-line @typescript-eslint/explicit-function-return-type
  private async getFinalizedEvents(params?: { fromBlock?: bigint; toBlock?: bigint }): Promise<Array<{ args: { round: number; globalPubKey: `0x${string}`; validatorAddr: `0x${string}` } }>> {
    const toBlock =
      params?.toBlock ?? (await this.publicClient.getBlockNumber());
    const fromBlock = params?.fromBlock ??
      (toBlock > Observer.DEFAULT_LOOKBACK_BLOCKS
        ? toBlock - Observer.DEFAULT_LOOKBACK_BLOCKS
        : 0n);

    const rawLogs = await this.fetchDkgEventLogs(
      this.publicClient,
      "Finalized",
      fromBlock,
      toBlock,
    );

    const parsed = parseEventLogs({
      abi: dkgAbi,
      logs: rawLogs,
      eventName: "Finalized",
    });

    if (parsed.length === 0) {
      // Fallback: if no events in lookback window, try from block 0
      if (!params?.fromBlock && fromBlock > 0n) {
        return this.getFinalizedEvents({ fromBlock: 0n, toBlock });
      }
      throw new Error("No Finalized event found — DKG may not have completed yet");
    }

    return parsed;
  }

  /**
   * Find the highest DKG round that has enough finalized participants to be
   * considered "active" — i.e. count >= minReqFinalizedParticipants.
   * Fixes issue #36: the previous logic used the latest Finalized event which
   * could be from a failed round.
   */
  private async getActiveRound(
    allEvents: Array<{ args: { round: number; globalPubKey: `0x${string}`; validatorAddr: `0x${string}` } }>,
  ): Promise<{ round: number; events: typeof allEvents }> {
    const minReq = await this.publicClient.readContract({
      address: contractAddresses[this.network].dkg,
      abi: dkgAbi,
      functionName: "minReqFinalizedParticipants",
    }) as bigint;
    const minRequired = Number(minReq);

    // Group events by round, deduplicate by validatorAddr within each round
    const byRound = new Map<number, typeof allEvents>();
    for (const e of allEvents) {
      const round = e.args.round;
      if (!byRound.has(round)) byRound.set(round, []);
      const existing = byRound.get(round)!;
      const alreadySeen = existing.some(
        (prev) => prev.args.validatorAddr.toLowerCase() === e.args.validatorAddr.toLowerCase(),
      );
      if (!alreadySeen) existing.push(e);
    }

    // Find the highest round that meets the threshold (descending order)
    const rounds = [...byRound.keys()].sort((a, b) => b - a);
    for (const round of rounds) {
      const events = byRound.get(round)!;
      if (events.length >= minRequired) {
        return { round, events };
      }
    }

    // Fallback: no round meets threshold — warn and use the highest round.
    const highestRound = rounds[0];
    console.warn(
      `[CDR SDK] Warning: no DKG round meets minReqFinalizedParticipants (${minRequired}). ` +
      `Using highest round ${highestRound} as fallback. Data encrypted with this key may not be recoverable.`,
    );
    return { round: highestRound, events: byRound.get(highestRound)! };
  }

  private async getGlobalPubKeyFromEvents(params?: { fromBlock?: bigint }): Promise<Uint8Array> {
    const toBlock = await this.publicClient.getBlockNumber();
    const parsed = await this.getFinalizedEvents({ ...params, toBlock });

    const { events: activeEvents } = await this.getActiveRound(parsed);
    const latest = activeEvents[activeEvents.length - 1];
    const rawPoint = toBytes(latest.args.globalPubKey);

    // Cross-validate against additional RPCs if configured
    if (this.validationClients?.length) {
      const primaryHex = toHex(rawPoint);
      const fromBlock = params?.fromBlock ??
        (toBlock > Observer.DEFAULT_LOOKBACK_BLOCKS
          ? toBlock - Observer.DEFAULT_LOOKBACK_BLOCKS
          : 0n);

      const settled = await Promise.allSettled(
        this.validationClients.map(async (client) => {
          const logs = await this.fetchDkgEventLogs(
            client,
            "Finalized",
            fromBlock,
            toBlock,
          );
          const events = parseEventLogs({ abi: dkgAbi, logs, eventName: "Finalized" });
          if (events.length === 0) return null;
          const { events: activeEvents } = await this.getActiveRound(events);
          return activeEvents[activeEvents.length - 1].args.globalPubKey;
        }),
      );

      for (const s of settled) {
        if (s.status === "fulfilled" && s.value !== null && s.value !== primaryHex) {
          throw new RpcConsensusError("globalPubKey");
        }
      }
    }

    return rawPoint;
  }

  private async getRegisteredValidatorsFromEvents(params?: {
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

    const validators = new Map<string, Uint8Array>();
    for (const log of parsed) {
      if (params?.round !== undefined && log.args.round !== params.round) {
        continue;
      }
      const addr = log.args.validatorAddr.toLowerCase() as `0x${string}`;
      validators.set(addr, toBytes(log.args.enclaveCommKey));
    }
    return validators;
  }

  // =======================================================================
  // Private: CometBFT abci_query implementation
  // =======================================================================

  private requireCometRpcUrl(): string {
    if (!this.cometRpcUrl) {
      throw new Error(
        'Observer: cometRpcUrl is required when dkgSource is "cosmos-abci"',
      );
    }
    return this.cometRpcUrl;
  }

  private async getLatestActiveNetwork(): Promise<DKGNetwork> {
    return queryLatestActiveDKGNetwork(this.requireCometRpcUrl());
  }

  private async getGlobalPubKeyFromCosmos(): Promise<Uint8Array> {
    const network = await this.getLatestActiveNetwork();
    return network.globalPublicKey;
  }

  private async getRegisteredValidatorsFromCosmos(params?: {
    round?: number;
    codeCommitmentHex?: string;
  }): Promise<Map<string, Uint8Array>> {
    let round = params?.round;
    const codeCommitmentHex = params?.codeCommitmentHex ?? "";
    if (round === undefined) {
      round = (await this.getLatestActiveNetwork()).round;
    }

    const registrations = await queryVerifiedRegistrations(
      this.requireCometRpcUrl(),
      round,
      codeCommitmentHex,
    );

    const validators = new Map<string, Uint8Array>();
    for (const reg of registrations) {
      validators.set(reg.validatorAddr.toLowerCase(), reg.commPubKey);
    }
    return validators;
  }
}
