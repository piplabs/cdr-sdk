/**
 * Stress test for the CDR SDK against a live network (DevNet for now;
 * CI will gate by network at the workflow level).
 *
 * Pattern (single case, 1 hour total):
 *   - 10 ephemeral wallets, funded once at suite start, refunded at end.
 *   - Every 10 seconds, fire a batch where all 10 wallets concurrently run
 *     a SEQUENTIAL flow: uploadCDR (own fresh vault) → accessCDR (shared
 *     vault). Per-wallet ops are sequential so the wallet's nonce stream
 *     is monotonic; across wallets they're parallel.
 *   - "upload 和 access 同时" emerges from cross-wallet timing variance:
 *     while wallet A is in upload phase, wallet B may already be reading.
 *   - Strict failure: any wallet's upload throws or any access recovers
 *     a mismatched dataKey → the tick fails. We let every wallet in the
 *     tick attempt to complete (Promise.allSettled) so all failures are
 *     visible in the log before we throw.
 *
 * Real-time log: every event is appended to `/tmp/cdr-stress.log` so you
 * can `tail -f /tmp/cdr-stress.log` from another terminal — vitest buffers
 * test-internal stdout, but appending to a file is unaffected.
 *
 * Run from packages/sdk:
 *   pnpm test:stress
 *
 * Required env (from `.env.local`):
 *   CDR_API_URL          — Story-API REST URL
 *   CDR_RPC_URL          — EVM JSON-RPC URL on the same chain
 *   CDR_TEST_PRIVATE_KEY — funded wallet (anvil-0 on DevNet); pays setup
 *                          gas, funds the 10 ephemeral wallets, and
 *                          owns the shared vault.
 */

import fs from "node:fs";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  createPublicClient,
  createWalletClient,
  formatEther,
  http,
  parseEther,
  type PublicClient,
  type WalletClient,
} from "viem";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { CDRClient, initWasm } from "../src/index.js";

const DURATION_MS = 60 * 60 * 1000; // 1 hour
const TICK_INTERVAL_MS = 10 * 1000; // 10 s
const CONCURRENCY = 10;
const PER_WALLET_FUND_IP = parseEther("1000");
// Generous reserve absorbs any pending-tx mempool cost when refund runs
// right after a failed tick. Loses ~10 IP across 10 wallets — DevNet
// anvil-0 has unlimited dev IP, so trading a little waste for refund
// reliability is fine.
const REFUND_GAS_RESERVE = parseEther("1");
const LOG_FILE = "/tmp/cdr-stress.log";

const API_URL = process.env.CDR_API_URL;
const RPC_URL = process.env.CDR_RPC_URL;
const FUNDING_PRIVATE_KEY = process.env.CDR_TEST_PRIVATE_KEY as
  | `0x${string}`
  | undefined;

if (!API_URL) throw new Error("CDR_API_URL is not set in .env.local");
if (!RPC_URL) throw new Error("CDR_RPC_URL is not set in .env.local");
if (!FUNDING_PRIVATE_KEY)
  throw new Error("CDR_TEST_PRIVATE_KEY is not set in .env.local");

interface StressWallet {
  pk: `0x${string}`;
  account: ReturnType<typeof privateKeyToAccount>;
  client: CDRClient;
  publicClient: PublicClient;
  walletClient: WalletClient;
}

function makeWallet(pk: `0x${string}`): StressWallet {
  const account = privateKeyToAccount(pk);
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
  return { pk, account, client, publicClient, walletClient };
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
    throw new Error("Open-condition deployment did not produce a contractAddress");
  }
  return receipt.contractAddress;
}

function bytesEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}

function percentile(arr: number[], q: number): number {
  if (arr.length === 0) return 0;
  const sorted = [...arr].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * q))];
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

let funder: StressWallet;
let wallets: StressWallet[] = [];
let openCondition: `0x${string}`;
let sharedVaultUuid: number;
let sharedVaultDataKey: Uint8Array;

describe(`Stress: 10 wallets concurrent upload+access against ${API_URL} (1h)`, () => {
  beforeAll(async () => {
    fs.writeFileSync(LOG_FILE, "");
    logLine(`[suite-setup] start ${new Date().toISOString()}`);
    logLine(`[suite-setup] log file: ${LOG_FILE}`);

    await initWasm();

    funder = makeWallet(FUNDING_PRIVATE_KEY!);
    openCondition = await deployOpenCondition(
      funder.publicClient,
      funder.walletClient,
    );
    logLine(`[suite-setup] openCondition deployed at ${openCondition}`);

    wallets = Array.from({ length: CONCURRENCY }, () =>
      makeWallet(generatePrivateKey()),
    );
    logLine(`[suite-setup] generated ${wallets.length} ephemeral wallets`);

    // Sequential funding — single funder address, single nonce stream.
    for (let i = 0; i < wallets.length; i++) {
      const w = wallets[i];
      const tx = await funder.walletClient.sendTransaction({
        chain: funder.walletClient.chain ?? null,
        account: funder.walletClient.account ?? null,
        to: w.account.address,
        value: PER_WALLET_FUND_IP,
      });
      await funder.publicClient.waitForTransactionReceipt({ hash: tx });
      logLine(
        `[suite-setup] funded wallet[${i}] ${w.account.address} with ${formatEther(PER_WALLET_FUND_IP)} IP`,
      );
    }

    sharedVaultDataKey = crypto.getRandomValues(new Uint8Array(32));
    const globalPubKey = await funder.client.observer.getGlobalPubKey();
    const upload = await funder.client.uploader.uploadCDR({
      dataKey: sharedVaultDataKey,
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
  }, 10 * 60 * 1000);

  afterAll(async () => {
    if (wallets.length === 0) return;

    // Wait up to 60s per wallet for any pending tx left over from a
    // failed tick to settle, otherwise refund underflows when the
    // mempool reserves the pending tx's cost from balance.
    logLine(`[suite-teardown] waiting for any pending txs to settle...`);
    await Promise.all(
      wallets.map(async (w, i) => {
        for (let j = 0; j < 30; j++) {
          const [latest, pending] = await Promise.all([
            w.publicClient.getTransactionCount({
              address: w.account.address,
              blockTag: "latest",
            }),
            w.publicClient.getTransactionCount({
              address: w.account.address,
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

    const results = await Promise.allSettled(
      wallets.map(async (w, i) => {
        const balance = await w.publicClient.getBalance({
          address: w.account.address,
        });
        if (balance <= REFUND_GAS_RESERVE) return { i, refunded: 0n };
        const value = balance - REFUND_GAS_RESERVE;
        const tx = await w.walletClient.sendTransaction({
          chain: w.walletClient.chain ?? null,
          account: w.walletClient.account ?? null,
          to: funder.account.address,
          value,
        });
        await w.publicClient.waitForTransactionReceipt({ hash: tx });
        return { i, refunded: value };
      }),
    );
    for (const r of results) {
      if (r.status === "fulfilled") {
        logLine(
          `[suite-teardown] wallet[${r.value.i}] refunded ${formatEther(r.value.refunded)} IP`,
        );
      } else {
        const msg =
          r.reason instanceof Error ? r.reason.message : String(r.reason);
        logLine(`[suite-teardown] refund failed: ${msg}`);
      }
    }
  }, 5 * 60 * 1000);

  it(
    "10 wallets concurrent upload + concurrent access on shared vault, 10s tick, 1h",
    async () => {
      const startTime = Date.now();
      const tickLatencies: number[] = [];
      let tick = 0;

      while (Date.now() - startTime < DURATION_MS) {
        tick++;
        const tickStart = Date.now();

        // Per-wallet sequential (upload → access), 10 wallets in parallel.
        // allSettled lets every wallet attempt to finish so all failures
        // surface in the log before we throw.
        const results = await Promise.allSettled(
          wallets.map(async (w, idx) => {
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
              pollIntervalMs: 2_000,
            });
            const accessDur = Date.now() - t1;
            const ok = bytesEqual(access.dataKey, sharedVaultDataKey);
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
          for (const f of failures) {
            const msg =
              f.reason instanceof Error ? f.reason.message : String(f.reason);
            logLine(`[tick=${tick} w[${f.idx}] FAILED] ${msg}`);
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

      logLine(
        `[stress summary] ticks=${tick} duration_min=${((Date.now() - startTime) / 60_000).toFixed(1)} ops_total=${tick * CONCURRENCY * 2} p50_ms=${percentile(tickLatencies, 0.5)} p99_ms=${percentile(tickLatencies, 0.99)} max_ms=${Math.max(...tickLatencies)}`,
      );
      expect(tick).toBeGreaterThan(0);
    },
    DURATION_MS + 10 * 60 * 1000,
  );
});
