/**
 * End-to-end integration test for Consumer against a live network.
 *
 * Bootstraps a fresh vault via Uploader and then exercises the full
 * `accessCDR` flow (read tx → poll validator partials via Story-API
 * `/dkg/cdr_partials` → ECIES-decrypt each partial → TDH2-combine) and
 * verifies that the recovered data key matches the one written.
 *
 * Run all integration tests (from packages/sdk):
 *   pnpm test:integration
 *
 * Run only this file:
 *   pnpm test:integration consumer
 *
 * Required env (from `.env.local`):
 *   CDR_API_URL          — Story-API REST base URL
 *   CDR_RPC_URL          — EVM JSON-RPC URL on the same chain
 *   CDR_TEST_PRIVATE_KEY — funded wallet private key
 *
 * **Live-network preconditions** — this suite needs:
 *   - Active DKG round (stage=4) with TEE validators producing partials
 *   - DevNet not currently rotating mid-round-transition
 * If those break, this is the test that surfaces it. Failures here are
 * not necessarily SDK regressions; check DevNet health first.
 *
 * Cost model:
 *   - One open-condition contract deploy in beforeAll (~minimal gas)
 *   - One uploadCDR (~0.02 IP) + one accessCDR (~0.01 IP read fee + decrypt
 *     compute) per test
 */

import { describe, it, expect, beforeAll, vi } from "vitest";
import {
  createPublicClient,
  createWalletClient,
  http,
  toHex,
  type PublicClient,
  type WalletClient,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { generateEphemeralKeyPair } from "@piplabs/cdr-crypto";
import { CDRClient, initWasm } from "../src/index.js";
import { PartialCollectionTimeoutError, EmptyVaultError } from "../src/errors.js";
import { uuidToLabel } from "../src/label.js";
import { queryCDRPartials, queryLatestActiveDKGNetwork } from "../src/story-api/index.js";
import { logCase, countFetchCallsTo } from "./_helpers.js";

const API_URL = process.env.CDR_API_URL;
const RPC_URL = process.env.CDR_RPC_URL;
const PRIVATE_KEY = process.env.CDR_TEST_PRIVATE_KEY as `0x${string}` | undefined;

if (!API_URL) {
  throw new Error("CDR_API_URL is not set. Configure it in .env.local.");
}
if (!RPC_URL) {
  throw new Error("CDR_RPC_URL is not set. Configure it in .env.local.");
}
if (!PRIVATE_KEY) {
  throw new Error("CDR_TEST_PRIVATE_KEY is not set. Configure it in .env.local.");
}

function makeCDRClient(): {
  client: CDRClient;
  publicClient: PublicClient;
  walletClient: WalletClient;
} {
  const account = privateKeyToAccount(PRIVATE_KEY!);
  const publicClient = createPublicClient({
    transport: http(RPC_URL),
  }) as unknown as PublicClient;
  const walletClient = createWalletClient({
    account,
    transport: http(RPC_URL),
  }) as unknown as WalletClient;
  const client = new CDRClient({
    network: "testnet",
    publicClient,
    walletClient,
    apiUrl: API_URL!,
  });
  return { client, publicClient, walletClient };
}

/**
 * Deploy a minimal "always-true" condition contract — same pattern as
 * `__integration__/uploader.test.ts`. The runtime returns 32-byte `0x...01`
 * for any call, which the CDR contract reads as "condition met".
 */
async function deployOpenCondition(
  publicClient: PublicClient,
  walletClient: WalletClient,
): Promise<`0x${string}`> {
  const bytecode =
    "0x600a600c600039600a6000f3600160005260206000f3" as `0x${string}`;
  const txHash = await walletClient.sendTransaction({
    chain: walletClient.chain ?? null,
    account: walletClient.account ?? null,
    data: bytecode,
  });
  const receipt = await publicClient.waitForTransactionReceipt({ hash: txHash });
  if (!receipt.contractAddress) {
    throw new Error("Open-condition deployment did not produce a contractAddress");
  }
  return receipt.contractAddress;
}

describe(`Consumer integration tests (live: ${API_URL})`, () => {
  let openCondition: `0x${string}`;

  beforeAll(async () => {
    await initWasm();
    const { publicClient, walletClient } = makeCDRClient();
    openCondition = await deployOpenCondition(publicClient, walletClient);
    // eslint-disable-next-line no-console
    console.log(`\n[suite-setup] openCondition deployed at ${openCondition}\n`);
  }, 30_000);

  it(
    "accessCDR end-to-end: write a vault then read+decrypt, recover the original dataKey",
    async () => {
      const { client } = makeCDRClient();

      // ----- Write a fresh vault -----
      const globalPubKey = await client.observer.getGlobalPubKey();
      const dataKey = crypto.getRandomValues(new Uint8Array(32));
      logCase("input dataKey", dataKey);

      const upload = await client.uploader.uploadCDR({
        dataKey,
        globalPubKey,
        updatable: false,
        writeConditionAddr: openCondition,
        readConditionAddr: openCondition,
        writeConditionData: "0x",
        readConditionData: "0x",
        accessAuxData: "0x",
      });
      logCase("uploadCDR", {
        uuid: upload.uuid,
        txHashes: upload.txHashes,
        ciphertext: upload.ciphertext,
      });

      // ----- Read + decrypt via accessCDR (full SDK flow) -----
      const access = await client.consumer.accessCDR({
        uuid: upload.uuid,
        accessAuxData: "0x",
        // Generous timeout: read tx (~3s) + partial collection
        // (~10-30s depending on validator latency) + decrypt (sub-second).
        timeoutMs: 120_000,
        pollIntervalMs: 2_000,
      });
      logCase("accessCDR", {
        txHash: access.txHash,
        recoveredDataKey: access.dataKey,
      });

      // ----- Round-trip assertion -----
      expect(access.dataKey).toBeInstanceOf(Uint8Array);
      expect(access.dataKey.length).toBe(dataKey.length);
      expect(Array.from(access.dataKey)).toEqual(Array.from(dataKey));
      expect(access.txHash).toMatch(/^0x[0-9a-f]{64}$/);
    },
    180_000, // 3 min total — covers worst-case validator latency on DevNet
  );

  // -------------------------------------------------------------------------
  // accessCDR with explicit requesterPubKey + recipientPrivKey: same flow,
  // but caller manages the keypair instead of letting the SDK generate one
  // ephemerally. Used by long-lived applications that pre-distribute a
  // recipient pubkey to validators or want to reuse a derived key.
  // -------------------------------------------------------------------------

  it("accessCDR with explicit requesterPubKey + recipientPrivKey round-trips the same dataKey", async () => {
    const { client } = makeCDRClient();
    const globalPubKey = await client.observer.getGlobalPubKey();
    const dataKey = crypto.getRandomValues(new Uint8Array(32));

    const upload = await client.uploader.uploadCDR({
      dataKey,
      globalPubKey,
      updatable: false,
      writeConditionAddr: openCondition,
      readConditionAddr: openCondition,
      writeConditionData: "0x",
      readConditionData: "0x",
      accessAuxData: "0x",
    });
    logCase("upload.uuid", upload.uuid);

    const kp = generateEphemeralKeyPair();
    const requesterPubKey = toHex(kp.publicKey);
    logCase("explicit requesterPubKey", kp.publicKey);

    const access = await client.consumer.accessCDR({
      uuid: upload.uuid,
      accessAuxData: "0x",
      requesterPubKey,
      recipientPrivKey: kp.privateKey,
      timeoutMs: 120_000,
      pollIntervalMs: 2_000,
    });

    expect(access.dataKey.length).toBe(dataKey.length);
    expect(Array.from(access.dataKey)).toEqual(Array.from(dataKey));
    expect(access.txHash).toMatch(/^0x[0-9a-f]{64}$/);
  }, 180_000);

  // -------------------------------------------------------------------------
  // collectPartials timeout: with no read tx and a small timeoutMs, the
  // poll loop drains and throws PartialCollectionTimeoutError. Exercises
  // the error path against real REST polls (vs the unit-mocked timeout).
  // -------------------------------------------------------------------------

  it("collectPartials throws PartialCollectionTimeoutError when no read tx is in flight", async () => {
    const { client } = makeCDRClient();
    const globalPubKey = await client.observer.getGlobalPubKey();

    // Bootstrap a real vault so the EmptyVaultError fail-fast doesn't fire.
    // Use a fresh requesterPubKey (no read tx is sent) so the keeper never
    // produces partials for `(uuid, requesterPubKey)` — the matching bucket
    // stays empty and the poll loop drains to its timeout.
    const dataKey = crypto.getRandomValues(new Uint8Array(32));
    const upload = await client.uploader.uploadCDR({
      dataKey,
      globalPubKey,
      updatable: false,
      writeConditionAddr: openCondition,
      readConditionAddr: openCondition,
      writeConditionData: "0x",
      readConditionData: "0x",
      accessAuxData: "0x",
    });
    const requesterPubKey = toHex(generateEphemeralKeyPair().publicKey);
    const start = Date.now();

    await expect(
      client.consumer.collectPartials({
        uuid: upload.uuid,
        requesterPubKey,
        timeoutMs: 5_000,
        pollIntervalMs: 1_000,
      }),
    ).rejects.toThrow(PartialCollectionTimeoutError);

    const elapsed = Date.now() - start;
    logCase("elapsed (ms)", elapsed);
    // Confirm the loop actually waited the timeout (not a malformed-input
    // fast-fail). Lower bound 4s = timeout - 1 poll tick of slack.
    expect(elapsed).toBeGreaterThanOrEqual(4_000);
  }, 60_000);

  it("collectPartials throws EmptyVaultError fast when the uuid has no vault data", async () => {
    const { client } = makeCDRClient();
    const requesterPubKey = toHex(generateEphemeralKeyPair().publicKey);
    const start = Date.now();

    await expect(
      client.consumer.collectPartials({
        // Bogus uuid — vault.encryptedData reads as "0x" (empty bytes), so
        // the new EmptyVaultError fail-fast fires before any REST poll.
        uuid: 999_999_999,
        requesterPubKey,
        timeoutMs: 60_000,
        pollIntervalMs: 1_000,
      }),
    ).rejects.toThrow(EmptyVaultError);

    const elapsed = Date.now() - start;
    logCase("elapsed (ms)", elapsed);
    // Should fail almost immediately (single chain read), well under
    // the timeoutMs budget.
    expect(elapsed).toBeLessThan(5_000);
  }, 30_000);

  // -------------------------------------------------------------------------
  // prefetchRegistry: warms the registrations cache shared by Consumer's
  // attestation path AND Observer's getRegisteredValidators / -Attestations.
  // After prefetch, those reads should hit the per-round cache (zero
  // /registrations fetches).
  // -------------------------------------------------------------------------

  it("prefetchRegistry warms the registrations cache shared with Observer", async () => {
    const { client } = makeCDRClient();
    const fetchSpy = vi.spyOn(globalThis, "fetch");

    try {
      await client.consumer.prefetchRegistry();
      fetchSpy.mockClear();

      const [validators, attestations] = await Promise.all([
        client.observer.getRegisteredValidators(),
        client.observer.getValidatorAttestations(),
      ]);

      // Both Observer reads share the prefetched registrations cache; the
      // only fetches expected are getActiveRound's two /latest_active calls
      // (one per Promise.all branch — getActiveRound never caches the round
      // number itself).
      const regsCalls = countFetchCallsTo(fetchSpy, "/dkg/registrations");
      logCase("regs fetch count after prefetch", regsCalls);

      expect(regsCalls).toBe(0);
      expect(validators.size).toBeGreaterThan(0);
      expect(attestations.size).toBeGreaterThan(0);
    } finally {
      fetchSpy.mockRestore();
    }
  });

  // -------------------------------------------------------------------------
  // queryCDRPartials positive case: bootstrap a real read flow (vault →
  // read tx → validators submit), then probe the low-level REST endpoint
  // directly to verify the wire-shape of submissions. story-api.test.ts
  // only covers no-op cases (non-existent uuid / malformed pubkey); this
  // case lives here because it shares the open-condition setup.
  // -------------------------------------------------------------------------

  it("queryCDRPartials returns shape-correct submissions after a real read tx", async () => {
    const { client } = makeCDRClient();
    const globalPubKey = await client.observer.getGlobalPubKey();
    const dataKey = crypto.getRandomValues(new Uint8Array(32));
    logCase("setup.dataKey", dataKey);
    logCase("setup.globalPubKey", globalPubKey);

    const upload = await client.uploader.uploadCDR({
      dataKey,
      globalPubKey,
      updatable: false,
      writeConditionAddr: openCondition,
      readConditionAddr: openCondition,
      writeConditionData: "0x",
      readConditionData: "0x",
      accessAuxData: "0x",
    });
    logCase("setup.upload", {
      uuid: upload.uuid,
      txHashes: upload.txHashes,
      ciphertext: upload.ciphertext,
    });

    const kp = generateEphemeralKeyPair();
    const requesterPubKey = toHex(kp.publicKey);
    const requesterPubKeyHex = requesterPubKey.replace(/^0x/i, "");
    logCase("setup.requesterPubKey", kp.publicKey);

    const { txHash: readTxHash } = await client.consumer.read({
      uuid: upload.uuid,
      accessAuxData: "0x",
      requesterPubKey,
    });
    logCase("setup.readTxHash", readTxHash);

    // Poll the low-level endpoint directly until threshold is observed.
    const apiUrl = API_URL!;
    const pollStart = Date.now();
    const deadline = pollStart + 60_000;
    let pollCount = 0;
    let firstSubmissionSeenAtMs: number | undefined;
    let group:
      | Awaited<ReturnType<typeof queryCDRPartials>>[number]
      | undefined;
    while (Date.now() < deadline) {
      pollCount++;
      try {
        const groups = await queryCDRPartials({
          apiUrl,
          uuid: upload.uuid,
          requesterPubKeyHex,
        });
        if (
          firstSubmissionSeenAtMs === undefined &&
          groups.some((g) => g.submissions.length > 0)
        ) {
          firstSubmissionSeenAtMs = Date.now() - pollStart;
        }
        group = groups.find((g) => g.thresholdMet);
        if (group) break;
      } catch {
        // Transient — retry.
      }
      await new Promise((r) => setTimeout(r, 2_000));
    }

    expect(group).toBeDefined();
    expect(group!.thresholdMet).toBe(true);
    expect(group!.submissions.length).toBeGreaterThanOrEqual(group!.threshold);

    logCase("polling", {
      pollCount,
      firstSubmissionSeenAtMs,
      thresholdMetAtMs: Date.now() - pollStart,
    });
    logCase("group (full)", group);

    for (const sub of group!.submissions) {
      expect(sub.validator).toMatch(/^0x[0-9a-f]{40}$/);
      expect(sub.encryptedPartial).toBeInstanceOf(Uint8Array);
      expect(sub.encryptedPartial.length).toBeGreaterThan(0);
      expect(sub.ephemeralPubKey).toBeInstanceOf(Uint8Array);
      expect(sub.ephemeralPubKey.length).toBeGreaterThan(0);
      expect(sub.pubShare).toBeInstanceOf(Uint8Array);
      expect(sub.pubShare.length).toBeGreaterThan(0);
    }
  }, 180_000);

  // -------------------------------------------------------------------------
  // feeOverride plumbing on read: mirrors the uploader-side wrong-fee revert
  // case. The CDR contract checks vault data presence FIRST (verified via
  // cast call: a non-existent uuid reverts with "CDR: Vault has no data to
  // read"), so we upload a vault first, then attempt read() with off-by-1
  // wei. If feeOverride were ignored, the auto-query would have produced
  // the correct fee and the tx would land — the revert is the proof.
  // -------------------------------------------------------------------------

  it("read with a wrong feeOverride reverts (proves override is plumbed to msg.value)", async () => {
    const { client } = makeCDRClient();
    const dataKey = crypto.getRandomValues(new Uint8Array(32));

    const upload = await client.uploader.uploadCDR({
      dataKey,
      updatable: false,
      writeConditionAddr: openCondition,
      readConditionAddr: openCondition,
      writeConditionData: "0x",
      readConditionData: "0x",
      accessAuxData: "0x",
    });

    const readFee = await client.observer.getReadFee();
    const wrongFee = readFee + 1n; // off by 1 wei
    logCase("fees", { autoRead: readFee, wrongOverride: wrongFee });

    const requesterPubKey = toHex(generateEphemeralKeyPair().publicKey);

    await expect(
      client.consumer.read({
        uuid: upload.uuid,
        accessAuxData: "0x",
        requesterPubKey,
        feeOverride: wrongFee,
      }),
    ).rejects.toThrow(/Invalid fee amount/i);
  }, 60_000);

  // -------------------------------------------------------------------------
  // decryptDataKey called directly: bypasses accessCDR's bundled flow to
  // exercise the discrete API surface. Use case: decoupled architecture
  // where service A collects partials and service B does the decryption,
  // with partials handed off as plain data. This test bootstraps a vault
  // and collects partials normally, then feeds them into decryptDataKey
  // outside the accessCDR wrapper.
  // -------------------------------------------------------------------------

  it("decryptDataKey called directly with externally-collected partials recovers the original dataKey", async () => {
    const { client } = makeCDRClient();
    const dataKey = crypto.getRandomValues(new Uint8Array(32));

    const upload = await client.uploader.uploadCDR({
      dataKey,
      updatable: false,
      writeConditionAddr: openCondition,
      readConditionAddr: openCondition,
      writeConditionData: "0x",
      readConditionData: "0x",
      accessAuxData: "0x",
    });

    const kp = generateEphemeralKeyPair();
    const requesterPubKey = toHex(kp.publicKey);

    await client.consumer.read({
      uuid: upload.uuid,
      accessAuxData: "0x",
      requesterPubKey,
    });

    // Collect partials via the discrete collectPartials API, NOT accessCDR.
    const partials = await client.consumer.collectPartials({
      uuid: upload.uuid,
      requesterPubKey,
      timeoutMs: 60_000,
      pollIntervalMs: 2_000,
    });
    logCase("collected partials", {
      count: partials.length,
      validators: partials.map((p) => p.validator),
    });

    // Now decrypt offline using the discrete decryptDataKey API.
    // upload.ciphertext.label === uuidToLabel(uuid) by construction in uploadCDR,
    // so we don't need to recompute it.
    const globalPubKey = await client.observer.getGlobalPubKey();
    const recovered = await client.consumer.decryptDataKey({
      ciphertext: upload.ciphertext,
      partials,
      recipientPrivKey: kp.privateKey,
      globalPubKey,
      label: upload.ciphertext.label,
    });
    logCase("recovered dataKey", recovered);

    expect(recovered).toBeInstanceOf(Uint8Array);
    expect(Array.from(recovered)).toEqual(Array.from(dataKey));
  }, 180_000);

  // -------------------------------------------------------------------------
  // Mismatched keypair → fails to recover original dataKey.
  //
  // Documents the trust-model failure mode: validators encrypt partials TO
  // requesterPubKey via ECIES; if the consumer feeds in a privKey that
  // doesn't pair with that pubkey, ECIES decryption produces garbage bytes
  // (no AEAD auth tag), tdh2Combine processes the garbage, and either
  // throws on bad-point deserialization or yields a garbage dataKey that
  // doesn't match the original. This test pins down whichever empirical
  // behavior the implementation produces.
  // -------------------------------------------------------------------------

  it("accessCDR with mismatched requesterPubKey/recipientPrivKey fails to recover the original dataKey", async () => {
    const { client } = makeCDRClient();
    const dataKey = crypto.getRandomValues(new Uint8Array(32));

    const upload = await client.uploader.uploadCDR({
      dataKey,
      updatable: false,
      writeConditionAddr: openCondition,
      readConditionAddr: openCondition,
      writeConditionData: "0x",
      readConditionData: "0x",
      accessAuxData: "0x",
    });

    // Two independent keypairs; deliberately use mismatched halves.
    const k1 = generateEphemeralKeyPair();
    const k2 = generateEphemeralKeyPair();
    logCase("k1.publicKey (used as requesterPubKey)", k1.publicKey);
    logCase("k2.privateKey (used as recipientPrivKey, mismatched)", k2.privateKey);

    let recovered: Uint8Array | undefined;
    let error: unknown;
    try {
      const result = await client.consumer.accessCDR({
        uuid: upload.uuid,
        accessAuxData: "0x",
        requesterPubKey: toHex(k1.publicKey),
        recipientPrivKey: k2.privateKey,
        timeoutMs: 60_000,
        pollIntervalMs: 2_000,
      });
      recovered = result.dataKey;
    } catch (e) {
      error = e;
    }

    logCase("outcome", {
      threw: error !== undefined,
      errorMessage: error ? String((error as Error).message ?? error).slice(0, 200) : null,
      recoveredMatchesOriginal:
        recovered !== undefined &&
        Array.from(recovered).every((b, i) => b === dataKey[i]),
    });

    // Either path is acceptable as proof of failure — the SDK might throw
    // (bad point deserialization in tdh2Combine) or return successfully with
    // garbage bytes. The invariant: the original dataKey is NOT recovered.
    if (recovered !== undefined) {
      expect(Array.from(recovered)).not.toEqual(Array.from(dataKey));
    } else {
      expect(error).toBeDefined();
    }
  }, 180_000);

  // -------------------------------------------------------------------------
  // minThresholdRatio = 1: strictest setting — requires partials from ALL
  // participants before combine. On DevNet (3 TEE validators), this raises
  // the SDK-side threshold from the chain default (2) to 3. Verifies that
  // the SDK's AND-gate (`submissions.length >= sdkThreshold && thresholdMet`)
  // correctly waits for the higher SDK threshold and doesn't exit early at
  // the keeper's lower chain-threshold signal.
  // -------------------------------------------------------------------------

  it("accessCDR with minThresholdRatio=1 waits for partials from ALL validators and recovers the original dataKey", async () => {
    const account = privateKeyToAccount(PRIVATE_KEY!);
    const publicClient = createPublicClient({
      transport: http(RPC_URL),
    }) as unknown as PublicClient;
    const walletClient = createWalletClient({
      account,
      transport: http(RPC_URL),
    }) as unknown as WalletClient;
    const strictClient = new CDRClient({
      network: "testnet",
      publicClient,
      walletClient,
      apiUrl: API_URL!,
      minThresholdRatio: 1,
    });

    const network = await queryLatestActiveDKGNetwork({ apiUrl: API_URL! });
    const sdkThreshold = await strictClient.observer.getThreshold();
    logCase("thresholds", {
      total: network.total,
      chainThreshold: network.threshold,
      sdkThreshold,
    });
    // ratio=1 → ceil(total * 1) === total; threshold rises to total.
    expect(sdkThreshold).toBe(network.total);
    // Sanity: ratio actually had an effect (or at least matched chain).
    expect(sdkThreshold).toBeGreaterThanOrEqual(network.threshold);

    const dataKey = crypto.getRandomValues(new Uint8Array(32));
    const upload = await strictClient.uploader.uploadCDR({
      dataKey,
      updatable: false,
      writeConditionAddr: openCondition,
      readConditionAddr: openCondition,
      writeConditionData: "0x",
      readConditionData: "0x",
      accessAuxData: "0x",
    });
    logCase("upload.uuid", upload.uuid);

    // Pass an explicit keypair so we retain `requesterPubKey` for diagnostic
    // probing if accessCDR times out (ephemeral mode would discard it).
    const kp = generateEphemeralKeyPair();
    const requesterPubKey = toHex(kp.publicKey);
    const requesterPubKeyHex = requesterPubKey.replace(/^0x/i, "");

    // accessCDR must collect ALL `total` partials, not just `chainThreshold`.
    // Generous timeout: even one slow validator stalls the whole flow. On a
    // healthy DevNet (3/3 TEE validators responsive) this completes in
    // 30-60s; if it times out, dump the keeper's view so the failing
    // diagnostic includes which validators DID respond.
    try {
      const access = await strictClient.consumer.accessCDR({
        uuid: upload.uuid,
        accessAuxData: "0x",
        requesterPubKey,
        recipientPrivKey: kp.privateKey,
        timeoutMs: 120_000,
        pollIntervalMs: 2_000,
      });
      logCase("recovered dataKey", access.dataKey);
      expect(Array.from(access.dataKey)).toEqual(Array.from(dataKey));
    } catch (e) {
      // Strict threshold = total amplifies any single-validator slowness
      // into a timeout. Surface keeper state so the test report shows which
      // partials made it (and which didn't).
      const groups = await queryCDRPartials({
        apiUrl: API_URL!,
        uuid: upload.uuid,
        requesterPubKeyHex,
      });
      logCase("timeout diagnostic: keeper state at failure", groups);
      throw e;
    }
  }, 180_000);

  // -------------------------------------------------------------------------
  // Updatable vault: write → read (dataKey1) → write (dataKey2) → read again,
  // reusing the same requesterPubKey across both reads. Regression coverage
  // for #75: prior to the ciphertext-bucket filter, the second read could
  // pick up the first read's stale (round, ciphertext1) bucket and try to
  // combine those partials against the post-update vault ciphertext — yielding
  // either an `aes/gcm: invalid ghash tag` decrypt failure or, worse, a
  // recovered "dataKey1" that no longer matches what's on chain.
  //
  // This is also the only integration case that exercises `updatable: true` +
  // a follow-up `Uploader.write` for an in-place vault update.
  // -------------------------------------------------------------------------

  it(
    "accessCDR after vault update returns the new dataKey (regression #75)",
    async () => {
      const { client } = makeCDRClient();
      const globalPubKey = await client.observer.getGlobalPubKey();

      // ----- Initial upload (updatable=true) -----
      const dataKey1 = crypto.getRandomValues(new Uint8Array(32));
      const upload = await client.uploader.uploadCDR({
        dataKey: dataKey1,
        globalPubKey,
        updatable: true,
        writeConditionAddr: openCondition,
        readConditionAddr: openCondition,
        writeConditionData: "0x",
        readConditionData: "0x",
        accessAuxData: "0x",
      });
      const uuid = upload.uuid;
      const label = uuidToLabel(uuid);
      logCase("uuid", uuid);
      logCase("dataKey1", dataKey1);

      // ----- Reuse the same requester keypair across both reads. The bug
      // only triggers when the keeper indexes both buckets under the same
      // (uuid, requesterPubKey) — generating a fresh keypair would route
      // the second read into its own bucket and mask the issue. -----
      const kp = generateEphemeralKeyPair();
      const requesterPubKey = toHex(kp.publicKey);

      // ----- Read 1: should recover dataKey1 -----
      const access1 = await client.consumer.accessCDR({
        uuid,
        accessAuxData: "0x",
        requesterPubKey,
        recipientPrivKey: kp.privateKey,
        timeoutMs: 120_000,
        pollIntervalMs: 2_000,
      });
      logCase("access1.dataKey", access1.dataKey);
      expect(Array.from(access1.dataKey)).toEqual(Array.from(dataKey1));

      // ----- Update vault: encrypt fresh dataKey2 to the same label,
      // write it under the existing uuid. -----
      const dataKey2 = crypto.getRandomValues(new Uint8Array(32));
      const ciphertext2 = await client.uploader.encryptDataKey({
        dataKey: dataKey2,
        globalPubKey,
        label,
      });
      const updateTx = await client.uploader.write({
        uuid,
        accessAuxData: "0x",
        encryptedData: toHex(ciphertext2.raw),
      });
      logCase("updateTx", updateTx.txHash);
      logCase("dataKey2", dataKey2);
      expect(Array.from(dataKey1)).not.toEqual(Array.from(dataKey2));

      // ----- Read 2 with the SAME requesterPubKey. The keeper now holds
      // two buckets for (uuid, requesterPubKey): the original
      // (round, ciphertext1) and the new (round, ciphertext2). The SDK
      // must filter by ciphertext and decrypt against the post-update
      // value. -----
      const access2 = await client.consumer.accessCDR({
        uuid,
        accessAuxData: "0x",
        requesterPubKey,
        recipientPrivKey: kp.privateKey,
        timeoutMs: 120_000,
        pollIntervalMs: 2_000,
      });
      logCase("access2.dataKey", access2.dataKey);

      // Strict regression assertions:
      expect(Array.from(access2.dataKey)).toEqual(Array.from(dataKey2));
      expect(Array.from(access2.dataKey)).not.toEqual(Array.from(dataKey1));
    },
    300_000,
  );

  // -------------------------------------------------------------------------
  // File-based vault APIs (`Consumer.downloadFile`) are intentionally not
  // exercised here. The SDK only exposes the `StorageProvider` interface;
  // concrete adapters (Helia, Storacha, Synapse, …) are supplied by the
  // consuming application. Integration testing of those adapters is the
  // consumer's responsibility, not the SDK's.
  //
  // Cases handled in unit tests rather than here (need fault-injection or
  // depend on a specific validator build):
  //   - attestationConfig with known MRENCLAVE/MRSIGNER (fragile across builds)
  //   - onInvalidPartial callback path (requires a known-bad validator)
  //   - collectPartials AND-gate edge (length>=t but thresholdMet=false)
  //   - DKG round rollover during a single read (#76 — bucket round
  //     threshold differs from active round threshold). Rollover happens
  //     on a chain-driven timer (~5 min on DevNet) and can't be reliably
  //     triggered mid-test — covered in unit tests via mocked observer.
});
