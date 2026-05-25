/**
 * 100 ephemeral wallets, each doing their own allocate + write + read
 * against fresh vaults.
 *
 * Suite gating: `default` (and `all`). Runs on both DevNet + Aeneid.
 *
 * Pattern:
 *   1. Funder deploys one open-condition contract (shared across wallets
 *      — the contract is stateless, just an "always allow" check).
 *   2. Generate 100 ephemeral wallets, Multicall3 batch-fund them.
 *   3. Each wallet runs PER-WALLET SEQUENTIAL:
 *        uploadCDR(ownDataKey) → accessCDR(ownVaultUuid)
 *      The two txs go in series so the wallet's nonce stream stays
 *      monotonic (no two concurrent txs from the same account).
 *   4. CROSS-WALLET PARALLEL: all 100 wallets fire their sequential
 *      flow simultaneously via Promise.allSettled. Cross-wallet there
 *      are no nonce dependencies, so this exercises 100-way concurrent
 *      load on the chain + DKG validators.
 *   5. Refund pass.
 *
 * What this proves (different from `ephemeral-100w-shared.test.ts`):
 *   - 100 INDEPENDENT vault lifecycles concurrently — the validator
 *     partial path must handle distinct (uuid, requesterPubKey) buckets
 *     in parallel without cross-talk.
 *   - The uploader's chain interaction (alloc + write txs) scales to
 *     100 distinct senders without nonce-collision failure modes.
 *   - Each wallet recovers the SAME dataKey it wrote — proves the
 *     keeper indexes vaults by uuid correctly under load.
 */

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  type PublicClient,
  type WalletClient,
  createPublicClient,
  createWalletClient,
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
  cycleFeeCost,
  formatMs,
  logCase,
  mean,
  p50,
  p95,
  sizeFundAndReport,
  statsOf,
  writePerfStats,
} from "./_helpers.js";

const WALLET_COUNT = 100;
const CYCLES_PER_WALLET = 1; // upload + access
const FUND_SAFETY_MULTIPLIER = 3;
const ACCESS_TIMEOUT_MS = 180_000;

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

describe.skipIf(skipUnlessSuite("default") || NETWORK !== "devnet")(
  `100 ephemeral wallets → fresh vault per wallet (network=${NETWORK})`,
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
    } | null = null;

    beforeAll(async () => {
      await initWasm();
      const f = makeFunderClient();
      funderPublic = f.publicClient;
      funderWallet = f.walletClient;
      funderAddress = privateKeyToAccount(FUNDER_KEY!).address;

      // Size each wallet's fund from live CDR fees. See the aeneid
      // sibling suite for the failure-mode rationale.
      perWalletFund = await sizeFundAndReport({
        label: "100w-fresh",
        network: NETWORK,
        publicClient: funderPublic,
        perCycleCost: cycleFeeCost,
        cyclesPerWallet: CYCLES_PER_WALLET,
        safetyMultiplier: FUND_SAFETY_MULTIPLIER,
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
      const refund = await refundWallets(
        funderPublic,
        wallets,
        funderAddress,
        RPC_URL!,
      );
      logCase("refund summary", {
        totalRefundedWei: refund.totalRefundedWei.toString(),
        failedRefunds: refund.failedRefunds,
      });
      if (perfBuffer) {
        writePerfStats({
          label: "100w-fresh",
          network: NETWORK,
          wallets: WALLET_COUNT,
          fulfilled: perfBuffer.fulfilled,
          failed: perfBuffer.failed,
          wall_clock_ms: perfBuffer.wallClockMs,
          accessMs: statsOf(perfBuffer.accessLats),
          uploadMs: statsOf(perfBuffer.uploadLats),
          tickMs: null,
          refund: {
            funded_wei: totalFundedWei.toString(),
            refunded_wei: refund.totalRefundedWei.toString(),
            burned_wei: (totalFundedWei - refund.totalRefundedWei).toString(),
            failed_sweeps: refund.failedRefunds,
          },
          extra: null,
        });
      }
    }, 5 * 60 * 1000);

    it(
      `${WALLET_COUNT} wallets each do upload→read on their own vault, in parallel`,
      async () => {
        const start = Date.now();
        const results = await Promise.allSettled(
          wallets.map(async (w) => {
            const client = makeWalletClient(w);

            // ----- per-wallet sequential: upload, then read -----
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
        logCase("100-fresh summary", {
          fulfilled: fulfilled.length,
          failed: failed.length,
          totalMs: formatMs(totalMs),
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
        };

        expect(failed.length, `${failed.length} wallets failed`).toBe(0);
        expect(fulfilled.length).toBe(WALLET_COUNT);
        for (const r of fulfilled) {
          expect(r.recovered.length).toBe(r.expected.length);
          expect(Array.from(r.recovered)).toEqual(Array.from(r.expected));
        }
      },
      // Two sequential txs per wallet (upload + read) under 100-way
      // contention can stretch the tail well past a single-vault test.
      // Allow 45 min worst-case.
      45 * 60 * 1000,
    );
  },
);
