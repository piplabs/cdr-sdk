/**
 * 60-minute pipelined-load stress test against a live CDR DevNet.
 *
 * Suite gating: `1H-stress-devnet-only` (and `all`). **DevNet only** —
 * the workflow's prepare-step hard-rejects this suite when network !=
 * devnet (the 60-min stress depends on anvil-0 as funder).
 *
 * Pattern (1 hour total, **no artificial pacing**):
 *   1. Funder deploys an open-condition contract + uploads 1 shared CDR
 *      vault with a random dataKey.
 *   2. 10 ephemeral wallets, Multicall3 batch-funded with 1000 IP each
 *      (deliberately oversized — pipeline mode does hundreds of cycles
 *      per wallet over the hour).
 *   3. **Pipeline mode:** each wallet runs an independent async loop —
 *      `while (elapsed < 60min) { uploadCDR(fresh vault); accessCDR(shared); }` —
 *      with no sleep between cycles. 10 wallet loops in parallel via
 *      `Promise.all`. The chain + DKG path see steady back-to-back load.
 *   4. **Soft failures:** a single cycle that throws (or recovers a
 *      mismatched dataKey on the shared vault) is recorded in a failure
 *      counter, but does NOT abort the wallet — the loop moves on to the
 *      next cycle. This matches what stress is for: surface failure
 *      rates under load, not assert zero failures.
 *   5. Final assertion: at least some cycles completed (smoke check).
 *      The real signal is the perf-stats JSON output: upload + access
 *      latency distribution, total cycles, failure ratio.
 *
 * Why pipeline (vs the old 10s-tick model):
 *   The previous version slept up to 10s between batches to maintain a
 *   fixed cadence. That capped throughput artificially — the chain
 *   often finished a batch in 6-8s and then idled the rest of the tick.
 *   For a stress test that's the wrong shape; we want sustained pressure,
 *   not a chopped sawtooth.
 *
 * Real-time log: every cycle event is appended to `/tmp/cdr-stress.log`
 * so you can `tail -f` from another terminal — vitest buffers test-
 * internal stdout, but `fs.appendFileSync` is unaffected. The
 * integration workflow uploads this file as a 14-day artifact
 * (`cdr-stress-log-<run_id>`).
 *
 * Perf-stats JSON: `/tmp/perf-stats-stress.json` is written in afterAll
 * with the `PerfStatsFile` shape (uploadMs, accessMs, refund summary,
 * extra.total_cycles / extra.failed_cycles), so the workflow's summary
 * step renders the same per-suite perf row as the 100w/1000w suites.
 *
 * Run locally (DevNet only):
 *   pnpm test:stress
 *
 * Required env (from `.env.local`):
 *   CDR_API_URL          — Story-API REST URL (e.g. http://172.207.250.203:1317)
 *   CDR_RPC_URL          — EVM JSON-RPC URL on the same chain
 *   CDR_TEST_PRIVATE_KEY — funded wallet (anvil-0 on DevNet)
 */

import fs from "node:fs";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  type PublicClient,
  type WalletClient,
  createPublicClient,
  createWalletClient,
  formatEther,
  http,
  parseEther,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { CDRClient, initWasm } from "../src/index.js";
import { NETWORK, skipUnlessDevnet, skipUnlessSuite } from "./_suite.js";
import {
  type EphemeralWallet,
  fundWallets,
  generateEphemeralWallets,
  refundWallets,
} from "./_ephemeral-wallets.js";
import { statsOf, writePerfStats } from "./_helpers.js";

const DURATION_MS = 60 * 60 * 1000; // 1 hour
const CONCURRENCY = 10;
const PER_WALLET_FUND = parseEther("1000");
// Generous reserve absorbs any pending-tx mempool cost when refund runs
// right after the last cycle. Loses ~10 IP across 10 wallets — DevNet
// anvil-0 has unlimited dev IP, so trading a little waste for refund
// reliability is fine.
const REFUND_GAS_RESERVE = parseEther("1");
const LOG_FILE = "/tmp/cdr-stress.log";
// Per-wallet accessCDR timeout. The shared vault read should normally
// finish in ~10-30s on DevNet; 120s is a generous ceiling so a single
// slow validator doesn't immediately count as a failed cycle.
const ACCESS_TIMEOUT_MS = 120_000;

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

interface StressWallet {
  ephemeral: EphemeralWallet;
  client: CDRClient;
  publicClient: PublicClient;
  walletClient: WalletClient;
}

function makeStressWallet(eph: EphemeralWallet): StressWallet {
  const publicClient = createPublicClient({
    transport: http(RPC_URL),
  }) as unknown as PublicClient;
  const walletClient = createWalletClient({
    account: eph.account,
    transport: http(RPC_URL),
  }) as unknown as WalletClient;
  const client = new CDRClient({
    network: "testnet",
    publicClient,
    walletClient,
    apiUrl: API_URL!,
  });
  return { ephemeral: eph, client, publicClient, walletClient };
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

function bytesEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

/**
 * Dual-log: print to console (vitest may buffer) AND append to a tail-able
 * file. The file gives real-time visibility from another terminal even
 * when vitest's reporter swallows test-internal stdout mid-test.
 */
function logLine(line: string): void {
  // eslint-disable-next-line no-console
  console.log(line);
  fs.appendFileSync(LOG_FILE, line + "\n");
}

describe.skipIf(skipUnlessSuite("1H-stress-devnet-only") || skipUnlessDevnet())(
  `60-min pipelined stress: ${CONCURRENCY} wallets upload+access loop on DevNet`,
  () => {
    let funderPublic: PublicClient;
    let funderWallet: WalletClient;
    let funderClient: CDRClient;
    let funderAddress: `0x${string}`;
    let openCondition: `0x${string}`;
    let sharedVaultUuid: number;
    let sharedDataKey: Uint8Array;
    let stressWallets: StressWallet[] = [];
    let totalFundedWei = 0n;
    // Populated by `it`, consumed by `afterAll` to emit the perf-stats
    // JSON. `null` until the workload completes; afterAll skips the write
    // when this is `null` (e.g. when `it` is skipped or beforeAll errored
    // before reaching the workload).
    let perfBuffer: {
      uploadLats: number[];
      accessLats: number[];
      totalCycles: number;
      failedCycles: number;
      wallClockMs: number;
    } | null = null;

    beforeAll(async () => {
      fs.writeFileSync(LOG_FILE, "");
      logLine(`[suite-setup] start ${new Date().toISOString()}`);
      logLine(`[suite-setup] log file: ${LOG_FILE}`);

      await initWasm();
      const f = makeFunderClient();
      funderPublic = f.publicClient;
      funderWallet = f.walletClient;
      funderClient = f.client;
      funderAddress = privateKeyToAccount(FUNDER_KEY!).address;

      openCondition = await deployOpenCondition(funderPublic, funderWallet);
      logLine(`[suite-setup] openCondition deployed at ${openCondition}`);

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
      logLine(
        `[suite-setup] shared vault uuid=${sharedVaultUuid} (owned by funder)`,
      );

      const ephs = generateEphemeralWallets(CONCURRENCY);
      const fund = await fundWallets(
        funderPublic,
        funderWallet,
        ephs,
        PER_WALLET_FUND,
      );
      totalFundedWei = fund.totalFundedWei;
      stressWallets = ephs.map(makeStressWallet);
      logLine(
        `[suite-setup] funded ${stressWallets.length} wallets via Multicall3 ` +
          `${fund.multicall3Address} (tx ${fund.txHash}); ${formatEther(PER_WALLET_FUND)} IP each`,
      );
    }, 10 * 60 * 1000);

    afterAll(async () => {
      if (stressWallets.length === 0) return;

      // Wait up to 60s per wallet for any pending tx left over from a
      // failed cycle to settle, otherwise refund underflows when the
      // mempool reserves the pending tx's cost from balance.
      logLine(`[suite-teardown] waiting for any pending txs to settle...`);
      await Promise.all(
        stressWallets.map(async (w, i) => {
          for (let j = 0; j < 30; j++) {
            const [latest, pending] = await Promise.all([
              w.publicClient.getTransactionCount({
                address: w.ephemeral.address,
                blockTag: "latest",
              }),
              w.publicClient.getTransactionCount({
                address: w.ephemeral.address,
                blockTag: "pending",
              }),
            ]);
            if (latest === pending) return;
            await sleep(2_000);
          }
          logLine(
            `[suite-teardown] wallet[${i}] still has pending nonces after 60s; refund may underflow`,
          );
        }),
      );

      const refund = await refundWallets(
        funderPublic,
        stressWallets.map((w) => w.ephemeral),
        funderAddress,
        RPC_URL!,
        REFUND_GAS_RESERVE,
      );
      logLine(
        `[suite-teardown] refund total=${formatEther(refund.totalRefundedWei)} IP ` +
          `failed=${refund.failedRefunds}/${stressWallets.length}`,
      );

      if (perfBuffer) {
        writePerfStats({
          label: "stress",
          network: NETWORK,
          wallets: CONCURRENCY,
          fulfilled: perfBuffer.totalCycles,
          failed: perfBuffer.failedCycles,
          wall_clock_ms: perfBuffer.wallClockMs,
          uploadMs: statsOf(perfBuffer.uploadLats),
          accessMs: statsOf(perfBuffer.accessLats),
          tickMs: null,
          refund: {
            funded_wei: totalFundedWei.toString(),
            refunded_wei: refund.totalRefundedWei.toString(),
            burned_wei: (totalFundedWei - refund.totalRefundedWei).toString(),
            failed_sweeps: refund.failedRefunds,
          },
          extra: {
            duration_minutes: Math.round(perfBuffer.wallClockMs / 60_000),
            total_cycles: perfBuffer.totalCycles,
            failed_cycles: perfBuffer.failedCycles,
            failure_rate_pct: (
              (perfBuffer.failedCycles /
                Math.max(1, perfBuffer.totalCycles + perfBuffer.failedCycles)) *
              100
            ).toFixed(2),
          },
        });
      }
    }, 10 * 60 * 1000);

    it(
      `${CONCURRENCY} wallets pipeline upload+access for 1h, no inter-cycle delay`,
      async () => {
        const startTime = Date.now();
        const uploadLats: number[] = [];
        const accessLats: number[] = [];
        let totalCycles = 0;
        let failedCycles = 0;

        // Each wallet's loop is independent — Promise.all runs all 10 in
        // parallel. Within a wallet the cycle is sequential (upload then
        // access) so the wallet's nonce stream stays monotonic; across
        // wallets there's no synchronization (no tick boundary).
        await Promise.all(
          stressWallets.map(async (w, idx) => {
            let cycleIdx = 0;
            while (Date.now() - startTime < DURATION_MS) {
              cycleIdx++;
              try {
                // ----- UPLOAD (own fresh vault) -----
                const dataKey = crypto.getRandomValues(new Uint8Array(32));
                const globalPubKey = await w.client.observer.getGlobalPubKey();
                const tUpload = Date.now();
                const upload = await w.client.uploader.uploadCDR({
                  dataKey,
                  globalPubKey,
                  updatable: false,
                  writeConditionAddr: openCondition,
                  readConditionAddr: openCondition,
                  writeConditionData: "0x",
                  readConditionData: "0x",
                  accessAuxData: "0x",
                });
                const uploadDur = Date.now() - tUpload;
                logLine(
                  `[w[${idx}] cycle=${cycleIdx} UPLOAD ok] uuid=${upload.uuid} ${uploadDur}ms`,
                );

                // ----- ACCESS shared vault -----
                const tAccess = Date.now();
                const access = await w.client.consumer.accessCDR({
                  uuid: sharedVaultUuid,
                  accessAuxData: "0x",
                  timeoutMs: ACCESS_TIMEOUT_MS,
                });
                const accessDur = Date.now() - tAccess;
                const ok = bytesEqual(access.dataKey, sharedDataKey);
                logLine(
                  `[w[${idx}] cycle=${cycleIdx} ACCESS ${ok ? "ok" : "MISMATCH"}] uuid=${sharedVaultUuid} tx=${access.txHash} ${accessDur}ms`,
                );
                if (!ok) {
                  throw new Error(
                    `w[${idx}] cycle=${cycleIdx} dataKey mismatch on shared uuid=${sharedVaultUuid}`,
                  );
                }
                // Push BOTH latencies together — only when the full cycle
                // succeeded end-to-end. Pushing uploadDur eagerly above
                // would let partially-failed cycles' upload times bias
                // the upload p50/p95, decoupling the two arrays from
                // `totalCycles`. Reviewer caught this on PR #83.
                uploadLats.push(uploadDur);
                accessLats.push(accessDur);
                totalCycles++;
              } catch (e) {
                failedCycles++;
                const msg = e instanceof Error ? e.message : String(e);
                logLine(
                  `[w[${idx}] cycle=${cycleIdx} FAILED] ${msg.slice(0, 240)}`,
                );
                // Continue to next cycle — stress measures failure rate,
                // not absence of failures.
              }
            }
            logLine(`[w[${idx}] done] cycles_attempted=${cycleIdx}`);
          }),
        );

        const wallClockMs = Date.now() - startTime;
        // Use `statsOf` — same nearest-rank quantile method `writePerfStats`
        // uses in afterAll, so the numbers in this log line match the
        // numbers in /tmp/perf-stats-stress.json exactly. The previous
        // inline math used floor-based indexing and produced slightly
        // different p50/p95 from the JSON — reviewer caught the
        // inconsistency on PR #83.
        const stats = {
          duration_min: (wallClockMs / 60_000).toFixed(1),
          total_cycles: totalCycles,
          failed_cycles: failedCycles,
          failure_rate_pct: (
            (failedCycles / Math.max(1, totalCycles + failedCycles)) *
            100
          ).toFixed(2),
          upload: statsOf(uploadLats),
          access: statsOf(accessLats),
        };
        logLine(`[stress summary] ${JSON.stringify(stats)}`);
        perfBuffer = {
          uploadLats,
          accessLats,
          totalCycles,
          failedCycles,
          wallClockMs,
        };

        // Smoke check only — stress doesn't assert zero failures. The
        // signal is in the perf-stats JSON.
        expect(
          totalCycles + failedCycles,
          "stress test finished with zero cycle attempts — wallets didn't even reach the first try",
        ).toBeGreaterThan(0);
      },
      DURATION_MS + 15 * 60 * 1000,
    );
  },
);
