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

export class Observer {
  /** Many RPCs reject or time out on wide eth_getLogs ranges; chunk to stay under typical caps. */
  private static readonly DKG_LOGS_BLOCK_CHUNK = 8192n;

  /** Default lookback window: ~7 days at ~2 s/block. Avoids scanning from block 0 on long chains. */
  private static readonly DEFAULT_LOOKBACK_BLOCKS = 302_400n;

  private publicClient: PublicClient;
  private network: Network;
  private minThresholdRatio?: number;
  private validationClients?: PublicClient[];

  constructor(params: {
    network: Network;
    publicClient: PublicClient;
    minThresholdRatio?: number;
    validationClients?: PublicClient[];
  }) {
    this.publicClient = params.publicClient;
    this.network = params.network;
    this.minThresholdRatio = params.minThresholdRatio;
    this.validationClients = params.validationClients;
  }

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
   * Get DKG operational threshold.
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

  /**
   * Fetch DKG logs for a single event type in block chunks (avoids RPC range / size limits).
   */
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

  /**
   * Get parsed Finalized events from the DKG contract.
   */
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
   * Get the DKG global public key from the most recent Finalized event.
   * Returns the raw bytes of the globalPubKey (Ed25519 point with curve-code prefix).
   * @example
   * ```ts
   * const globalPubKey = await observer.getGlobalPubKey();
   * ```
   */
  async getGlobalPubKey(params?: { fromBlock?: bigint }): Promise<Uint8Array> {
    const toBlock = await this.publicClient.getBlockNumber();
    const parsed = await this.getFinalizedEvents({ ...params, toBlock });
    const latest = parsed[parsed.length - 1];
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
          return events[events.length - 1].args.globalPubKey;
        }),
      );

      for (const s of settled) {
        if (s.status === "fulfilled" && s.value !== null && s.value !== primaryHex) {
          throw new RpcConsensusError("globalPubKey");
        }
      }
    }

    // The contract returns the raw 32-byte Ed25519 point. The WASM TDH2
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
   * Get the number of participants in the latest DKG round
   * by counting Finalized events with the same round as the most recent event.
   * @example
   * ```ts
   * const count = await observer.getParticipantCount();
   * ```
   */
  async getParticipantCount(params?: { fromBlock?: bigint }): Promise<number> {
    const parsed = await this.getFinalizedEvents(params);
    const latestRound = parsed[parsed.length - 1].args.round;
    return parsed.filter((e) => e.args.round === latestRound).length;
  }

  /**
   * Get the absolute threshold (minimum number of partial decryptions needed).
   * Computes: ceil(participantCount * operationalThreshold / 1000).
   * If `minThresholdRatio` was set, returns max(contractThreshold, ceil(participants * minThresholdRatio)).
   * @example
   * ```ts
   * const threshold = await observer.getThreshold();
   * ```
   */
  async getThreshold(params?: { fromBlock?: bigint }): Promise<number> {
    const [operationalThreshold, participantCount] = await Promise.all([
      this.getOperationalThreshold(),
      this.getParticipantCount(params),
    ]);
    const contractThreshold = Math.ceil(participantCount * Number(operationalThreshold) / 1000);

    if (this.minThresholdRatio !== undefined) {
      const overrideThreshold = Math.ceil(participantCount * this.minThresholdRatio);
      return Math.max(contractThreshold, overrideThreshold);
    }

    return contractThreshold;
  }

  /**
   * Get a map of validator address → enclaveCommKey from DKG Registered events.
   * The commPubKey is the 64-byte uncompressed secp256k1 public key (without 0x04 prefix)
   * used by the validator's TEE to sign partial decryption responses.
   *
   * @param round - If provided, only include validators registered for this round
   * @returns Map where keys are lowercase checksummed addresses and values are commPubKey bytes
   * @example
   * ```ts
   * const validators = await observer.getRegisteredValidators();
   * for (const [addr, commKey] of validators) {
   *   console.log(addr, commKey.length);
   * }
   * ```
   */
  async getRegisteredValidators(params?: {
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
    // explicitly provide fromBlock, scan from block 0. When the caller
    // passes an explicit fromBlock we respect their intent and do not
    // silently expand the search scope.
    if (attestations.size === 0 && !params?.fromBlock && fromBlock > 0n) {
      return this.getValidatorAttestations({ fromBlock: 0n, round: params?.round });
    }

    return attestations;
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
}
