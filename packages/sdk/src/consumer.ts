import { parseEventLogs, toBytes, toHex, fromHex, type PublicClient, type WalletClient } from "viem";
import { cdrAbi, dkgAbi, contractAddresses, type Network } from "@piplabs/cdr-contracts";
import { decryptPartial as eciesDecrypt, tdh2Combine, verifyPartialSignature, decryptFile, generateEphemeralKeyPair, type TDH2Ciphertext, type DecryptedPartial } from "@piplabs/cdr-crypto";
import { PartialCollectionTimeoutError, InvalidParamsError, ObserverRequiredError, CidIntegrityError } from "./errors.js";
import type { PartialDecryptionEvent } from "./types.js";
import { uuidToLabel } from "./label.js";
import type { StorageProvider } from "./storage/types.js";
import { Observer } from "./observer.js";
import type { AttestationConfig } from "./attestation.js";
import { queryCDRPartials } from "./cosmos/abci-query.js";
import { bytesToHex as cosmosBytesToHex } from "./cosmos/protobuf.js";

export class Consumer {
  private publicClient: PublicClient;
  private walletClient: WalletClient;
  private network: Network;
  private observer: Observer | null;

  /**
   * Cached validator → commPubKey[] map. Built on first use and kept for the
   * Consumer instance's lifetime. Registered events are immutable, so the
   * only staleness risk is a new validator registering after the cache was
   * built; that surfaces as "unknown validator" during verify, which triggers
   * an automatic one-shot refresh (see collectPartialsFromEvents).
   */
  private commPubKeyMapCache: Map<string, Uint8Array[]> | null = null;

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
   * Each validator may re-register with a new commPubKey in each DKG round.
   * Partials are signed with the commPubKey active in the round that serviced
   * the read request, which is not necessarily the most recent round. The
   * signature-verify loop in collectPartialsFromEvents tries every key in the
   * returned array, so we must supply keys from every historical round — a
   * rolling lookback window can exclude the round a partial was signed under
   * and cause every verification to fail.
   *
   * We therefore scan the full history from genesis using chunked getLogs
   * calls to stay within RPC range limits.
   */
  /** Chunk size for historical getLogs scans. Kept well below typical RPC block-range limits. */
  private static readonly DKG_LOGS_BLOCK_CHUNK = 500_000n;

  /**
   * Return the cached commPubKey map, building it on first call or when
   * {@link forceRefresh} is true. Safe to call repeatedly.
   */
  private async getCommPubKeyMap(forceRefresh = false): Promise<Map<string, Uint8Array[]>> {
    if (!forceRefresh && this.commPubKeyMapCache) {
      return this.commPubKeyMapCache;
    }
    const dkgAddress = contractAddresses[this.network].dkg;
    this.commPubKeyMapCache = await this.fetchRegisteredValidators(dkgAddress);
    return this.commPubKeyMapCache;
  }

  private async fetchRegisteredValidators(
    dkgAddress: `0x${string}`,
  ): Promise<Map<string, Uint8Array[]>> {
    const latestBlock = await this.publicClient.getBlockNumber();
    const chunk = Consumer.DKG_LOGS_BLOCK_CHUNK;
    const validators = new Map<string, Uint8Array[]>();

    for (let from = 0n; from <= latestBlock; from = from + chunk + 1n) {
      const to = from + chunk > latestBlock ? latestBlock : from + chunk;

      const rawLogs = await this.publicClient.getLogs({
        address: dkgAddress,
        fromBlock: from,
        toBlock: to,
      });

      const parsed = parseEventLogs({
        abi: dkgAbi,
        logs: rawLogs,
        eventName: "Registered",
      });

      for (const log of parsed) {
        const addr = log.args.validatorAddr.toLowerCase() as `0x${string}`;
        const keys = validators.get(addr) ?? [];
        keys.push(toBytes(log.args.enclaveCommKey));
        validators.set(addr, keys);
      }
    }

    return validators;
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
        const rawLogs = await this.publicClient.getLogs({
          address: cdrAddress,
          fromBlock: lastScannedBlock,
          toBlock: currentBlock,
        });
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

              // Verify signature — try all known commPubKeys for this validator
              // (DKG round rotation may cause the signing key to differ from the latest registration)
              const validatorAddr = log.args.validator.toLowerCase();
              let commPubKeys = commPubKeyMap.get(validatorAddr);

              // Cache may be stale if a new validator registered after we
              // built the map. Refresh once per unknown validator per call.
              if ((!commPubKeys || commPubKeys.length === 0) && !refreshedFor.has(validatorAddr)) {
                refreshedFor.add(validatorAddr);
                commPubKeyMap = await this.getCommPubKeyMap(true);
                commPubKeys = commPubKeyMap.get(validatorAddr);
              }

              if (!commPubKeys || commPubKeys.length === 0) {
                onInvalidPartial?.(event, new Error(`unknown validator: ${log.args.validator}`));
                continue;
              }

              let valid = false;
              for (let ki = commPubKeys.length - 1; ki >= 0; ki--) {
                valid = verifyPartialSignature({
                  round: event.round,
                  ciphertext: toBytes(log.args.ciphertext),
                  encryptedPartial: toBytes(event.encryptedPartial),
                  ephemeralPubKey: toBytes(event.ephemeralPubKey),
                  pubShare: toBytes(event.pubShare),
                  signature: toBytes(log.args.signature),
                  commPubKey: commPubKeys[ki],
                });
                if (valid) break;
              }

              if (!valid) {
                onInvalidPartial?.(event, new Error(`invalid signature from validator ${log.args.validator}`));
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
