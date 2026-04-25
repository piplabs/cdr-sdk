import { parseEventLogs, toBytes, toHex, fromHex, type PublicClient, type WalletClient } from "viem";
import { cdrAbi, dkgAbi, contractAddresses, type Network } from "@piplabs/cdr-contracts";
import { decryptPartial as eciesDecrypt, tdh2Combine, verifyPartialSignature, decryptFile, generateEphemeralKeyPair, type TDH2Ciphertext, type DecryptedPartial } from "@piplabs/cdr-crypto";
import { PartialCollectionTimeoutError, InvalidParamsError, ObserverRequiredError, CidIntegrityError } from "./errors.js";
import type { PartialDecryptionEvent } from "./types.js";
import { uuidToLabel } from "./label.js";
import type { StorageProvider } from "./storage/types.js";
import { Observer } from "./observer.js";
import type { AttestationConfig } from "./attestation.js";
import { queryCDRPartials, queryLatestActiveDKGNetwork } from "./cosmos/abci-query.js";
import { bytesToHex as cosmosBytesToHex } from "./cosmos/protobuf.js";

export class Consumer {
  private publicClient: PublicClient;
  private walletClient: WalletClient;
  private network: Network;
  private observer: Observer | null;

  /**
   * In-flight (or settled) promise for the cached commPubKey map. Promise-
   * level caching deduplicates concurrent calls: if two accessCDR invocations
   * both trigger a build at the same time, only one scan runs.
   *
   * Registered events are immutable, so the only staleness risk is a new
   * validator registering after the cache was built; that surfaces as
   * "unknown validator" during verify, which triggers an automatic one-shot
   * refresh (see collectPartialsFromEvents).
   */
  private commPubKeyMapPromise: Promise<Map<string, Uint8Array[]>> | null = null;

  /**
   * Whether a scan is currently in progress. Used to deduplicate concurrent
   * force-refresh requests: without this flag, two collectPartials calls that
   * both encounter a verification failure at the same time would each call
   * getCommPubKeyMap(true) and fan out into two parallel full-history scans.
   * With it, the second caller joins the first refresh's in-flight promise.
   */
  private commPubKeyMapBuildInFlight = false;

  /**
   * Cached "fallback" Observer used by getEventLookback when the Consumer
   * was constructed without one. Reusing the same instance preserves its
   * `defaultCometUrlWarned` flag, so the plaintext-HTTP warning fires
   * exactly once per Consumer instead of once per getEventLookback call
   * (which would re-fire after every cache refresh).
   */
  private fallbackObserver: Observer | null = null;

  /** Alias for {@link accessCDR} */
  readVault: Consumer["accessCDR"];
  /** Alias for {@link downloadFile} */
  readFileVault: Consumer["downloadFile"];

  constructor(params: {
    network: Network;
    publicClient: PublicClient;
    walletClient: WalletClient;
    observer?: Observer;
  }) {
    this.publicClient = params.publicClient;
    this.walletClient = params.walletClient;
    this.network = params.network;
    this.observer = params.observer ?? null;
    this.readVault = this.accessCDR.bind(this);
    this.readFileVault = this.downloadFile.bind(this);
  }

  /**
   * Warm the validator commPubKey cache in the background.
   *
   * The cache is normally built lazily on the first accessCDR / downloadFile
   * call, which requires a full-history scan of DKG Registered events and
   * can take tens of seconds on mature chains — long enough that a request
   * triggered by a user click can appear to hang. Frontends that know a
   * read is imminent (e.g. right after user login / wallet connection) can
   * call prefetchRegistry() to start the scan early, so the subsequent
   * accessCDR call hits a warm cache and returns immediately.
   *
   * Safe to call multiple times — concurrent callers share the same
   * in-flight build via Promise-level dedupe, so repeated prefetches cost
   * nothing. Errors propagate; callers doing best-effort warming should
   * attach their own `.catch(() => {})` and let the real accessCDR call
   * surface the failure later if it still occurs.
   *
   * @example
   * ```ts
   * // Right after user login / wallet connection, in a useEffect:
   * cdrClient.consumer.prefetchRegistry().catch(() => {
   *   // best-effort warm-up; real accessCDR call will retry if needed
   * });
   * ```
   */
  async prefetchRegistry(): Promise<void> {
    await this.getCommPubKeyMap();
  }

  /**
   * Request a vault read. Auto-queries read fee. Emits VaultRead event for validators.
   * @example
   * ```ts
   * const { txHash } = await consumer.read({
   *   uuid: 42,
   *   accessAuxData: "0x",
   *   requesterPubKey: "0x04...",
   * });
   * ```
   */
  async read(params: {
    uuid: number;
    accessAuxData: `0x${string}`;
    requesterPubKey: `0x${string}`;
    feeOverride?: bigint;
  }): Promise<{ txHash: `0x${string}` }> {
    const cdrAddress = contractAddresses[this.network].cdr;

    const fee = params.feeOverride ?? await this.publicClient.readContract({
      address: cdrAddress,
      abi: cdrAbi,
      functionName: "readFee",
    });

    const txHash = await this.walletClient.writeContract({
      chain: this.walletClient.chain ?? null,
      account: this.walletClient.account ?? null,
      address: cdrAddress,
      abi: cdrAbi,
      functionName: "read",
      args: [params.uuid, params.accessAuxData, params.requesterPubKey],
      value: fee,
    });

    return { txHash };
  }

  /**
   * Fetch validator address → commPubKey[] map from DKG Registered events.
   *
   * Hybrid mode (default): query `GetLatestActiveDKGNetwork` via CometBFT
   * ABCI to identify the currently active DKG round, then scan EVM
   * `Registered` events within a bounded window and keep only registrations
   * for that round. The CometBFT RPC URL defaults to
   * {@link Observer.DEFAULT_COMET_RPC_URL}; callers can override it by
   * passing `cometRpcUrl` when constructing `CDRClient`. If the ABCI query
   * fails (network unreachable, URL misconfigured, etc.), we fall back to
   * keeping every key in the window and letting the verify loop try each.
   *
   * The scan window is computed from on-chain DKG params via
   * {@link Observer.getLookbackBlocks} — `2 × (registrationPeriod +
   * dealingPeriod + finalizationPeriod) + activePeriod` — covering the
   * current epoch plus one prior protocol pass for buffer.
   */
  /** Chunk size for historical getLogs scans. Kept well below typical RPC block-range limits. */
  private static readonly DKG_LOGS_BLOCK_CHUNK = 500_000n;
  /** Max attempts per chunk getLogs call before propagating the error. */
  private static readonly GETLOGS_MAX_ATTEMPTS = 3;
  /** Base delay (ms) for exponential backoff between getLogs retries. */
  private static readonly GETLOGS_BACKOFF_MS = 500;

  /**
   * Return the cached commPubKey map, building it on first call or when
   * {@link forceRefresh} is true.
   *
   * Concurrent callers share the same in-flight build promise so we never
   * scan the full history twice in parallel — this dedup applies to the
   * force-refresh path as well, so two collectPartials calls that both
   * hit a verification failure at the same time only trigger one rescan.
   * On build failure the rejected promise is cleared so a subsequent
   * call can retry from scratch instead of inheriting the rejection.
   */
  private async getCommPubKeyMap(forceRefresh = false): Promise<Map<string, Uint8Array[]>> {
    // Any build currently in flight is shared with all callers, refresh or not.
    if (this.commPubKeyMapBuildInFlight && this.commPubKeyMapPromise) {
      return this.commPubKeyMapPromise;
    }
    // No build in flight: a non-refresh caller can reuse a settled cache.
    if (!forceRefresh && this.commPubKeyMapPromise) {
      return this.commPubKeyMapPromise;
    }
    this.commPubKeyMapBuildInFlight = true;
    const dkgAddress = contractAddresses[this.network].dkg;
    const p = this.fetchRegisteredValidators(dkgAddress)
      .catch((err) => {
        if (this.commPubKeyMapPromise === p) {
          this.commPubKeyMapPromise = null;
        }
        throw err;
      })
      .finally(() => {
        this.commPubKeyMapBuildInFlight = false;
      });
    this.commPubKeyMapPromise = p;
    return p;
  }

  /**
   * Resolve the event-scan lookback window in blocks:
   *   2 × (registrationPeriod + dealingPeriod + finalizationPeriod) + activePeriod
   *
   * Delegates to the configured Observer (which caches DKG params). When no
   * Observer is wired, lazily builds a single temporary one bound to this
   * Consumer's cometRpcUrl resolution and reuses it across calls — reusing
   * preserves the Observer's `defaultCometUrlWarned` flag so the plaintext-
   * HTTP warning fires once per Consumer rather than once per refresh.
   */
  private async getEventLookback(): Promise<bigint> {
    if (this.observer) return this.observer.getLookbackBlocks();
    if (!this.fallbackObserver) {
      this.fallbackObserver = new Observer({
        network: this.network,
        publicClient: this.publicClient,
      });
    }
    return this.fallbackObserver.getLookbackBlocks();
  }

  private async fetchRegisteredValidators(
    dkgAddress: `0x${string}`,
  ): Promise<Map<string, Uint8Array[]>> {
    const latestBlock = await this.publicClient.getBlockNumber();
    const chunk = Consumer.DKG_LOGS_BLOCK_CHUNK;
    const lookback = await this.getEventLookback();
    const startBlock = latestBlock > lookback ? latestBlock - lookback : 0n;

    // Hybrid mode (default): query CometBFT ABCI for the currently active DKG
    // round so we can filter EVM Registered events to just that round's
    // commPubKeys. Uses the Observer's cometRpcUrl if the caller set one,
    // otherwise falls back to the SDK's network-specific default URL (the
    // one-time plaintext-HTTP warning is emitted by Observer.getDKGParams,
    // which getEventLookback() already invoked above).
    let activeRound: number | undefined;
    const cometRpcUrl = this.observer?.cometRpcUrl ?? Observer.DEFAULT_COMET_RPC_URL;
    try {
      const network = await queryLatestActiveDKGNetwork(cometRpcUrl);
      activeRound = network.round;
    } catch {
      // ABCI unreachable or query failed — fall back to unfiltered scan.
    }

    const validators = new Map<string, Uint8Array[]>();

    for (let from = startBlock; from <= latestBlock; from = from + chunk + 1n) {
      const to = from + chunk > latestBlock ? latestBlock : from + chunk;

      const rawLogs = await this.getLogsWithRetry(dkgAddress, from, to);

      const parsed = parseEventLogs({
        abi: dkgAbi,
        logs: rawLogs,
        eventName: "Registered",
      });

      for (const log of parsed) {
        if (activeRound !== undefined && log.args.round !== activeRound) {
          continue; // Hybrid mode: skip non-active rounds.
        }
        const addr = log.args.validatorAddr.toLowerCase() as `0x${string}`;
        const keys = validators.get(addr) ?? [];
        keys.push(toBytes(log.args.enclaveCommKey));
        validators.set(addr, keys);
      }
    }

    return validators;
  }

  /**
   * getLogs wrapper with exponential-backoff retry. Public RPCs can return
   * transient errors for individual chunk ranges (observed as
   * "invalid block range params" on Aeneid); a narrow retry loop keeps the
   * full-history scan robust without swallowing persistent failures.
   */
  private async getLogsWithRetry(
    address: `0x${string}`,
    fromBlock: bigint,
    toBlock: bigint,
  ): Promise<Awaited<ReturnType<PublicClient["getLogs"]>>> {
    let lastError: unknown;
    for (let attempt = 0; attempt < Consumer.GETLOGS_MAX_ATTEMPTS; attempt++) {
      try {
        return await this.publicClient.getLogs({ address, fromBlock, toBlock });
      } catch (err) {
        lastError = err;
        if (attempt === Consumer.GETLOGS_MAX_ATTEMPTS - 1) break;
        const delay = Consumer.GETLOGS_BACKOFF_MS * 2 ** attempt;
        await new Promise((resolve) => setTimeout(resolve, delay));
      }
    }
    throw lastError;
  }

  /**
   * Collect at least `minPartials` partial decryptions for this vault read.
   *
   * In the default evm-events mode: polls `EncryptedPartialDecryptionSubmitted`
   * events from the CDR contract, filtered by uuid, and verifies each partial's
   * TEE signature against the validator's registered commPubKey.
   *
   * In cosmos-abci mode (when the Observer is configured with
   * `dkgSource: "cosmos-abci"`): polls the x/dkg keeper's GetCDRPartials
   * query via CometBFT abci_query. Signature verification is performed by
   * the keeper on ingress (see story/client/x/dkg/keeper/dkg_handler.go
   * PartialDecryptionSubmitted), so the SDK trusts the keeper state returned
   * by the node — the same trust level as any EVM RPC read.
   * The caller must supply `requesterPubKey` in this mode.
   *
   * @example
   * ```ts
   * const partials = await consumer.collectPartials({
   *   uuid: 42,
   *   minPartials: 3,
   *   fromBlock: startBlock,
   *   timeoutMs: 60_000,
   * });
   * ```
   */
  async collectPartials(params: {
    uuid: number;
    minPartials: number;
    fromBlock: bigint;
    timeoutMs?: number;
    pollIntervalMs?: number;
    /** Required in cosmos-abci mode; ignored in evm-events mode. */
    requesterPubKey?: `0x${string}`;
    /** Called when a partial fails signature verification. evm-events mode only. */
    onInvalidPartial?: (event: PartialDecryptionEvent, error: Error) => void;
    /** If provided, verify each validator's attestation report. Invalid attestations trigger onInvalidPartial. */
    attestationConfig?: AttestationConfig;
  }): Promise<PartialDecryptionEvent[]> {
    if (this.observer?.dkgSource === "cosmos-abci") {
      return this.collectPartialsFromCosmos(params);
    }
    return this.collectPartialsFromEvents(params);
  }

  private async collectPartialsFromEvents(params: {
    uuid: number;
    minPartials: number;
    fromBlock: bigint;
    timeoutMs?: number;
    pollIntervalMs?: number;
    onInvalidPartial?: (event: PartialDecryptionEvent, error: Error) => void;
    attestationConfig?: AttestationConfig;
  }): Promise<PartialDecryptionEvent[]> {
    const { uuid, minPartials, fromBlock, timeoutMs = 60_000, pollIntervalMs = 3_000, onInvalidPartial } = params;
    const cdrAddress = contractAddresses[this.network].cdr;
    const deadline = Date.now() + timeoutMs;

    // Build commPubKey map from DKG Registered events (cached across calls).
    let commPubKeyMap = await this.getCommPubKeyMap();
    // Track which validators have already triggered a cache refresh this call,
    // so a genuinely unknown validator can't force repeated re-scans.
    const refreshedFor = new Set<string>();

    let lastScannedBlock = fromBlock;
    const collected = new Map<string, PartialDecryptionEvent>();

    while (Date.now() < deadline) {
      const currentBlock = await this.publicClient.getBlockNumber();
      if (currentBlock >= lastScannedBlock) {
        // Same retry wrapper used for the DKG scan: public RPCs (notably
        // aeneid.storyrpc.io) occasionally return "invalid block range params"
        // for tiny ranges — a transient error we should not let surface as an
        // accessCDR failure in the middle of the poll loop. See PERF-05 flake
        // observed in https://github.com/piplabs/story-cdr-e2e/actions/runs/24884251274.
        const rawLogs = await this.getLogsWithRetry(cdrAddress, lastScannedBlock, currentBlock);
        lastScannedBlock = currentBlock + BigInt(1);

        const parsed = parseEventLogs({
          abi: cdrAbi,
          logs: rawLogs,
          eventName: "EncryptedPartialDecryptionSubmitted",
        });

        for (const log of parsed) {
          if (log.args.uuid === uuid) {
            const key = `${log.args.validator}-${log.args.pid}`;
            if (!collected.has(key)) {
              const event: PartialDecryptionEvent = {
                validator: log.args.validator,
                round: log.args.round,
                pid: log.args.pid,
                encryptedPartial: log.args.encryptedPartial,
                ephemeralPubKey: log.args.ephemeralPubKey,
                pubShare: log.args.pubShare,
                requesterPubKey: log.args.requesterPubKey,
                uuid: log.args.uuid,
                signature: log.args.signature,
              };

              // Verify signature — try all known commPubKeys for this validator.
              // In hybrid mode the cached map holds only the active-round keys,
              // so a DKG rotation that happens after the cache is built leaves
              // every validator with stale (old-round) keys. Refreshing on any
              // verification failure — not just on an absent validator — lets
              // the next round's partials recover without a process restart.
              const validatorAddr = log.args.validator.toLowerCase();
              let commPubKeys = commPubKeyMap.get(validatorAddr);

              const tryVerifyWith = (keys: Uint8Array[] | undefined): boolean => {
                if (!keys || keys.length === 0) return false;
                for (let ki = keys.length - 1; ki >= 0; ki--) {
                  if (verifyPartialSignature({
                    round: event.round,
                    ciphertext: toBytes(log.args.ciphertext),
                    encryptedPartial: toBytes(event.encryptedPartial),
                    ephemeralPubKey: toBytes(event.ephemeralPubKey),
                    pubShare: toBytes(event.pubShare),
                    signature: toBytes(log.args.signature),
                    commPubKey: keys[ki],
                  })) return true;
                }
                return false;
              };

              let valid = tryVerifyWith(commPubKeys);

              // Refresh the cache once per validator per call on any verification
              // failure (unknown validator OR all cached keys fail). Deduped by
              // validator address so a genuinely bad signer can't force repeated
              // full-history rescans within a single collectPartials invocation.
              if (!valid && !refreshedFor.has(validatorAddr)) {
                refreshedFor.add(validatorAddr);
                commPubKeyMap = await this.getCommPubKeyMap(true);
                commPubKeys = commPubKeyMap.get(validatorAddr);
                valid = tryVerifyWith(commPubKeys);
              }

              if (!valid) {
                const reason = (!commPubKeys || commPubKeys.length === 0)
                  ? `unknown validator: ${log.args.validator}`
                  : `invalid signature from validator ${log.args.validator}`;
                onInvalidPartial?.(event, new Error(reason));
                continue;
              }

              collected.set(key, event);
            }
          }
        }
      }

      if (collected.size >= minPartials) {
        return [...collected.values()].slice(0, minPartials);
      }

      await new Promise((resolve) => setTimeout(resolve, pollIntervalMs));
    }

    throw new PartialCollectionTimeoutError(collected.size, minPartials, timeoutMs);
  }

  private async collectPartialsFromCosmos(params: {
    uuid: number;
    minPartials: number;
    timeoutMs?: number;
    pollIntervalMs?: number;
    requesterPubKey?: `0x${string}`;
  }): Promise<PartialDecryptionEvent[]> {
    const { uuid, minPartials, timeoutMs = 60_000, pollIntervalMs = 3_000, requesterPubKey } = params;
    if (!requesterPubKey) {
      throw new InvalidParamsError(
        'collectPartials: requesterPubKey is required when observer is configured with dkgSource: "cosmos-abci"',
      );
    }
    const rpcUrl = this.observer?.cometRpcUrl;
    if (!rpcUrl) {
      throw new InvalidParamsError(
        'collectPartials: observer.cometRpcUrl is required when observer is configured with dkgSource: "cosmos-abci"',
      );
    }
    const requesterPubKeyHex = requesterPubKey.replace(/^0x/i, "");
    const deadline = Date.now() + timeoutMs;
    let lastCount = 0;

    while (Date.now() < deadline) {
      const rounds = await queryCDRPartials(rpcUrl, uuid, requesterPubKeyHex);

      // Pick the highest-round bucket with submissions — that's the round
      // this decrypt request was serviced under.
      const active = rounds
        .filter((r) => r.submissions.length > 0)
        .sort((a, b) => b.round - a.round)[0];

      const subs = active?.submissions ?? [];
      lastCount = subs.length;

      if (subs.length >= minPartials || (active && active.thresholdMet)) {
        return subs.slice(0, minPartials).map((s) => {
          const validatorHex = s.validator.startsWith("0x") ? s.validator : `0x${s.validator}`;
          return {
            validator: validatorHex.toLowerCase() as `0x${string}`,
            round: s.round,
            pid: s.pid,
            encryptedPartial: `0x${cosmosBytesToHex(s.encryptedPartial)}` as `0x${string}`,
            ephemeralPubKey: `0x${cosmosBytesToHex(s.ephemeralPubKey)}` as `0x${string}`,
            pubShare: `0x${cosmosBytesToHex(s.pubShare)}` as `0x${string}`,
            uuid,
          };
        });
      }

      await new Promise((resolve) => setTimeout(resolve, pollIntervalMs));
    }

    throw new PartialCollectionTimeoutError(lastCount, minPartials, timeoutMs);
  }

  /**
   * Decrypt collected partials and combine to recover the original data key.
   * @example
   * ```ts
   * const dataKey = await consumer.decryptDataKey({
   *   ciphertext: { raw: encryptedData, label },
   *   partials,
   *   recipientPrivKey,
   *   globalPubKey,
   *   label,
   *   threshold: 3,
   * });
   * ```
   */
  async decryptDataKey(params: {
    ciphertext: TDH2Ciphertext;
    partials: PartialDecryptionEvent[];
    recipientPrivKey: Uint8Array;
    globalPubKey: Uint8Array;
    label: Uint8Array;
    threshold: number;
  }): Promise<Uint8Array> {
    const { ciphertext, partials, recipientPrivKey, globalPubKey, label, threshold } = params;

    const decryptedPartials: DecryptedPartial[] = await Promise.all(
      partials.map(async (p) => {
        const decrypted = await eciesDecrypt({
          encryptedPartial: toBytes(p.encryptedPartial),
          ephemeralPubKey: toBytes(p.ephemeralPubKey),
          recipientPrivKey,
        });
        return {
          name: String(p.pid),
          pubShare: toBytes(p.pubShare),
          partial: decrypted,
        };
      }),
    );

    return tdh2Combine({
      ciphertext,
      partials: decryptedPartials,
      globalPubKey,
      label,
      threshold,
    });
  }

  /**
   * Convenience: read + collect + decrypt in one call.
   * If requesterPubKey/recipientPrivKey are omitted, an ephemeral secp256k1 keypair is generated and the private key is zeroed after use.
   * If globalPubKey/threshold are omitted, they are auto-queried via the Observer (requires observer to be set).
   * @example
   * ```ts
   * // Simplified — keys and DKG params auto-managed:
   * const { dataKey, txHash } = await consumer.accessCDR({
   *   uuid: 42,
   *   accessAuxData: "0x",
   * });
   * ```
   */
  async accessCDR(params: {
    uuid: number;
    accessAuxData: `0x${string}`;
    requesterPubKey?: `0x${string}`;
    recipientPrivKey?: Uint8Array;
    globalPubKey?: Uint8Array;
    threshold?: number;
    timeoutMs?: number;
    feeOverride?: bigint;
    onInvalidPartial?: (event: PartialDecryptionEvent, error: Error) => void;
  }): Promise<{ dataKey: Uint8Array; txHash: `0x${string}` }> {
    // Validate key pair: both must be provided or both omitted
    if ((params.requesterPubKey && !params.recipientPrivKey) || (!params.requesterPubKey && params.recipientPrivKey)) {
      throw new InvalidParamsError("requesterPubKey and recipientPrivKey must both be provided or both omitted");
    }

    // Auto-generate ephemeral keypair if not provided
    let recipientPrivKey = params.recipientPrivKey;
    let requesterPubKey = params.requesterPubKey;
    let ephemeralGenerated = false;
    if (!recipientPrivKey || !requesterPubKey) {
      const kp = generateEphemeralKeyPair();
      recipientPrivKey = kp.privateKey;
      requesterPubKey = toHex(kp.publicKey);
      ephemeralGenerated = true;
    }

    // Auto-query globalPubKey and threshold from Observer if not provided
    let globalPubKey = params.globalPubKey;
    let threshold = params.threshold;
    if (!globalPubKey || threshold === undefined) {
      if (!this.observer) {
        throw new ObserverRequiredError();
      }
      [globalPubKey, threshold] = await Promise.all([
        globalPubKey ? Promise.resolve(globalPubKey) : this.observer.getGlobalPubKey(),
        threshold !== undefined ? Promise.resolve(threshold) : this.observer.getThreshold(),
      ]);
    }

    try {
      const vault = await this.publicClient.readContract({
        address: contractAddresses[this.network].cdr,
        abi: cdrAbi,
        functionName: "vaults",
        args: [params.uuid],
      });
      const vaultResult = vault as { encryptedData: `0x${string}` };
      const encryptedData = toBytes(vaultResult.encryptedData);

      const label = uuidToLabel(params.uuid);

      const fromBlock = await this.publicClient.getBlockNumber();
      const { txHash } = await this.read({
        uuid: params.uuid,
        accessAuxData: params.accessAuxData,
        requesterPubKey,
        feeOverride: params.feeOverride,
      });

      const partials = await this.collectPartials({
        uuid: params.uuid,
        minPartials: threshold,
        fromBlock,
        timeoutMs: params.timeoutMs,
        requesterPubKey,
        onInvalidPartial: params.onInvalidPartial,
      });

      const dataKey = await this.decryptDataKey({
        ciphertext: { raw: encryptedData, label },
        partials,
        recipientPrivKey,
        globalPubKey,
        label,
        threshold,
      });

      return { dataKey, txHash };
    } finally {
      if (ephemeralGenerated && recipientPrivKey) {
        recipientPrivKey.fill(0);
      }
    }
  }

  /**
   * Convenience: access vault, parse CID + key payload, download from storage, and decrypt file.
   * Key/threshold params are optional — see accessCDR() for auto-generation behavior.
   * @example
   * ```ts
   * const { content, cid } = await consumer.downloadFile({
   *   uuid: 42,
   *   accessAuxData: "0x",
   *   storageProvider,
   * });
   * ```
   */
  async downloadFile(params: {
    uuid: number;
    accessAuxData: `0x${string}`;
    requesterPubKey?: `0x${string}`;
    recipientPrivKey?: Uint8Array;
    globalPubKey?: Uint8Array;
    threshold?: number;
    storageProvider: StorageProvider;
    timeoutMs?: number;
    feeOverride?: bigint;
    onInvalidPartial?: (event: PartialDecryptionEvent, error: Error) => void;
    /** Skip CID integrity verification of downloaded file (default: false). */
    skipCidVerification?: boolean;
  }): Promise<{
    content: Uint8Array;
    cid: string;
    txHash: `0x${string}`;
  }> {
    // Step 1: Access vault to get decrypted payload
    const { dataKey: payloadBytes, txHash } = await this.accessCDR({
      uuid: params.uuid,
      accessAuxData: params.accessAuxData,
      requesterPubKey: params.requesterPubKey,
      recipientPrivKey: params.recipientPrivKey,
      globalPubKey: params.globalPubKey,
      threshold: params.threshold,
      timeoutMs: params.timeoutMs,
      feeOverride: params.feeOverride,
      onInvalidPartial: params.onInvalidPartial,
    });

    // Step 2: Parse JSON payload
    const payloadStr = new TextDecoder().decode(payloadBytes);
    const { cid, key: keyHex } = JSON.parse(payloadStr) as { cid: string; key: `0x${string}` };
    const key = fromHex(keyHex, "bytes");

    // Step 3: Download encrypted file from storage
    const encryptedFile = await params.storageProvider.download(cid);

    // Step 4: Verify CID integrity (if multiformats is available)
    if (!params.skipCidVerification) {
      let cidMod: any;
      let hashMod: any;
      try {
        cidMod = await import("multiformats/cid");
        hashMod = await import("multiformats/hashes/sha2");
      } catch {
        // multiformats not installed — skip verification
      }

      if (cidMod && hashMod) {
        const CID = cidMod.CID;
        const sha256 = hashMod.sha256;

        const expectedCid = CID.parse(cid);
        const hash = await sha256.digest(encryptedFile);
        const actualCid = CID.create(expectedCid.version, expectedCid.code, hash);

        if (!expectedCid.equals(actualCid)) {
          throw new CidIntegrityError(cid, String(actualCid));
        }
      }
    }

    // Step 5: Decrypt file
    const content = decryptFile({ ciphertext: encryptedFile, key });

    return { content, cid, txHash };
  }
}
