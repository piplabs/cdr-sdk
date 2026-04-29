import { type PublicClient } from "viem";
import { cdrAbi, dkgAbi, contractAddresses, type Network } from "@piplabs/cdr-contracts";
import { CURVE_ED25519 } from "@piplabs/cdr-crypto";
import type { Vault } from "./types.js";
import { InvalidParamsError } from "./errors.js";
import {
  queryLatestActiveDKGNetwork,
  queryDKGNetwork,
  queryAllRegistrations,
} from "./story-api/client.js";
import type { DKGNetwork, DKGRegistration } from "./story-api/types.js";

/** DKG round stage values from `story.dkg.v1.types.Stage`. */
const STAGE_ACTIVE = 4;
const STAGE_ENDED = 6;

/** DKG registration status values from `story.dkg.v1.types.RegistrationStatus`. */
const STATUS_FINALIZED = 2;

/**
 * Observer queries CDR contract state (EVM) and DKG state via the Story-API
 * REST endpoint.
 *
 * Two backends are used:
 * - **EVM** via `publicClient` for CDR contract reads (vault, fees,
 *   maxEncryptedDataSize, operationalThreshold) and the DKG contract's
 *   `operationalThreshold`.
 * - **Story-API REST** via `apiUrl` for all DKG state (active round, global
 *   public key, threshold, participant count, registered validators,
 *   validator attestations).
 *
 * ## Caching
 *
 * - `getActiveRound()` always hits REST — active round can change at any time
 *   and a stale value would silently desync downstream reads.
 * - Round-keyed network and registration snapshots are cached for the
 *   lifetime of the Observer, with in-flight Promise dedup so concurrent
 *   callers share a single REST request.
 * - The cache only retains entries for rounds in stage Active (4) or
 *   Ended (6) — these are the immutable, post-DKG-protocol states. Earlier
 *   stages (Registration / Dealing / Finalization / Failed) may still
 *   mutate, so we re-fetch on subsequent reads.
 * - `getRegisteredValidators` and `getValidatorAttestations` share a single
 *   per-round registrations cache, so calling both for the same round is a
 *   single round-trip.
 */
export class Observer {
  private publicClient: PublicClient;
  private network: Network;
  private apiUrl: string;
  private minThresholdRatio?: number;

  /** Per-round network snapshot cache (Promise-valued for in-flight dedup). */
  private networkSnapshots = new Map<number, Promise<DKGNetwork>>();
  /** Per-round registrations cache (status===Finalized only). */
  private registrationSnapshots = new Map<number, Promise<Map<string, DKGRegistration>>>();
  /**
   * Lifetime cache for `maxEncryptedDataSize`. The CDR contract treats this
   * as a constant: it doesn't change during normal operation, so we fetch
   * once per Observer instance with in-flight Promise dedup. Cleared on
   * fetch failure so the next call retries.
   */
  private maxEncryptedDataSizePromise: Promise<bigint> | null = null;

  constructor(params: {
    network: Network;
    publicClient: PublicClient;
    /** Story-API REST base URL, e.g. `"http://node:1317"`. */
    apiUrl: string;
    /**
     * Minimum threshold ratio override, in `[0, 1]`. The effective threshold
     * is `max(network.threshold, ceil(participants * minThresholdRatio))`.
     * Values > 1 would demand more partials than there are participants and
     * make `collectPartials` time out forever, so they are rejected.
     */
    minThresholdRatio?: number;
  }) {
    if (params.minThresholdRatio !== undefined) {
      const r = params.minThresholdRatio;
      if (!Number.isFinite(r) || r < 0 || r > 1) {
        throw new InvalidParamsError(
          `Observer: minThresholdRatio must be a finite number in [0, 1], got ${r}`,
        );
      }
    }
    this.publicClient = params.publicClient;
    this.network = params.network;
    this.apiUrl = params.apiUrl;
    this.minThresholdRatio = params.minThresholdRatio;
  }

  // =========================================================================
  // CDR contract reads (EVM)
  // =========================================================================

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

  /**
   * Get the maximum allowed encrypted data size for vault writes (in bytes).
   * Cached for the lifetime of this Observer — the CDR contract treats this
   * as a constant.
   */
  async getMaxEncryptedDataSize(): Promise<bigint> {
    if (!this.maxEncryptedDataSizePromise) {
      this.maxEncryptedDataSizePromise = this.publicClient
        .readContract({
          address: contractAddresses[this.network].cdr,
          abi: cdrAbi,
          functionName: "maxEncryptedDataSize",
        })
        .catch((e) => {
          this.maxEncryptedDataSizePromise = null;
          throw e;
        });
    }
    return this.maxEncryptedDataSizePromise;
  }

  /** Get DKG operational threshold (basis-points constant from the DKG contract). */
  async getOperationalThreshold(): Promise<bigint> {
    return this.publicClient.readContract({
      address: contractAddresses[this.network].dkg,
      abi: dkgAbi,
      functionName: "operationalThreshold",
    });
  }

  // =========================================================================
  // DKG queries via Story-API REST
  // =========================================================================

  /**
   * Get the currently active DKG round number.
   *
   * Always hits REST. The active round can transition at any time and a
   * stale value would silently desync downstream reads, so this method
   * never returns a cached round number. As a side-effect, the response's
   * network snapshot is cached under its round number, so subsequent
   * reads for the same round are served from cache.
   */
  async getActiveRound(): Promise<number> {
    const network = await this.fetchLatestActive();
    return network.round;
  }

  /**
   * Get the DKG global public key from the active round.
   * Returns the Ed25519 point with a 2-byte curve-code prefix (0x043f) so it
   * can be passed directly to the WASM TDH2 functions.
   */
  async getGlobalPubKey(): Promise<Uint8Array> {
    const net = await this.fetchLatestActive();
    return prefixEd25519Point(net.globalPublicKey);
  }

  /** Get the number of participants in the active DKG round. */
  async getParticipantCount(): Promise<number> {
    const net = await this.fetchLatestActive();
    return net.total;
  }

  /**
   * Get the absolute threshold (minimum number of partial decryptions needed)
   * for the active round. If `minThresholdRatio` was set on the Observer,
   * returns `max(network.threshold, ceil(participants * minThresholdRatio))`.
   */
  async getThreshold(): Promise<number> {
    const net = await this.fetchLatestActive();
    if (this.minThresholdRatio !== undefined) {
      const overrideThreshold = Math.ceil(net.total * this.minThresholdRatio);
      return Math.max(net.threshold, overrideThreshold);
    }
    return net.threshold;
  }

  /**
   * Get a map of validator address → commPubKey bytes for the given DKG
   * round (defaults to active round). Only includes validators with
   * status=Finalized (2). Shares per-round cache with
   * {@link getValidatorAttestations}, so calling both for the same round
   * is a single REST round-trip.
   *
   * The commPubKey is the secp256k1 public key used by the validator's TEE
   * to sign partial decryption responses.
   */
  async getRegisteredValidators(params?: { round?: number }): Promise<Map<string, Uint8Array>> {
    const round = params?.round ?? (await this.getActiveRound());
    const regs = await this.loadRegistrations(round);
    return new Map([...regs].map(([addr, reg]) => [addr, reg.commPubKey]));
  }

  /**
   * Get a map of validator address → enclaveReport (raw SGX quote bytes)
   * for the given DKG round (defaults to active round). Only includes
   * validators with status=Finalized (2). Shares per-round cache with
   * {@link getRegisteredValidators}.
   *
   * Use with `verifyAttestation()` to verify each validator's TEE enclave
   * before trusting their partial decryptions.
   */
  async getValidatorAttestations(params?: { round?: number }): Promise<Map<string, Uint8Array>> {
    const round = params?.round ?? (await this.getActiveRound());
    const regs = await this.loadRegistrations(round);
    return new Map([...regs].map(([addr, reg]) => [addr, reg.enclaveReport]));
  }

  // =========================================================================
  // Private cache layer
  // =========================================================================

  /**
   * Fetch `/dkg/latest_active`. Always hits REST. As a side-effect, caches
   * the network under its round number — `latest_active` is by definition
   * stage=Active (4), so the snapshot is safe to retain.
   */
  private async fetchLatestActive(): Promise<DKGNetwork> {
    const network = await queryLatestActiveDKGNetwork({ apiUrl: this.apiUrl });
    if (!this.networkSnapshots.has(network.round)) {
      this.networkSnapshots.set(network.round, Promise.resolve(network));
    }
    return network;
  }

  /**
   * Fetch network state for a specific round, or hit cache. Used by
   * {@link loadRegistrations} for its stage check; not directly exposed.
   * The returned Promise is cached for in-flight dedup; the entry is
   * evicted after resolution if the round is in a non-stable stage so
   * subsequent reads re-fetch.
   */
  private async loadNetwork(round: number): Promise<DKGNetwork> {
    const cached = this.networkSnapshots.get(round);
    if (cached) return cached;
    const promise = queryDKGNetwork({ apiUrl: this.apiUrl, round });
    this.networkSnapshots.set(round, promise);
    promise
      .then((network) => {
        if (network.stage !== STAGE_ACTIVE && network.stage !== STAGE_ENDED) {
          if (this.networkSnapshots.get(round) === promise) {
            this.networkSnapshots.delete(round);
          }
        }
      })
      .catch(() => {
        if (this.networkSnapshots.get(round) === promise) {
          this.networkSnapshots.delete(round);
        }
      });
    return promise;
  }

  /**
   * Fetch + filter registrations for a round, or hit cache. Filters by
   * `status === Finalized` so the returned map only contains validators
   * whose registration is fully ratified. Cache is only retained when the
   * round is in a stable stage (Active or Ended); non-stable stages may
   * mutate, so they're evicted after resolution.
   */
  private async loadRegistrations(round: number): Promise<Map<string, DKGRegistration>> {
    const cached = this.registrationSnapshots.get(round);
    if (cached) return cached;

    const networkPromise = this.loadNetwork(round);
    const regsPromise = queryAllRegistrations({ apiUrl: this.apiUrl, round });

    const promise = regsPromise.then(
      (allRegs) =>
        new Map<string, DKGRegistration>(
          allRegs
            .filter((r) => r.status === STATUS_FINALIZED)
            .map((r) => [r.validatorAddr.toLowerCase(), r]),
        ),
    );

    this.registrationSnapshots.set(round, promise);

    Promise.all([networkPromise, promise])
      .then(([network]) => {
        if (network.stage !== STAGE_ACTIVE && network.stage !== STAGE_ENDED) {
          if (this.registrationSnapshots.get(round) === promise) {
            this.registrationSnapshots.delete(round);
          }
        }
      })
      .catch(() => {
        if (this.registrationSnapshots.get(round) === promise) {
          this.registrationSnapshots.delete(round);
        }
      });

    return promise;
  }
}

/**
 * The WASM TDH2 functions expect a 2-byte curve-code prefix on the Ed25519
 * public key (0x043f). Story-API returns the raw 32-byte point, so we
 * prepend the prefix here.
 */
function prefixEd25519Point(rawPoint: Uint8Array): Uint8Array {
  if (rawPoint.length !== 32) return rawPoint;
  const prefixed = new Uint8Array(34);
  prefixed[0] = (CURVE_ED25519 >> 8) & 0xff;
  prefixed[1] = CURVE_ED25519 & 0xff;
  prefixed.set(rawPoint, 2);
  return prefixed;
}
