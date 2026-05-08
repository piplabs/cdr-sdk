import { toBytes, toHex, fromHex, type PublicClient, type WalletClient } from "viem";
import { cdrAbi, contractAddresses, type Network } from "@piplabs/cdr-contracts";
import {
  decryptPartial as eciesDecrypt,
  tdh2Combine,
  decryptFile,
  generateEphemeralKeyPair,
  type TDH2Ciphertext,
  type DecryptedPartial,
} from "@piplabs/cdr-crypto";
import {
  PartialCollectionTimeoutError,
  InvalidParamsError,
  CidIntegrityError,
  EmptyVaultError,
} from "./errors.js";
import type { PartialDecryptionEvent } from "./types.js";
import { uuidToLabel } from "./label.js";
import type { StorageProvider } from "./storage/types.js";
import { Observer } from "./observer.js";
import { verifyAttestation, type AttestationConfig } from "./attestation.js";
import { queryCDRPartials } from "./story-api/client.js";
import type { DKGPartialDecryptionSubmission } from "./story-api/types.js";

/**
 * Consumer reads encrypted vault data from the CDR contract and recovers the
 * data key by collecting validator partial decryptions through the
 * Story-API REST endpoint.
 *
 * ## Trust model
 *
 * Partial decryptions are read from `/dkg/cdr_partials` — the keeper has
 * already verified each validator's signature on ingress (see
 * `story/client/x/dkg/keeper/dkg_handler.go::PartialDecryptionSubmitted`)
 * and dropped the signature bytes. The SDK trusts the keeper at the same
 * level as any other authoritative chain RPC read.
 *
 * The SDK also trusts the keeper to index submissions correctly by
 * `(uuid, requesterPubKey)`. The response payload does not carry
 * `requesterPubKey` per submission, so the SDK relies on the query-side
 * filter being honored. A misrouted partial (encrypted to a different
 * reader's pubkey) would not yield a meaningful ECIES decryption with this
 * consumer's `recipientPrivKey`; the resulting garbage bytes would propagate
 * through {@link decryptDataKey}'s `tdh2Combine` and ultimately fail at the
 * outermost AES-GCM auth check when decrypting the vault payload. There is
 * no explicit early-fail check inside {@link collectPartials} for this case.
 *
 * Optional defense-in-depth: pass `attestationConfig` to `collectPartials`
 * to verify each validator's SGX enclave (MRENCLAVE / MRSIGNER / SVN)
 * before accepting their partials. Attestation is checked once per round
 * (the per-round registrations cache is shared with
 * {@link Observer.getValidatorAttestations}, so this is free) and an
 * un-trusted validator's partial is reported via `onInvalidPartial`.
 */
export class Consumer {
  private publicClient: PublicClient;
  private walletClient: WalletClient;
  private network: Network;
  private observer: Observer;
  private apiUrl: string;

  /** Alias for {@link accessCDR} */
  readVault: Consumer["accessCDR"];
  /** Alias for {@link downloadFile} */
  readFileVault: Consumer["downloadFile"];

  constructor(params: {
    network: Network;
    publicClient: PublicClient;
    walletClient: WalletClient;
    /** Observer instance — required. Provides round-keyed registrations / attestations cache. */
    observer: Observer;
    /** Story-API REST base URL, e.g. `"http://node:1317"`. */
    apiUrl: string;
  }) {
    this.publicClient = params.publicClient;
    this.walletClient = params.walletClient;
    this.network = params.network;
    this.observer = params.observer;
    this.apiUrl = params.apiUrl;
    this.readVault = this.accessCDR.bind(this);
    this.readFileVault = this.downloadFile.bind(this);
  }

  /**
   * Warm the validator commPubKey + attestation cache for the active round.
   *
   * The first `accessCDR` / `downloadFile` call after construction would
   * otherwise stall on this fetch. Frontends that know a read is imminent
   * (e.g. right after wallet connection) can call `prefetchRegistry()` in
   * the background so the subsequent decryption returns from a warm cache.
   *
   * Safe to call repeatedly — Observer's per-round cache plus its in-flight
   * Promise dedup ensure only one REST request is in flight at any time.
   *
   * @example
   * ```ts
   * cdrClient.consumer.prefetchRegistry().catch(() => {});  // best-effort
   * ```
   */
  async prefetchRegistry(): Promise<void> {
    await this.observer.getRegisteredValidators();
  }

  /**
   * Send the CDR `read` transaction for a vault, which prompts validators
   * to submit encrypted partial decryptions.
   *
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
    /**
     * Explicit read fee. Skips the auto-query for `readFee()`. NOT a way
     * to pay a different amount — the CDR contract requires
     * `msg.value == readFee` exactly and rejects mismatches with
     * "Invalid fee amount". Use this to skip a duplicate RPC when the
     * caller already has the fee value.
     */
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
   * Poll Story-API `/dkg/cdr_partials` until the keeper has surfaced at
   * least the threshold worth of submissions for the given
   * `(uuid, requesterPubKey)` whose `(round, ciphertext)` matches the
   * vault's current state.
   *
   * **Bucket selection**: the keeper indexes submissions by
   * `(round, ciphertext)`. Multiple groups can be returned across round
   * transitions or after a vault update on an updatable vault. The vault's
   * current `encryptedData` is loaded once at the start of this call and
   * pinned for the rest of the poll loop; only groups whose `ciphertext`
   * matches that value are accepted. If multiple groups match (same
   * ciphertext, different rounds — rare), the highest round is preferred.
   *
   * **Threshold**: derived from `observer.getThresholdAt(group.round)`,
   * not the active round. So a DKG rollover during the poll doesn't make
   * us measure the bucket against a different round's threshold.
   *
   * **Exit condition** (both must hold for the matching bucket):
   *   1. `submissions.length >= round-aware threshold`
   *   2. keeper-reported `thresholdMet === true`
   *
   * Returns the first N submissions from the matching bucket (where N is
   * the round's threshold) — extras are dropped on the floor (the keeper
   * guarantees order, so the first N are stable).
   *
   * **Vault-state guarantees**: the vault is read **once** at the start of
   * this call. If the vault is updated mid-poll, this call still resolves
   * against the original ciphertext (atomic semantics). If the user wants
   * to decrypt the new state, they must issue a fresh `accessCDR` after
   * the update.
   *
   * **`attestationConfig`** (optional defense-in-depth): when provided,
   * the round's validator attestation reports are verified once via
   * {@link verifyAttestation} and a trust set is built; un-trusted
   * validators' partials are reported via `onInvalidPartial` and excluded.
   *
   * @throws {@link EmptyVaultError} if the vault has never been written to
   *   (`encryptedData` is empty bytes). Fail-fast — better UX than waiting
   *   for the poll to time out against a non-existent bucket.
   *
   * @example
   * ```ts
   * const partials = await consumer.collectPartials({
   *   uuid: 42,
   *   requesterPubKey: "0x04...",
   *   timeoutMs: 60_000,
   * });
   * // partials[i].ciphertext is the same for every i — caller can use it
   * // for the subsequent decryptDataKey step without re-reading the chain.
   * ```
   */
  async collectPartials(params: {
    uuid: number;
    requesterPubKey: `0x${string}`;
    timeoutMs?: number;
    pollIntervalMs?: number;
    onInvalidPartial?: (event: PartialDecryptionEvent, error: Error) => void;
    attestationConfig?: AttestationConfig;
    /**
     * @internal Pre-loaded vault ciphertext from a containing call (e.g.
     * `accessCDR`'s preflight). When set, the polling loop filters
     * buckets against this value and skips the otherwise-mandatory
     * vault read. This exists so a single `accessCDR` invocation can
     * pin one vault-state snapshot across preflight + filter + decrypt
     * (avoiding an SDK-side race when the vault is updated between
     * those steps for an `updatable` vault). External callers should
     * omit it — `collectPartials` will then load the vault itself and
     * provide its own atomic snapshot.
     */
    pinnedCiphertext?: Uint8Array;
  }): Promise<PartialDecryptionEvent[]> {
    const {
      uuid,
      requesterPubKey,
      timeoutMs = 60_000,
      pollIntervalMs = 3_000,
      onInvalidPartial,
      attestationConfig,
      pinnedCiphertext,
    } = params;

    if (!requesterPubKey) {
      throw new InvalidParamsError("collectPartials: requesterPubKey is required");
    }

    // Pin the vault's current ciphertext for the entire poll loop. The
    // keeper indexes buckets by (round, ciphertext); we filter on this
    // value so a concurrent vault update can't silently change which
    // bucket we accept. If a containing call already pinned a snapshot
    // (e.g. `accessCDR` did its preflight before submitting `read()`),
    // reuse it — that closes the SDK-side race window between
    // preflight and the read tx mining.
    const vaultCiphertext = pinnedCiphertext ?? (await this.loadAndCheckVault(uuid));

    const requesterPubKeyHex = requesterPubKey.replace(/^0x/i, "");
    const deadline = Date.now() + timeoutMs;

    /** Per-round trust set; only populated when attestationConfig is set. */
    const trustSetByRound = new Map<number, Set<string>>();
    /** `(validator, pid)` keys we've already reported via onInvalidPartial. */
    const reported = new Set<string>();
    /** Last-known submission count (within the matching bucket), for the timeout error. */
    let lastSeen = 0;
    /** Last-known round threshold, for the timeout error. */
    let lastNeeded = 0;

    while (Date.now() < deadline) {
      let groups: Awaited<ReturnType<typeof queryCDRPartials>> = [];
      try {
        groups = await queryCDRPartials({
          apiUrl: this.apiUrl,
          uuid,
          requesterPubKeyHex,
        });
      } catch {
        // Transient REST error — retry on next poll tick.
      }

      // Filter to groups whose ciphertext matches the pinned vault state.
      // If multiple match (same ciphertext, different rounds — possible when
      // a vault stays unchanged across a DKG rollover), prefer the newest
      // round; older-round validators may have rotated out by the time we
      // try to combine.
      const matching = groups
        .filter((g) => g.submissions.length > 0 && bytesEqual(g.ciphertext, vaultCiphertext))
        .sort((a, b) => b.round - a.round);
      const group = matching[0];

      if (group) {
        lastSeen = group.submissions.length;

        // Bucket-aware threshold: evaluate against the bucket's own round,
        // not the active round (which may have advanced past the bucket
        // mid-poll).
        const sdkThreshold = await this.observer.getThresholdAt(group.round);
        lastNeeded = sdkThreshold;

        if (group.submissions.length >= sdkThreshold && group.thresholdMet) {
          const trustSet = attestationConfig
            ? await this.getTrustSet(group.round, attestationConfig, trustSetByRound)
            : undefined;

          const accepted: PartialDecryptionEvent[] = [];
          for (const sub of group.submissions) {
            const event = submissionToEvent(sub, uuid);
            if (trustSet && !trustSet.has(sub.validator)) {
              const dedupeKey = `${sub.validator}-${sub.pid}`;
              if (!reported.has(dedupeKey)) {
                reported.add(dedupeKey);
                onInvalidPartial?.(
                  event,
                  new Error(`attestation rejected for validator ${sub.validator}`),
                );
              }
              continue;
            }
            accepted.push(event);
          }

          if (accepted.length >= sdkThreshold) {
            return accepted.slice(0, sdkThreshold);
          }
          // Not enough trusted partials this poll — keep waiting; more
          // validators may still submit, and the trust set is fixed for
          // this round so newly-arrived partials reuse the same checks.
        }
      }

      await sleep(pollIntervalMs);
    }

    throw new PartialCollectionTimeoutError(lastSeen, lastNeeded, timeoutMs);
  }

  /**
   * Read the vault's current ciphertext and reject early if it has none.
   * Single source of truth for the `EmptyVaultError` gate, called from
   * `accessCDR` (preflight before the fee-bearing `read()` tx) and
   * `collectPartials` (defense-in-depth — direct callers benefit too).
   */
  private async loadAndCheckVault(uuid: number): Promise<Uint8Array> {
    const vault = (await this.publicClient.readContract({
      address: contractAddresses[this.network].cdr,
      abi: cdrAbi,
      functionName: "vaults",
      args: [uuid],
    })) as { encryptedData: `0x${string}` };
    const ciphertext = toBytes(vault.encryptedData);
    if (ciphertext.length === 0) {
      throw new EmptyVaultError(uuid);
    }
    return ciphertext;
  }

  /**
   * Build (and cache) the set of validators whose attestation passes the
   * configured checks for a given round. The attestations are read from
   * Observer's per-round cache, so this is a free hit alongside any
   * `getRegisteredValidators({round})` call within the same flow.
   */
  private async getTrustSet(
    round: number,
    config: AttestationConfig,
    cache: Map<number, Set<string>>,
  ): Promise<Set<string>> {
    const cached = cache.get(round);
    if (cached) return cached;
    const trusted = new Set<string>();
    const attestations = await this.observer.getValidatorAttestations({ round });
    for (const [addr, report] of attestations) {
      const result = await verifyAttestation(report, config);
      if (result.valid) trusted.add(addr);
    }
    cache.set(round, trusted);
    return trusted;
  }

  /**
   * Decrypt collected partials and combine to recover the original data key.
   *
   * The TDH2 combine threshold is taken implicitly as `partials.length`:
   * the SDK's `collectPartials` always returns exactly the threshold count
   * needed for reconstruction, and `tdh2Combine` requires `threshold ≤
   * partials.length`. Any value larger than `partials.length` would throw
   * `InsufficientPartialsError`; any value smaller would discard partials
   * the caller went to the trouble of collecting. Caller's responsibility:
   * pass exactly the partials they want combined.
   *
   * @example
   * ```ts
   * const dataKey = await consumer.decryptDataKey({
   *   ciphertext: { raw: encryptedData, label },
   *   partials,
   *   recipientPrivKey,
   *   globalPubKey,
   *   label,
   * });
   * ```
   */
  async decryptDataKey(params: {
    ciphertext: TDH2Ciphertext;
    partials: PartialDecryptionEvent[];
    recipientPrivKey: Uint8Array;
    globalPubKey: Uint8Array;
    label: Uint8Array;
  }): Promise<Uint8Array> {
    const { ciphertext, partials, recipientPrivKey, globalPubKey, label } = params;

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
      threshold: partials.length,
    });
  }

  /**
   * Convenience: read + collect + decrypt in one call.
   * If `requesterPubKey`/`recipientPrivKey` are omitted, an ephemeral
   * secp256k1 keypair is generated and the private key is zeroed after use.
   * If `globalPubKey` is omitted, it is auto-queried via the Observer.
   *
   * The vault is preflight-checked with one chain read before any
   * fee-bearing `read()` tx is submitted. For empty / non-existent
   * vaults this throws `EmptyVaultError` synchronously (no tx, no fee).
   *
   * @throws {@link EmptyVaultError} if the uuid's vault has no
   *   `encryptedData`. Raised before submitting `read()`.
   *
   * @example
   * ```ts
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
    timeoutMs?: number;
    /** See {@link read}'s `feeOverride` — same strict-equality semantics. */
    feeOverride?: bigint;
    onInvalidPartial?: (event: PartialDecryptionEvent, error: Error) => void;
    attestationConfig?: AttestationConfig;
  }): Promise<{ dataKey: Uint8Array; txHash: `0x${string}` }> {
    if (
      (params.requesterPubKey && !params.recipientPrivKey) ||
      (!params.requesterPubKey && params.recipientPrivKey)
    ) {
      throw new InvalidParamsError(
        "requesterPubKey and recipientPrivKey must both be provided or both omitted",
      );
    }

    let recipientPrivKey = params.recipientPrivKey;
    let requesterPubKey = params.requesterPubKey;
    let ephemeralGenerated = false;
    if (!recipientPrivKey || !requesterPubKey) {
      const kp = generateEphemeralKeyPair();
      recipientPrivKey = kp.privateKey;
      requesterPubKey = toHex(kp.publicKey);
      ephemeralGenerated = true;
    }

    const globalPubKey =
      params.globalPubKey ?? (await this.observer.getGlobalPubKey());

    try {
      // Preflight the vault state BEFORE submitting a fee-bearing `read()`
      // tx and pin the ciphertext for the whole flow. Reusing this single
      // snapshot for the bucket filter (via `pinnedCiphertext`) and the
      // decrypt step closes the SDK-side race that would otherwise exist
      // between this preflight, the read tx mining, and a later vault
      // re-read inside `collectPartials` — see #79.
      const vaultCiphertext = await this.loadAndCheckVault(params.uuid);

      const label = uuidToLabel(params.uuid);

      const { txHash } = await this.read({
        uuid: params.uuid,
        accessAuxData: params.accessAuxData,
        requesterPubKey,
        feeOverride: params.feeOverride,
      });

      const partials = await this.collectPartials({
        uuid: params.uuid,
        requesterPubKey,
        timeoutMs: params.timeoutMs,
        onInvalidPartial: params.onInvalidPartial,
        attestationConfig: params.attestationConfig,
        pinnedCiphertext: vaultCiphertext,
      });

      const dataKey = await this.decryptDataKey({
        ciphertext: { raw: vaultCiphertext, label },
        partials,
        recipientPrivKey,
        globalPubKey,
        label,
      });

      return { dataKey, txHash };
    } finally {
      if (ephemeralGenerated && recipientPrivKey) {
        recipientPrivKey.fill(0);
      }
    }
  }

  /**
   * Convenience: access vault, parse CID + key payload, download from
   * storage, and decrypt file.
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
    storageProvider: StorageProvider;
    timeoutMs?: number;
    /** See {@link read}'s `feeOverride` — same strict-equality semantics. */
    feeOverride?: bigint;
    onInvalidPartial?: (event: PartialDecryptionEvent, error: Error) => void;
    attestationConfig?: AttestationConfig;
    /** Skip CID integrity verification of downloaded file (default: false). */
    skipCidVerification?: boolean;
  }): Promise<{
    content: Uint8Array;
    cid: string;
    txHash: `0x${string}`;
  }> {
    const { dataKey: payloadBytes, txHash } = await this.accessCDR({
      uuid: params.uuid,
      accessAuxData: params.accessAuxData,
      requesterPubKey: params.requesterPubKey,
      recipientPrivKey: params.recipientPrivKey,
      globalPubKey: params.globalPubKey,
      timeoutMs: params.timeoutMs,
      feeOverride: params.feeOverride,
      onInvalidPartial: params.onInvalidPartial,
      attestationConfig: params.attestationConfig,
    });

    const payloadStr = new TextDecoder().decode(payloadBytes);
    const { cid, key: keyHex } = JSON.parse(payloadStr) as { cid: string; key: `0x${string}` };
    const key = fromHex(keyHex, "bytes");

    const encryptedFile = await params.storageProvider.download(cid);

    if (!params.skipCidVerification) {
      let cidMod: typeof import("multiformats/cid") | undefined;
      let hashMod: typeof import("multiformats/hashes/sha2") | undefined;
      try {
        cidMod = await import("multiformats/cid");
        hashMod = await import("multiformats/hashes/sha2");
      } catch {
        // multiformats not installed — skip verification.
      }

      if (cidMod && hashMod) {
        const expectedCid = cidMod.CID.parse(cid);
        const hash = await hashMod.sha256.digest(encryptedFile);
        const actualCid = cidMod.CID.create(expectedCid.version, expectedCid.code, hash);
        if (!expectedCid.equals(actualCid)) {
          throw new CidIntegrityError(cid, String(actualCid));
        }
      }
    }

    const content = decryptFile({ ciphertext: encryptedFile, key });
    return { content, cid, txHash };
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function submissionToEvent(
  sub: DKGPartialDecryptionSubmission,
  uuid: number,
): PartialDecryptionEvent {
  return {
    validator: sub.validator,
    round: sub.round,
    pid: sub.pid,
    encryptedPartial: toHex(sub.encryptedPartial),
    ephemeralPubKey: toHex(sub.ephemeralPubKey),
    pubShare: toHex(sub.pubShare),
    uuid,
    ciphertext: toHex(sub.ciphertext),
  };
}

function bytesEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
