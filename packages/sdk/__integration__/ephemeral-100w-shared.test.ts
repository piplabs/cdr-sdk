/**
 * 100 ephemeral wallets concurrently read a single shared vault.
 *
 * Suite gating: `default` (and `all`). Runs on both DevNet + Aeneid.
 *
 * Pattern:
 *   1. Funder deploys an open-condition contract + creates one CDR vault
 *      with a random dataKey.
 *   2. Generate 100 ephemeral wallets (in-memory keypairs).
 *   3. Multicall3 batch-fund every ephemeral wallet in a single tx.
 *   4. All 100 wallets call `accessCDR(sharedVaultUuid)` concurrently —
 *      each performs its own `read` tx (own nonce stream) and polls
 *      Story-API for partials. Every wallet should recover the same
 *      dataKey the funder uploaded.
 *   5. Sweep remaining balance back to the funder.
 *
 * What this proves:
 *   - The validator partial-collection path scales to N concurrent reads
 *     against the same (uuid, distinct requesterPubKey) bucket — i.e.
 *     no shared-state contention between reads.
 *   - 100 separate sender accounts can fan-in to a single vault without
 *     anything in the read flow serializing on the vault's chain state.
 *
 * What this does NOT prove (covered by `ephemeral-100w-fresh.test.ts`):
 *   - Per-wallet sequential write+read flows (this test reads only).
 *   - Independent vault state per wallet.
 *
 * Cost (on DevNet, gas-price 10 gwei floor):
 *   - 1 vault upload (~0.02 IP, paid by funder)
 *   - 100 ephemeral wallets funded at 0.05 IP each (5 IP total via single
 *     Multicall3 tx)
 *   - 100 read txs at ~0.011 IP each (read fee + gas) — wallets pay from
 *     their own funded balance
 *   - Refund recovers ~0.039 IP per wallet (≈3.9 IP back to funder)
 *   - Net cost per session ≈ 1.2 IP gas + vault upload + read fees lost
 *     to the chain
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
  accessFeeCost,
  computePerWalletFund,
  formatMs,
  logCase,
  mean,
  p50,
  p95,
  queryCDRFees,
  statsOf,
  writeFeeStats,
  writePerfStats,
} from "./_helpers.js";

const WALLET_COUNT = 100;
const CYCLES_PER_WALLET = 1; // 1 accessCDR per wallet, no upload
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

function makeWalletClient(wallet: EphemeralWallet): {
  client: CDRClient;
  walletClient: WalletClient;
} {
  // Reuse the funder's publicClient — read-only, no per-wallet state.
  // Each wallet gets its own walletClient so nonce streams don't collide.
  const publicClient = createPublicClient({
    transport: http(RPC_URL),
  }) as unknown as PublicClient;
  const walletClient = createWalletClient({
    account: wallet.account,
    transport: http(RPC_URL),
  }) as unknown as WalletClient;
  const client = new CDRClient({
    network: "testnet",
    publicClient,
    walletClient,
    apiUrl: API_URL!,
  });
  return { client, walletClient };
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

describe.skipIf(skipUnlessSuite("default"))(
  `100 ephemeral wallets → shared vault read (network=${NETWORK})`,
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
    // Captured by `it`, written to /tmp/perf-stats-100w-shared.json by
    // `afterAll` (so the workflow can render a perf table). null until
    // the workload completes; afterAll skips the write when it's null
    // (e.g. when `it` is skipped or the suite errored before reaching
    // the workload).
    let perfBuffer: {
      fulfilled: number;
      failed: number;
      wallClockMs: number;
      accessLats: number[];
    } | null = null;

    beforeAll(async () => {
      await initWasm();
      const f = makeFunderClient();
      funderPublic = f.publicClient;
      funderWallet = f.walletClient;
      funderClient = f.client;
      funderAddress = privateKeyToAccount(FUNDER_KEY!).address;

      // Read-only suite: each ephemeral wallet pays accessFee only (no
      // upload / no baseFee). Size fund from the live readFee instead of
      // a static 0.05 IP that becomes unsafe whenever the chain raises
      // readFee.
      const fees = await queryCDRFees(funderPublic, "testnet");
      const perCycleWei = accessFeeCost(fees);
      perWalletFund = computePerWalletFund({
        perCycleWei,
        cyclesPerWallet: CYCLES_PER_WALLET,
        safetyMultiplier: FUND_SAFETY_MULTIPLIER,
      });
      writeFeeStats({
        label: "100w-shared",
        network: NETWORK,
        baseFee_wei: fees.baseFee.toString(),
        writeFee_wei: fees.writeFee.toString(),
        readFee_wei: fees.readFee.toString(),
        allocateFee_wei: fees.allocateFee.toString(),
        per_cycle_wei: perCycleWei.toString(),
        cycles_per_wallet: CYCLES_PER_WALLET,
        safety_multiplier: FUND_SAFETY_MULTIPLIER,
        per_wallet_fund_wei: perWalletFund.toString(),
      });
      logCase("fees + fund sizing", {
        readFee: fees.readFee.toString(),
        perCycleWei: perCycleWei.toString(),
        cyclesPerWallet: CYCLES_PER_WALLET,
        safetyMultiplier: FUND_SAFETY_MULTIPLIER,
        perWalletFund: perWalletFund.toString(),
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
          label: "100w-shared",
          network: NETWORK,
          wallets: WALLET_COUNT,
          fulfilled: perfBuffer.fulfilled,
          failed: perfBuffer.failed,
          wall_clock_ms: perfBuffer.wallClockMs,
          accessMs: statsOf(perfBuffer.accessLats),
          uploadMs: null,
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
      `${WALLET_COUNT} concurrent accessCDR calls on the same uuid all recover the same dataKey`,
      async () => {
        const start = Date.now();
        const results = await Promise.allSettled(
          wallets.map(async (w) => {
            const { client } = makeWalletClient(w);
            const t0 = Date.now();
            const access = await client.consumer.accessCDR({
              uuid: sharedVaultUuid,
              accessAuxData: "0x",
              timeoutMs: ACCESS_TIMEOUT_MS,
            });
            const dur = Date.now() - t0;
            return { address: w.address, dur, dataKey: access.dataKey };
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
        const lats = fulfilled.map((r) => r.dur).sort((a, b) => a - b);
        logCase("100-shared summary", {
          fulfilled: fulfilled.length,
          failed: failed.length,
          totalMs: formatMs(totalMs),
          accessMs: {
            p50: formatMs(p50(lats)),
            p95: formatMs(p95(lats)),
            mean: formatMs(Math.round(mean(lats))),
            min: lats.length ? formatMs(lats[0]) : "—",
            max: lats.length ? formatMs(lats[lats.length - 1]) : "—",
          },
          failedReasons: failed.slice(0, 5),
        });
        perfBuffer = {
          fulfilled: fulfilled.length,
          failed: failed.length,
          wallClockMs: totalMs,
          accessLats: lats,
        };

        expect(failed.length, `${failed.length} wallets failed accessCDR`).toBe(0);
        expect(fulfilled.length).toBe(WALLET_COUNT);
        for (const r of fulfilled) {
          expect(r.dataKey.length).toBe(sharedDataKey.length);
          expect(Array.from(r.dataKey)).toEqual(Array.from(sharedDataKey));
        }
      },
      // Outer bound: per-wallet accessCDR can take up to ACCESS_TIMEOUT_MS,
      // but 100 in parallel typically finishes inside ~2 min on a healthy
      // chain. Allow 30 min worst case (slow validator drags the tail).
      30 * 60 * 1000,
    );
  },
);
