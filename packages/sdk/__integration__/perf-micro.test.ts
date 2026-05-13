/**
 * Micro-benchmarks — measures latency of individual SDK operations
 * against a live network. Useful for tracking regressions during
 * Story-API REST + WASM changes; not a load test (see
 * `ephemeral-1000w-perf.test.ts` for fan-out perf).
 *
 * Migrated from story-cdr-e2e/cdr-sdk-tests/src/perf.test.ts. Renamed
 * to `perf-micro` so it doesn't visually collide with the perf-suite
 * fan-out test. Both run in `default` (this file is light); the heavy
 * one is gated.
 *
 *   PERF-01  initWasm latency (with skipHashCheck)
 *   PERF-02  Observer query latencies (globalPubKey, threshold, …)
 *   PERF-03  Upload latency breakdown (deploy, dkg, encrypt, upload)
 *   PERF-04  Access latency (single accessCDR)
 *   PERF-05  Full roundtrip end-to-end (deploy + upload + access)
 *
 * The original test passed `threshold` to `accessCDR`. That parameter
 * was removed from the public accessCDR signature; threshold is now
 * derived inside the SDK from the Observer + minThresholdRatio. The
 * migrated tests drop the explicit threshold arg.
 */

import { randomBytes } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  type PublicClient,
  type WalletClient,
  createPublicClient,
  createWalletClient,
  http,
  toHex,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { CDRClient, getWasm, initWasm } from "../src/index.js";

const API_URL = process.env.CDR_API_URL;
const RPC_URL = process.env.CDR_RPC_URL;
const PRIVATE_KEY = process.env.CDR_TEST_PRIVATE_KEY as
  | `0x${string}`
  | undefined;

if (!API_URL) throw new Error("CDR_API_URL is not set");
if (!RPC_URL) throw new Error("CDR_RPC_URL is not set");
if (!PRIVATE_KEY) throw new Error("CDR_TEST_PRIVATE_KEY is not set");

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

describe(`Perf micro-benchmarks (live: ${API_URL})`, () => {
  // 30s timeout — the assertion is < 10s, but on a cold CI runner the
  // WASM load itself can approach the default vitest 5s timeout before
  // the inner assertion gets to fire.
  it("PERF-01: initWasm() with skipHashCheck completes in < 10s", { timeout: 30_000 }, async () => {
    const start = Date.now();
    await initWasm({ skipHashCheck: true });
    const ms = Date.now() - start;
    console.log(`PERF-01 | initWasm (skipHashCheck): ${ms}ms`);
    expect(ms).toBeLessThan(10_000);
  });

  // 30s timeout — observed 1401ms (5 REST queries serialized). Safe headroom.
  it("PERF-02: Observer query latencies", { timeout: 30_000 }, async () => {
    await initWasm({ skipHashCheck: true });
    const { client } = makeCDRClient();

    const times: Record<string, number> = {};
    let s = Date.now();
    await client.observer.getGlobalPubKey();
    times.getGlobalPubKey = Date.now() - s;

    s = Date.now();
    await client.observer.getThreshold();
    times.getThreshold = Date.now() - s;

    s = Date.now();
    await client.observer.getParticipantCount();
    times.getParticipantCount = Date.now() - s;

    s = Date.now();
    await client.observer.getOperationalThreshold();
    times.getOperationalThreshold = Date.now() - s;

    s = Date.now();
    await client.observer.getAllocateFee();
    times.getAllocateFee = Date.now() - s;

    console.log("PERF-02 | Observer query latencies:");
    for (const [name, ms] of Object.entries(times)) {
      console.log(`  ${name}: ${ms}ms`);
    }
  });

  it("PERF-03: Upload latency breakdown", async () => {
    await initWasm({ skipHashCheck: true });
    const { client, publicClient, walletClient } = makeCDRClient();

    let s = Date.now();
    const conditionAddr = await deployOpenCondition(publicClient, walletClient);
    const deployMs = Date.now() - s;

    s = Date.now();
    const globalPubKey = await client.observer.getGlobalPubKey();
    const dkgMs = Date.now() - s;

    const dataKey = new Uint8Array(randomBytes(32));
    const wasm = getWasm()!;
    s = Date.now();
    const label = new Uint8Array(32);
    wasm.tdh2Encrypt(globalPubKey, dataKey, label);
    const encryptMs = Date.now() - s;

    s = Date.now();
    const result = await client.uploader.uploadCDR({
      dataKey,
      globalPubKey,
      updatable: false,
      writeConditionAddr: conditionAddr,
      readConditionAddr: conditionAddr,
      writeConditionData: "0x",
      readConditionData: "0x",
      accessAuxData: "0x",
    });
    const uploadMs = Date.now() - s;

    console.log(
      `PERF-03 | deploy=${deployMs}ms dkg=${dkgMs}ms encrypt=${encryptMs}ms upload=${uploadMs}ms total=${deployMs + dkgMs + encryptMs + uploadMs}ms`,
    );
    expect(result.uuid).toBeGreaterThanOrEqual(0);
  }, 180_000);

  it("PERF-04: Access latency (single accessCDR, ephemeral keypair)", async () => {
    await initWasm({ skipHashCheck: true });
    const { client, publicClient, walletClient } = makeCDRClient();

    const conditionAddr = await deployOpenCondition(publicClient, walletClient);
    const globalPubKey = await client.observer.getGlobalPubKey();

    const dataKey = new Uint8Array(randomBytes(32));
    const { uuid } = await client.uploader.uploadCDR({
      dataKey,
      globalPubKey,
      updatable: false,
      writeConditionAddr: conditionAddr,
      readConditionAddr: conditionAddr,
      writeConditionData: "0x",
      readConditionData: "0x",
      accessAuxData: "0x",
    });

    // Let accessCDR generate its own ephemeral keypair — DX-02 case.
    // We measure end-to-end latency, not the key-supply path.
    const t = Date.now();
    const { dataKey: recovered } = await client.consumer.accessCDR({
      uuid,
      accessAuxData: "0x",
      globalPubKey,
      timeoutMs: 180_000,
    });
    const totalMs = Date.now() - t;

    const match = toHex(new Uint8Array(recovered)) === toHex(dataKey);
    console.log(`PERF-04 | accessCDR end-to-end: ${totalMs}ms key_match=${match}`);
    expect(match).toBe(true);
  }, 240_000);

  it("PERF-05: Full roundtrip (deploy + upload + access)", async () => {
    await initWasm({ skipHashCheck: true });
    const { client, publicClient, walletClient } = makeCDRClient();

    const totalStart = Date.now();

    let s = Date.now();
    const conditionAddr = await deployOpenCondition(publicClient, walletClient);
    const deployMs = Date.now() - s;

    s = Date.now();
    const globalPubKey = await client.observer.getGlobalPubKey();
    const dataKey = new Uint8Array(randomBytes(32));
    const { uuid } = await client.uploader.uploadCDR({
      dataKey,
      globalPubKey,
      updatable: false,
      writeConditionAddr: conditionAddr,
      readConditionAddr: conditionAddr,
      writeConditionData: "0x",
      readConditionData: "0x",
      accessAuxData: "0x",
    });
    const uploadMs = Date.now() - s;

    s = Date.now();
    const { dataKey: recovered } = await client.consumer.accessCDR({
      uuid,
      accessAuxData: "0x",
      globalPubKey,
      timeoutMs: 180_000,
    });
    const accessMs = Date.now() - s;

    const totalMs = Date.now() - totalStart;
    const match = toHex(new Uint8Array(recovered)) === toHex(dataKey);
    console.log(
      `PERF-05 | deploy=${deployMs}ms upload=${uploadMs}ms access=${accessMs}ms total=${totalMs}ms key_match=${match}`,
    );
    expect(match).toBe(true);
  }, 300_000);
});
