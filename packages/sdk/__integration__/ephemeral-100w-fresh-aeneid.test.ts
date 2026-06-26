/**
 * 100 ephemeral wallets, each doing their own allocate + write + read
 * against fresh vaults — Aeneid-flavored variant.
 *
 * Suite gating: `default` (and `all`), Aeneid ONLY (the DevNet counterpart
 * lives in `ephemeral-100w-fresh.test.ts` and runs at full concurrency).
 *
 * What's different from the DevNet version:
 *   - Transport goes through `resilientHttp()` instead of bare `http()` —
 *     bumps viem's retry envelope from ~1s to ~31s so HTTP 429 / 408 /
 *     5xx from `aeneid.storyrpc.io` get absorbed (viem already retries
 *     these status codes; we only widen the budget).
 *   - Cross-wallet parallelism gated by `pLimit(25)` so the public RPC
 *     sees at most 25 in-flight requests at a time. The test still
 *     launches all 100 wallets logically; only the burst pressure is
 *     capped. WALLET_COUNT, per-wallet sequential semantics, assertion
 *     bar (`failed.length === 0`), and the recovered-dataKey checks
 *     are byte-identical to the DevNet version.
 *   - Timeout 60 min (vs 45 min DevNet) — public RPC tail latencies
 *     stretch p99 well beyond the private validator.
 *   - `writePerfStats` label is `"100w-fresh-aeneid"` so the aggregate
 *     perf-stats JSON doesn't collide with the DevNet run's slot.
 *
 * What's the same:
 *   - 100 fresh wallets, Multicall3 batch fund, per-wallet sequential
 *     upload→read, cross-wallet parallel, refund pass, same assertions.
 */

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  type PublicClient,
  type WalletClient,
  createPublicClient,
  createWalletClient,
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
  mean,
  OPEN_CONDITION_BYTECODE,
  p50,
  p95,
  sizeFundAndReport,
  statsOf,
  writePerfStats,
} from "./_helpers.js";
import { pLimit, resilientHttp, withAeneidFlakeRetry } from "./_rpc-resilience.js";

const WALLET_COUNT = 100;
const CYCLES_PER_WALLET = 1; // upload + access
const ACCESS_TIMEOUT_MS = 180_000;
const MAX_INFLIGHT = 25;

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
    transport: resilientHttp(RPC_URL!),
  }) as unknown as PublicClient;
  const walletClient = createWalletClient({
    account,
    transport: resilientHttp(RPC_URL!),
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
    transport: resilientHttp(RPC_URL!),
  }) as unknown as PublicClient;
  const walletClient = createWalletClient({
    account: wallet.account,
    transport: resilientHttp(RPC_URL!),
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
  const tx = await walletClient.sendTransaction({
    chain: walletClient.chain ?? null,
    account: walletClient.account ?? null,
    data: OPEN_CONDITION_BYTECODE,
  });
  const receipt = await publicClient.waitForTransactionReceipt({ hash: tx });
  if (!receipt.contractAddress) {
    throw new Error("Open-condition deploy: receipt missing contractAddress");
  }
  return receipt.contractAddress;
}

describe.skipIf(skipUnlessSuite("default") || NETWORK !== "aeneid")(
  `100 ephemeral wallets → fresh vault per wallet, throttled (network=${NETWORK})`,
  () => {
    let funderPublic: PublicClient;
    let funderWallet: WalletClient;
    let funderAddress: `0x${string}`;
    let openCondition: `0x${string}`;
    let wallets: EphemeralWallet[];
    let perWalletFund = 0n;
    let totalFundedWei = 0n;
    let perfBuffer: {
      fulfilled: number;
      failed: number;
      wallClockMs: number;
      uploadLats: number[];
      accessLats: number[];
      failedReasons: Array<{ idx: number; reason: string }>;
    } | null = null;

    beforeAll(async () => {
      await initWasm();
      const f = makeFunderClient();
      funderPublic = f.publicClient;
      funderWallet = f.walletClient;
      funderAddress = privateKeyToAccount(FUNDER_KEY!).address;

      // Flat per-wallet fund = 1 IP + 3 × (writeFee + allocateFee + readFee).
      // 1 IP base covers gas; 3× safety on user-side fees absorbs mid-run
      // fee bumps. See _helpers.ts::computePerWalletFund for the rationale
      // — replaces the previous hard-coded 0.1 IP that broke once aeneid
      // fees moved 0.01 → 0.03 IP.
      perWalletFund = await sizeFundAndReport({
        label: "100w-fresh-aeneid",
        network: NETWORK,
        publicClient: funderPublic,
      });

      openCondition = await deployOpenCondition(funderPublic, funderWallet);
      logCase("openCondition", openCondition);

      wallets = generateEphemeralWallets(WALLET_COUNT);
      const fund = await fundWallets(
        funderPublic,
        funderWallet,
        wallets,
        perWalletFund,
      );
      totalFundedWei = fund.totalFundedWei;
      logCase("multicall3 batch fund", {
        multicall3: fund.multicall3Address,
        wallets: wallets.length,
        perWallet: perWalletFund.toString(),
        totalWei: fund.totalFundedWei.toString(),
        txHash: fund.txHash,
      });
    }, 10 * 60 * 1000);

    afterAll(async () => {
      if (!wallets || wallets.length === 0) return;
      // Public-RPC sweep also benefits from the retry envelope —
      // otherwise refund 429s silently inflate `failedRefunds`.
      const refund = await refundWallets(
        funderPublic,
        wallets,
        funderAddress,
        RPC_URL!,
        undefined,
        resilientHttp,
      );
      logCase("refund summary", {
        totalRefundedWei: refund.totalRefundedWei.toString(),
        failedRefunds: refund.failedRefunds,
      });
      if (perfBuffer) {
        writePerfStats({
          label: "100w-fresh-aeneid",
          network: NETWORK,
          wallets: WALLET_COUNT,
          fulfilled: perfBuffer.fulfilled,
          failed: perfBuffer.failed,
          wall_clock_ms: perfBuffer.wallClockMs,
          accessMs: statsOf(perfBuffer.accessLats),
          uploadMs: statsOf(perfBuffer.uploadLats),
          accessSharedMs: null,
          accessFreshMs: null,
          tickMs: null,
          refund: {
            funded_wei: totalFundedWei.toString(),
            refunded_wei: refund.totalRefundedWei.toString(),
            burned_wei: (totalFundedWei - refund.totalRefundedWei).toString(),
            failed_sweeps: refund.failedRefunds,
          },
          extra: { maxInflight: MAX_INFLIGHT },
          failedReasons: perfBuffer.failedReasons,
        });
      }
    }, 5 * 60 * 1000);

    it(
      `${WALLET_COUNT} wallets each do upload→read on their own vault, capped at ${MAX_INFLIGHT} in-flight`,
      async () => {
        const limit = pLimit(MAX_INFLIGHT);
        const start = Date.now();
        const results = await Promise.allSettled(
          wallets.map((w) =>
            limit(() =>
              // Tolerate the two known aeneid public-pool consistency
              // bugs (see withAeneidFlakeRetry doc); each retry re-runs
              // the full upload→access cycle, which costs at most ~0.24
              // IP — well under the `safetyMultiplier: 3` fund headroom.
              withAeneidFlakeRetry(async () => {
                const client = makeWalletClient(w);
                const dataKey = crypto.getRandomValues(new Uint8Array(32));
                const globalPubKey = await client.observer.getGlobalPubKey();

                const tUploadStart = Date.now();
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
                const uploadMs = Date.now() - tUploadStart;

                const tAccessStart = Date.now();
                const access = await client.consumer.accessCDR({
                  uuid: upload.uuid,
                  accessAuxData: "0x",
                  timeoutMs: ACCESS_TIMEOUT_MS,
                });
                const accessMs = Date.now() - tAccessStart;

                return {
                  address: w.address,
                  uuid: upload.uuid,
                  uploadMs,
                  accessMs,
                  expected: dataKey,
                  recovered: access.dataKey,
                };
              }),
            ),
          ),
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
        const totalMs = Date.now() - start;
        const uploadLats = fulfilled.map((r) => r.uploadMs);
        const accessLats = fulfilled.map((r) => r.accessMs);
        logCase("100-fresh-aeneid summary", {
          fulfilled: fulfilled.length,
          failed: failed.length,
          totalMs: formatMs(totalMs),
          maxInflight: MAX_INFLIGHT,
          uploadMs: {
            p50: formatMs(p50(uploadLats)),
            p95: formatMs(p95(uploadLats)),
            mean: formatMs(Math.round(mean(uploadLats))),
          },
          accessMs: {
            p50: formatMs(p50(accessLats)),
            p95: formatMs(p95(accessLats)),
            mean: formatMs(Math.round(mean(accessLats))),
          },
          failedReasons: failed.slice(0, 5),
        });
        perfBuffer = {
          fulfilled: fulfilled.length,
          failed: failed.length,
          wallClockMs: totalMs,
          uploadLats,
          accessLats,
          failedReasons: failed.slice(0, 10),
        };

        expect(failed.length, `${failed.length} wallets failed`).toBe(0);
        expect(fulfilled.length).toBe(WALLET_COUNT);
        for (const r of fulfilled) {
          expect(r.recovered.length).toBe(r.expected.length);
          expect(Array.from(r.recovered)).toEqual(Array.from(r.expected));
        }
      },
      // Public RPC tail latencies stretch p99 well beyond the private
      // validator's; 100 wallets × (upload + read) under pLimit(25)
      // contention easily reach the 30-40 min mark on a busy Aeneid.
      60 * 60 * 1000,
    );
  },
);
