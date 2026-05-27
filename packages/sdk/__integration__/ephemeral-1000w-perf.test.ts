/**
 * 1000-wallet perf test: 1000 ephemeral wallets concurrently read one
 * shared vault. The bigger sibling of `ephemeral-100w-shared.test.ts` —
 * same shape, 10x the fan-out, plus a final summary block that breaks
 * out the cost model and latency distribution.
 *
 * Suite gating: `1000-wallet-performance-devnet-only` (and `all`), DevNet only.
 *
 * Why batch the funding:
 *   Multicall3.aggregate3Value with 1000 inner calls costs ~50M gas — past
 *   Story's per-block gas limit (~30M). The test splits the 1000 wallets
 *   into FUND_BATCH_SIZE-sized chunks and submits each chunk as its own
 *   Multicall3 tx. The funder's nonce stream stays monotonic across the
 *   batches because fundWallets uses the funder's walletClient sequentially.
 *
 * Why batch the refunds the same way:
 *   `refundWallets` already does cross-wallet parallel sweeps, one tx per
 *   ephemeral wallet — that's 1000 concurrent send txs across 1000 distinct
 *   senders. The RPC node may rate-limit; we surface the count of failed
 *   sweeps but never throw on them.
 *
 * Final summary block prints:
 *   - access latency p50 / p95 / p99 / mean / max / min
 *   - failure count + first 5 failure reasons (if any)
 *   - refund recovery: total IP returned + failed sweep count
 *   - cost model: funded total vs. refunded total → IP burned by reads
 */

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  type PublicClient,
  type WalletClient,
  createPublicClient,
  createWalletClient,
  formatEther,
  http,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { CDRClient, initWasm } from "../src/index.js";
import { skipUnlessSuite, NETWORK } from "./_suite.js";
import {
  type EphemeralWallet,
  fundWallets,
  generateEphemeralWallets,
  refundWallets,
} from "./_ephemeral-wallets.js";
import {
  formatMs,
  logCase,
  max as arrMax,
  mean,
  p50,
  p95,
  p99,
  sizeFundAndReport,
  statsOf,
  writePerfStats,
} from "./_helpers.js";

const WALLET_COUNT = 1000;
// 200-wallet batch keeps Multicall3.aggregate3Value tx-gas ≲ 12M, well
// under Story's ~30M block gas limit on both DevNet + Aeneid.
const FUND_BATCH_SIZE = 200;
const CYCLES_PER_WALLET = 1; // 1 accessCDR per wallet, no upload
const ACCESS_TIMEOUT_MS = 300_000;

const API_URL = process.env.CDR_API_URL;
const RPC_URL = process.env.CDR_RPC_URL;
const FUNDER_KEY = process.env.CDR_TEST_PRIVATE_KEY as
  | `0x${string}`
  | undefined;

if (!API_URL) throw new Error("CDR_API_URL is not set");
if (!RPC_URL) throw new Error("CDR_RPC_URL is not set");
if (!FUNDER_KEY) throw new Error("CDR_TEST_PRIVATE_KEY is not set");

function makeFunderClient(): {
  client: CDRClient;
  publicClient: PublicClient;
  walletClient: WalletClient;
} {
  const account = privateKeyToAccount(FUNDER_KEY!);
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

function makeWalletClient(wallet: EphemeralWallet): CDRClient {
  const publicClient = createPublicClient({
    transport: http(RPC_URL),
  }) as unknown as PublicClient;
  const walletClient = createWalletClient({
    account: wallet.account,
    transport: http(RPC_URL),
  }) as unknown as WalletClient;
  return new CDRClient({
    network: "testnet",
    publicClient,
    walletClient,
    apiUrl: API_URL!,
  });
}

async function deployOpenCondition(
  publicClient: PublicClient,
  walletClient: WalletClient,
): Promise<`0x${string}`> {
  const bytecode =
    "0x600a600c600039600a6000f3600160005260206000f3" as `0x${string}`;
  const tx = await walletClient.sendTransaction({
    chain: walletClient.chain ?? null,
    account: walletClient.account ?? null,
    data: bytecode,
  });
  const receipt = await publicClient.waitForTransactionReceipt({ hash: tx });
  if (!receipt.contractAddress) {
    throw new Error("Open-condition deploy: receipt missing contractAddress");
  }
  return receipt.contractAddress;
}

/**
 * Fund `wallets` in chunks of `batchSize` via repeated Multicall3 txs.
 * Returns the sum of totalFundedWei across all batches (sanity-check).
 */
async function fundInBatches(
  publicClient: PublicClient,
  walletClient: WalletClient,
  wallets: EphemeralWallet[],
  perWalletWei: bigint,
  batchSize: number,
): Promise<bigint> {
  let totalFunded = 0n;
  for (let i = 0; i < wallets.length; i += batchSize) {
    const slice = wallets.slice(i, i + batchSize);
    const fund = await fundWallets(
      publicClient,
      walletClient,
      slice,
      perWalletWei,
    );
    totalFunded += fund.totalFundedWei;
  }
  return totalFunded;
}

describe.skipIf(skipUnlessSuite("1000-wallet-performance-devnet-only") || NETWORK !== "devnet")(
  `1000 ephemeral wallets → shared vault read perf (network=${NETWORK})`,
  () => {
    let funderPublic: PublicClient;
    let funderWallet: WalletClient;
    let funderClient: CDRClient;
    let funderAddress: `0x${string}`;
    let openCondition: `0x${string}`;
    let sharedVaultUuid: number;
    let sharedDataKey: Uint8Array;
    let wallets: EphemeralWallet[];
    let perWalletFund = 0n;
    let totalFundedWei = 0n;
    let perfBuffer: {
      fulfilled: number;
      failed: number;
      wallClockMs: number;
      accessLats: number[];
      failedReasons: Array<{ idx: number; reason: string }>;
    } | null = null;

    beforeAll(async () => {
      await initWasm();
      const f = makeFunderClient();
      funderPublic = f.publicClient;
      funderWallet = f.walletClient;
      funderClient = f.client;
      funderAddress = privateKeyToAccount(FUNDER_KEY!).address;

      // Flat per-wallet fund = 1 IP + 3 × (writeFee + allocateFee + readFee).
      // Read-only suite over-funds by writeFee+allocateFee × 3 at current
      // chain fees, which is fine — 1 IP base dominates anyway.
      perWalletFund = await sizeFundAndReport({
        label: "1000w-perf",
        network: NETWORK,
        publicClient: funderPublic,
      });

      openCondition = await deployOpenCondition(funderPublic, funderWallet);
      logCase("openCondition", openCondition);

      sharedDataKey = crypto.getRandomValues(new Uint8Array(32));
      const globalPubKey = await funderClient.observer.getGlobalPubKey();
      const upload = await funderClient.uploader.uploadCDR({
        dataKey: sharedDataKey,
        globalPubKey,
        updatable: false,
        writeConditionAddr: openCondition,
        readConditionAddr: openCondition,
        writeConditionData: "0x",
        readConditionData: "0x",
        accessAuxData: "0x",
      });
      sharedVaultUuid = upload.uuid;
      logCase("shared vault uuid", sharedVaultUuid);

      wallets = generateEphemeralWallets(WALLET_COUNT);
      const fundStart = Date.now();
      totalFundedWei = await fundInBatches(
        funderPublic,
        funderWallet,
        wallets,
        perWalletFund,
        FUND_BATCH_SIZE,
      );
      logCase("multicall3 batched fund", {
        wallets: wallets.length,
        batchSize: FUND_BATCH_SIZE,
        batches: Math.ceil(wallets.length / FUND_BATCH_SIZE),
        perWallet: formatEther(perWalletFund),
        totalIP: formatEther(totalFundedWei),
        elapsedMs: formatMs(Date.now() - fundStart),
      });
    }, 20 * 60 * 1000);

    afterAll(async () => {
      if (!wallets || wallets.length === 0) return;
      const refundStart = Date.now();
      const refund = await refundWallets(
        funderPublic,
        wallets,
        funderAddress,
        RPC_URL!,
      );
      logCase("refund summary", {
        totalRefundedIP: formatEther(refund.totalRefundedWei),
        totalFundedIP: formatEther(totalFundedWei),
        burnedIP: formatEther(totalFundedWei - refund.totalRefundedWei),
        failedRefunds: refund.failedRefunds,
        refundElapsedMs: formatMs(Date.now() - refundStart),
      });
      if (perfBuffer) {
        writePerfStats({
          label: "1000w-perf",
          network: NETWORK,
          wallets: WALLET_COUNT,
          fulfilled: perfBuffer.fulfilled,
          failed: perfBuffer.failed,
          wall_clock_ms: perfBuffer.wallClockMs,
          accessMs: statsOf(perfBuffer.accessLats),
          uploadMs: null,
          accessSharedMs: null,
          accessFreshMs: null,
          tickMs: null,
          refund: {
            funded_wei: totalFundedWei.toString(),
            refunded_wei: refund.totalRefundedWei.toString(),
            burned_wei: (totalFundedWei - refund.totalRefundedWei).toString(),
            failed_sweeps: refund.failedRefunds,
          },
          extra: null,
          failedReasons: perfBuffer.failedReasons,
        });
      }
    }, 15 * 60 * 1000);

    it(
      `${WALLET_COUNT} concurrent accessCDR calls on the same uuid all recover the same dataKey`,
      async () => {
        const runStart = Date.now();
        const results = await Promise.allSettled(
          wallets.map(async (w) => {
            const client = makeWalletClient(w);
            const t0 = Date.now();
            const access = await client.consumer.accessCDR({
              uuid: sharedVaultUuid,
              accessAuxData: "0x",
              timeoutMs: ACCESS_TIMEOUT_MS,
            });
            return { address: w.address, dur: Date.now() - t0, dataKey: access.dataKey };
          }),
        );

        const fulfilled = results.flatMap((r) =>
          r.status === "fulfilled" ? [r.value] : [],
        );
        const failed = results.flatMap((r, i) =>
          r.status === "rejected"
            ? [
                {
                  idx: i,
                  reason:
                    r.reason instanceof Error
                      ? r.reason.message
                      : String(r.reason),
                },
              ]
            : [],
        );
        const totalMs = Date.now() - runStart;
        const lats = fulfilled.map((r) => r.dur);

        const mismatch = fulfilled.filter(
          (r) =>
            r.dataKey.length !== sharedDataKey.length ||
            !Array.from(r.dataKey).every((b, i) => b === sharedDataKey[i]),
        );

        // ----- Final summary block -----
        // Printed regardless of pass/fail so the run is diagnosable from the
        // log even when an assertion below trips.
        logCase("1000w-perf summary", {
          fulfilled: fulfilled.length,
          failed: failed.length,
          mismatchedDataKeys: mismatch.length,
          totalMs: formatMs(totalMs),
          accessMs: {
            count: lats.length,
            min: lats.length ? formatMs(Math.min(...lats)) : "—",
            p50: formatMs(p50(lats)),
            p95: formatMs(p95(lats)),
            p99: formatMs(p99(lats)),
            mean: formatMs(Math.round(mean(lats))),
            max: formatMs(arrMax(lats)),
          },
          failedReasonsSample: failed.slice(0, 5),
        });
        perfBuffer = {
          fulfilled: fulfilled.length,
          failed: failed.length,
          wallClockMs: totalMs,
          accessLats: lats,
          failedReasons: failed.slice(0, 10),
        };

        expect(failed.length, `${failed.length} wallets failed accessCDR`).toBe(0);
        expect(fulfilled.length).toBe(WALLET_COUNT);
        expect(mismatch.length).toBe(0);
      },
      // 1000 concurrent reads against the validator partial path can stretch
      // well past the per-call timeout if the chain or DKG nodes throttle.
      // 75 min outer bound matches the workflow's 90-min timeout-minutes for
      // the 1000-wallet-performance-devnet-only suite with slack for setup + teardown.
      75 * 60 * 1000,
    );
  },
);
