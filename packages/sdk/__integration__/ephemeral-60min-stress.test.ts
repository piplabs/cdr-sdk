/**
 * 60-minute combined-load stress test against a live CDR DevNet.
 *
 * Suite gating: `1H-stress-devnet-only` (and `all`). **DevNet only** —
 * the workflow's prepare-step hard-rejects this suite when network !=
 * devnet (the 60-min stress depends on anvil-0 as funder).
 *
 * Pattern (1 hour total, 10s tick):
 *   1. Funder deploys an open-condition contract + uploads 1 shared
 *      CDR vault with a random dataKey.
 *   2. 10 ephemeral wallets, Multicall3 batch-funded with 1000 IP each
 *      (PER_WALLET_FUND deliberately oversized — the wallets must survive
 *      ~360 ticks × 2 ops each, plus avoid hitting the mempool reserve
 *      after a failed tick).
 *   3. Every TICK_INTERVAL_MS, all 10 wallets concurrently run a
 *      SEQUENTIAL flow: uploadCDR (own fresh vault, fresh dataKey) →
 *      accessCDR (shared vault). Per-wallet sequential keeps the wallet's
 *      nonce stream monotonic; cross-wallet parallel exercises 10-way
 *      concurrent load.
 *   4. Strict failure: any wallet's upload throws OR any access recovers
 *      a mismatched dataKey → the tick fails. allSettled lets every
 *      wallet attempt to finish so all failures surface in the log
 *      before we throw.
 *   5. Refund all wallets via refundWallets helper.
 *
 * Why this combines (5) + (6):
 *   `ephemeral-100w-shared` exercises shared-vault reads at scale, and
 *   `ephemeral-100w-fresh` exercises fresh-vault writes at scale. Neither
 *   stays "warm" for an hour. This test runs both shapes interleaved in
 *   the same wallet flow, so cross-flow contention (e.g. the validator's
 *   partial-collection path competing with chain ingestion of new vault
 *   txs) is what we measure.
 *
 * Real-time log: every event is appended to `/tmp/cdr-stress.log` so you
 * can `tail -f` from another terminal — vitest buffers test-internal
 * stdout, but `fs.appendFileSync` is unaffected. The integration workflow
 * uploads this file as a 14-day artifact (`cdr-stress-log-<run_id>`).
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
import { skipUnlessDevnet, skipUnlessSuite } from "./_suite.js";
import {
  type EphemeralWallet,
  fundWallets,
  generateEphemeralWallets,
  refundWallets,
} from "./_ephemeral-wallets.js";
import { formatMs, mean, p50, p95, p99 } from "./_helpers.js";

const DURATION_MS = 60 * 60 * 1000; // 1 hour
const TICK_INTERVAL_MS = 10 * 1000; // 10 s
const CONCURRENCY = 10;
const PER_WALLET_FUND = parseEther("1000");
// Generous reserve absorbs any pending-tx mempool cost when refund runs
// right after a failed tick. Loses ~10 IP across 10 wallets — DevNet
// anvil-0 has unlimited dev IP, so trading a little waste for refund
// reliability is fine.
const REFUND_GAS_RESERVE = parseEther("1");
const LOG_FILE = "/tmp/cdr-stress.log";

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
  `60-min stress: ${CONCURRENCY} wallets upload+access loop on DevNet`,
  () => {
    let funderPublic: PublicClient;
    let funderWallet: WalletClient;
    let funderClient: CDRClient;
    let funderAddress: `0x${string}`;
    let openCondition: `0x${string}`;
    let sharedVaultUuid: number;
    let sharedDataKey: Uint8Array;
    let stressWallets: StressWallet[] = [];

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
      logLine(`[suite-setup] shared vault uuid=${sharedVaultUuid} (owned by funder)`);

      const ephs = generateEphemeralWallets(CONCURRENCY);
      const fund = await fundWallets(
        funderPublic,
        funderWallet,
        ephs,
        PER_WALLET_FUND,
      );
      stressWallets = ephs.map(makeStressWallet);
      logLine(
        `[suite-setup] funded ${stressWallets.length} wallets via Multicall3 ` +
          `${fund.multicall3Address} (tx ${fund.txHash}); ${formatEther(PER_WALLET_FUND)} IP each`,
      );
    }, 10 * 60 * 1000);

    afterAll(async () => {
      if (stressWallets.length === 0) return;

      // Wait up to 60s per wallet for any pending tx left over from a
      // failed tick to settle, otherwise refund underflows when the
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
    }, 10 * 60 * 1000);

    it(
      `${CONCURRENCY} wallets concurrent upload + concurrent shared-access, ${TICK_INTERVAL_MS / 1000}s tick, 1h`,
      async () => {
        const startTime = Date.now();
        const tickLatencies: number[] = [];
        let tick = 0;

        while (Date.now() - startTime < DURATION_MS) {
          tick++;
          const tickStart = Date.now();

          const results = await Promise.allSettled(
            stressWallets.map(async (w, idx) => {
              // ----- UPLOAD (own fresh vault) -----
              const dataKey = crypto.getRandomValues(new Uint8Array(32));
              const globalPubKey = await w.client.observer.getGlobalPubKey();
              const t0 = Date.now();
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
              const uploadDur = Date.now() - t0;
              logLine(
                `[tick=${tick} w[${idx}] UPLOAD ok] uuid=${upload.uuid} ${uploadDur}ms`,
              );

              // ----- ACCESS shared vault -----
              const t1 = Date.now();
              const access = await w.client.consumer.accessCDR({
                uuid: sharedVaultUuid,
                accessAuxData: "0x",
                timeoutMs: 120_000,
              });
              const accessDur = Date.now() - t1;
              const ok = bytesEqual(access.dataKey, sharedDataKey);
              logLine(
                `[tick=${tick} w[${idx}] ACCESS ${ok ? "ok" : "MISMATCH"}] uuid=${sharedVaultUuid} tx=${access.txHash} ${accessDur}ms`,
              );
              if (!ok) {
                throw new Error(
                  `tick=${tick} w[${idx}] dataKey mismatch on shared uuid=${sharedVaultUuid}`,
                );
              }
            }),
          );

          const failures = results.flatMap((r, idx) =>
            r.status === "rejected" ? [{ idx, reason: r.reason }] : [],
          );
          if (failures.length > 0) {
            for (const fail of failures) {
              const msg =
                fail.reason instanceof Error
                  ? fail.reason.message
                  : String(fail.reason);
              logLine(`[tick=${tick} w[${fail.idx}] FAILED] ${msg}`);
            }
            throw new Error(
              `tick=${tick}: ${failures.length}/${CONCURRENCY} wallets failed`,
            );
          }

          const tickDur = Date.now() - tickStart;
          tickLatencies.push(tickDur);
          const elapsedMin = ((Date.now() - startTime) / 60_000).toFixed(1);
          const nextTickTarget = startTime + tick * TICK_INTERVAL_MS;
          const sleepFor = nextTickTarget - Date.now();
          logLine(
            `[stress tick=${tick}] batch=${tickDur}ms elapsed=${elapsedMin}min ${
              sleepFor > 0 ? `sleep=${sleepFor}ms` : `late=${-sleepFor}ms`
            }`,
          );
          if (sleepFor > 0) await sleep(sleepFor);
        }

        const opsTotal = tick * CONCURRENCY * 2; // upload + access per wallet per tick
        logLine(
          `[stress summary] ticks=${tick} duration_min=${((Date.now() - startTime) / 60_000).toFixed(1)} ` +
            `ops_total=${opsTotal} ` +
            `tick_p50=${formatMs(p50(tickLatencies))} ` +
            `tick_p95=${formatMs(p95(tickLatencies))} ` +
            `tick_p99=${formatMs(p99(tickLatencies))} ` +
            `tick_mean=${formatMs(Math.round(mean(tickLatencies)))} ` +
            `tick_max=${formatMs(Math.max(...tickLatencies))}`,
        );
        expect(tick).toBeGreaterThan(0);
      },
      DURATION_MS + 15 * 60 * 1000,
    );
  },
);
