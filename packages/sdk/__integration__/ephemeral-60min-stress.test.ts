/**
 * 60-minute pipelined-load stress test against a live CDR DevNet.
 *
 * Suite gating: `1H-stress-devnet-only` (and `all`). **DevNet only** —
 * the workflow's prepare-step hard-rejects this suite when network !=
 * devnet (the 60-min stress depends on anvil-0 as funder).
 *
 * Pattern (1 hour total, **no artificial pacing**):
 *   1. Funder deploys an open-condition contract + uploads 1 shared CDR
 *      vault with a random dataKey (the "old shared uuid" all wallets
 *      will read every cycle).
 *   2. 10 ephemeral wallets, Multicall3 batch-funded with 1000 IP each
 *      (deliberately oversized — pipeline mode does hundreds of cycles
 *      per wallet over the hour).
 *   3. **Pipeline mode (3 ops per cycle):** each wallet runs an
 *      independent async loop covering both read patterns —
 *      `while (elapsed < 60min) {
 *         uploadCDR(fresh vault);          // write fresh-uuid
 *         accessCDR(sharedVault);          // read same-uuid (validator cache benefit)
 *         accessCDR(ownFreshVault);        // read fresh-uuid (no caching)
 *       }`
 *      with no sleep between cycles. 10 wallet loops in parallel via
 *      `Promise.all`. Replaces the deleted Workflow A
 *      (cdr-sdk-stress-test.yml) from the e2e repo — same-uuid +
 *      fresh-uuid coverage in a single 1h run.
 *   4. **Failure handling:** a single cycle that throws (or recovers a
 *      mismatched dataKey on the shared vault) is recorded in a failure
 *      counter and the wallet's loop continues so we collect ALL
 *      failures across the wave (not just the first one). At the end of
 *      the run the test asserts `failedCycles === 0` — any non-zero
 *      count fails the test. To diagnose, grep the output for
 *      `[w[N] cycle=M FAILED] <msg>`.
 *   5. Final assertions: (a) at least one cycle was attempted, (b)
 *      zero cycles failed. The perf-stats JSON output (upload + access
 *      latency distributions, total cycles, failure ratio) remains
 *      available for trend analysis.
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
 * with the `PerfStatsFile` shape (uploadMs, accessSharedMs, accessFreshMs,
 * refund summary, extra.total_cycles / extra.failed_cycles). The
 * workflow's summary step renders 3 perf rows for stress (upload +
 * access (shared) + access (fresh)) so the latency gap between
 * cached same-uuid reads and uncached fresh-uuid reads is visible.
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
import {
  OPEN_CONDITION_BYTECODE,
  sizeFundAndReport,
  statsOf,
  writePerfStats,
} from "./_helpers.js";

const DURATION_MS = 60 * 60 * 1000; // 1 hour
const CONCURRENCY = 10;
// Documentary constant — real run on devnet does ~120-200 cycles in 1 hour.
const ESTIMATED_CYCLES_PER_WALLET = 1000;
// Fixed per-wallet fund for the 1-hour stress run on devnet. Each cycle
// pays `writeFee + allocateFee + 2 × readFee` (upload + 2 × accessCDR),
// so at ~150 cycles × 0.04 IP/cycle (devnet) + gas overhead we need
// ~7-10 IP per wallet. 100 IP gives ~10× safety on devnet (anvil-0
// funder has effectively unlimited IP, and `refundWallets` sweeps any
// unused balance back at teardown — over-funding is cheap, exhausting
// mid-run is not). Stress is `skipUnlessDevnet`-gated, so aeneid /
// mainnet never hit this code path.
//
// History: PR #109 inlined this into the dynamic-fee formula with
// `cyclesPerWallet=1000` + `safetyMultiplier=3`, producing ~155 IP/wallet
// on devnet. PR #113 flattened that formula but accidentally dropped the
// cycle-count factor — the resulting ~1.09 IP/wallet exhausted after
// ~25 cycles. Reverted to a fixed value here, queried-fee path lives in
// `sizeFundAndReport`'s formula branch and is reserved for short suites.
const STRESS_PER_WALLET_FUND = parseEther("100");
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
  `60-min pipelined stress: ${CONCURRENCY} wallets 3-op (upload + read shared + read fresh) loop on DevNet`,
  () => {
    let funderPublic: PublicClient;
    let funderWallet: WalletClient;
    let funderClient: CDRClient;
    let funderAddress: `0x${string}`;
    let openCondition: `0x${string}`;
    let sharedVaultUuid: number;
    let sharedDataKey: Uint8Array;
    let stressWallets: StressWallet[] = [];
    let perWalletFund = 0n;
    let totalFundedWei = 0n;
    // Populated by `it`, consumed by `afterAll` to emit the perf-stats
    // JSON. `null` until the workload completes; afterAll skips the write
    // when this is `null` (e.g. when `it` is skipped or beforeAll errored
    // before reaching the workload).
    let perfBuffer: {
      uploadLats: number[];
      accessSharedLats: number[];
      accessFreshLats: number[];
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

      // Stress uses a fixed override (100 IP/wallet) — the flat formula
      // branch is for short suites and can't cover ~150 cycles' worth
      // of fees over 1h. We still call `sizeFundAndReport` (not a bespoke
      // path) so the workflow summary table has a row with live fees +
      // gas price for this suite, same shape as every other suite. See
      // STRESS_PER_WALLET_FUND comment above for the sizing rationale.
      perWalletFund = await sizeFundAndReport({
        label: "60min-stress",
        network: NETWORK,
        publicClient: funderPublic,
        overrideFundWei: STRESS_PER_WALLET_FUND,
      });

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
        perWalletFund,
      );
      totalFundedWei = fund.totalFundedWei;
      stressWallets = ephs.map(makeStressWallet);
      logLine(
        `[suite-setup] funded ${stressWallets.length} wallets via Multicall3 ` +
          `${fund.multicall3Address} (tx ${fund.txHash}); ${formatEther(perWalletFund)} IP each`,
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
          // Stress emits 2 access rows (shared + fresh); accessMs is
          // left null so the workflow's perf-table jq skips the
          // unified single-access row branch for this suite.
          accessMs: null,
          accessSharedMs: statsOf(perfBuffer.accessSharedLats),
          accessFreshMs: statsOf(perfBuffer.accessFreshLats),
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
          // Stress reports failures per-cycle in `extra.failed_cycles`,
          // not per-wallet; there's no per-failure reason to surface.
          failedReasons: null,
        });
      }
    }, 10 * 60 * 1000);

    it(
      `${CONCURRENCY} wallets pipeline upload + read(shared) + read(fresh) for 1h, no inter-cycle delay`,
      async () => {
        const startTime = Date.now();
        const uploadLats: number[] = [];
        const accessSharedLats: number[] = [];
        const accessFreshLats: number[] = [];
        let totalCycles = 0;
        let failedCycles = 0;
        // First-failure capture for the zero-tolerance assert at the
        // end. The `[w[N] cycle=M FAILED]` log lines go to
        // /tmp/cdr-stress.log which the workflow archives as an
        // artifact, but vitest's CI failure surface usually just shows
        // the assertion message — operators shouldn't have to download
        // an artifact to find the first failing wallet/cycle. JS is
        // single-threaded so the `if (!firstFailure)` check + assign
        // can't race even though 10 wallets run concurrently.
        let firstFailure: string | null = null;

        // Each wallet's loop is independent — Promise.all runs all 10 in
        // parallel. Within a wallet the cycle is strictly sequential
        // (upload → read shared → read own fresh) so the wallet's nonce
        // stream stays monotonic; across wallets there's no
        // synchronization (no tick boundary, no phase barrier).
        await Promise.all(
          stressWallets.map(async (w, idx) => {
            let cycleIdx = 0;
            while (Date.now() - startTime < DURATION_MS) {
              cycleIdx++;
              try {
                // ----- PHASE 1: UPLOAD (own fresh vault) -----
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

                // ----- PHASE 2: ACCESS shared vault (same-uuid read) -----
                const tShared = Date.now();
                const sharedAccess = await w.client.consumer.accessCDR({
                  uuid: sharedVaultUuid,
                  accessAuxData: "0x",
                  timeoutMs: ACCESS_TIMEOUT_MS,
                });
                const sharedDur = Date.now() - tShared;
                const sharedOk = bytesEqual(sharedAccess.dataKey, sharedDataKey);
                logLine(
                  `[w[${idx}] cycle=${cycleIdx} ACCESS_SHARED ${sharedOk ? "ok" : "MISMATCH"}] uuid=${sharedVaultUuid} tx=${sharedAccess.txHash} ${sharedDur}ms`,
                );
                if (!sharedOk) {
                  throw new Error(
                    `w[${idx}] cycle=${cycleIdx} dataKey mismatch on shared uuid=${sharedVaultUuid}`,
                  );
                }

                // ----- PHASE 3: ACCESS own fresh vault (fresh-uuid read) -----
                // The settlement window between Phase 1's write tx and
                // this read is implicit — whatever Phase 2's shared
                // read happened to take (typically 10-120s). When Phase
                // 2 hits a hot validator cache it can return in just a
                // few seconds, in which case `upload.uuid` may still be
                // propagating across validators when this call fires.
                // `ACCESS_TIMEOUT_MS` (120s) is LOAD-BEARING here: it's
                // not a generic safety margin but the actual headroom
                // accessCDR uses to poll until the new uuid lands. Do
                // not shrink it without explicit fresh-uuid propagation
                // benchmarks — a "fast" timeout would turn occasional
                // hot-cache cycles into spurious failures.
                const tFresh = Date.now();
                const freshAccess = await w.client.consumer.accessCDR({
                  uuid: upload.uuid,
                  accessAuxData: "0x",
                  timeoutMs: ACCESS_TIMEOUT_MS,
                });
                const freshDur = Date.now() - tFresh;
                const freshOk = bytesEqual(freshAccess.dataKey, dataKey);
                logLine(
                  `[w[${idx}] cycle=${cycleIdx} ACCESS_FRESH ${freshOk ? "ok" : "MISMATCH"}] uuid=${upload.uuid} tx=${freshAccess.txHash} ${freshDur}ms`,
                );
                if (!freshOk) {
                  throw new Error(
                    `w[${idx}] cycle=${cycleIdx} dataKey mismatch on fresh uuid=${upload.uuid}`,
                  );
                }

                // Push ALL THREE latencies in lockstep — only when the
                // full cycle (upload + read shared + read own fresh)
                // succeeded end-to-end. Pushing eagerly per-phase would
                // let partially-failed cycles bias one array's p50/p95
                // and decouple lengths from `totalCycles`. Same fix as
                // PR #83's 1b9a80d, extended to 3 arrays.
                uploadLats.push(uploadDur);
                accessSharedLats.push(sharedDur);
                accessFreshLats.push(freshDur);
                totalCycles++;
              } catch (e) {
                failedCycles++;
                const msg = e instanceof Error ? e.message : String(e);
                logLine(
                  `[w[${idx}] cycle=${cycleIdx} FAILED] ${msg.slice(0, 240)}`,
                );
                if (!firstFailure) {
                  firstFailure = `w[${idx}] cycle=${cycleIdx}: ${msg.slice(0, 240)}`;
                }
                // Continue the loop so other wallets keep running and we
                // get a full picture of failures across the wave; the
                // final `expect(failedCycles).toBe(0)` after the loop
                // turns any non-zero count into a test failure.
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
          access_shared: statsOf(accessSharedLats),
          access_fresh: statsOf(accessFreshLats),
        };
        logLine(`[stress summary] ${JSON.stringify(stats)}`);
        perfBuffer = {
          uploadLats,
          accessSharedLats,
          accessFreshLats,
          totalCycles,
          failedCycles,
          wallClockMs,
        };

        // 1) Driver liveness — wallets must have attempted at least one cycle.
        expect(
          totalCycles + failedCycles,
          "stress test finished with zero cycle attempts — wallets didn't even reach the first try",
        ).toBeGreaterThan(0);

        // 2) Zero-tolerance for cycle failures. Every per-wallet 3-op
        //    cycle (upload + read shared + read fresh) must succeed.
        //    Individual cycle failures are logged with the
        //    `[w[N] cycle=M FAILED] <msg>` pattern — grep the test
        //    output to find the first failing cycle. Common causes seen
        //    on this stack:
        //      - "Timed out collecting partials after 120000ms: got X/Y"
        //        → TDH2 threshold not met: one or more DKG vals didn't
        //          respond within the access timeout. Check
        //          /dkg/latest_active.{total,threshold} and validator
        //          kernel logs for `Kernel partial decrypt failed`.
        //      - dataKey MISMATCH → wrong-key delivery; chain GPK drift
        //        or wrong DKG round captured during upload.
        expect(
          failedCycles,
          `stress test had ${failedCycles}/${totalCycles + failedCycles} cycles fail. ` +
            `First failure: ${firstFailure ?? "(none captured — likely a logic bug, failedCycles>0 but firstFailure is null)"}. ` +
            `Full per-cycle log: /tmp/cdr-stress.log (uploaded as cdr-stress-log-<run_id> artifact).`,
        ).toBe(0);
      },
      DURATION_MS + 15 * 60 * 1000,
    );
  },
);
