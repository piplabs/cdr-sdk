/**
 * Integration tests against the live dev L1 network with DKG enabled.
 *
 * Run with:  DEV_L1_RPC=http://52.243.51.231:8545 npx vitest run __tests__/integration.test.ts
 *
 * Requires .env at repo root with TEST_WALLET_PRIVATE_KEY for write tests.
 * Skipped by default when DEV_L1_RPC is not set.
 */
import { describe, it, expect, beforeAll } from "vitest";
import {
  createPublicClient,
  createWalletClient,
  http,
  toHex,
  parseEventLogs,
  type PublicClient,
  type WalletClient,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { Observer } from "../src/observer.js";
import { Uploader } from "../src/uploader.js";
import { Consumer } from "../src/consumer.js";
import { CDRClient } from "../src/client.js";
import { dkgAbi, cdrAbi, contractAddresses } from "@piplabs/cdr-contracts";

// Load .env manually (no dotenv dependency)
import { readFileSync } from "node:fs";
try {
  const envPath = new URL("../../../.env", import.meta.url).pathname;
  const envContent = readFileSync(envPath, "utf-8");
  for (const line of envContent.split("\n")) {
    const match = line.match(/^([^#=]+)=(.*)$/);
    if (match && !process.env[match[1].trim()]) {
      process.env[match[1].trim()] = match[2].trim();
    }
  }
} catch {}

const RPC_URL = process.env.DEV_L1_RPC;
const PRIVATE_KEY = process.env.TEST_WALLET_PRIVATE_KEY;

const describeIf = RPC_URL ? describe : describe.skip;

// Dev L1 chain definition
const devL1Chain = {
  id: 90931,
  name: "Story Dev L1",
  nativeCurrency: { name: "IP", symbol: "IP", decimals: 18 },
  rpcUrls: { default: { http: [RPC_URL!] } },
} as const;

describeIf("Integration: DKG state queries against dev L1", () => {
  let publicClient: PublicClient;
  let observer: Observer;

  beforeAll(() => {
    publicClient = createPublicClient({ transport: http(RPC_URL) });
    observer = new Observer({ network: "testnet", publicClient });
  });

  // ── Basic connectivity ──────────────────────────────────────────────

  it("can fetch the latest block number", async () => {
    const blockNumber = await publicClient.getBlockNumber();
    console.log(`  Block number: ${blockNumber}`);
    expect(blockNumber).toBeGreaterThan(0n);
  });

  it("can fetch the chain ID", async () => {
    const chainId = await publicClient.getChainId();
    console.log(`  Chain ID: ${chainId}`);
    expect(chainId).toBeGreaterThan(0);
  });

  // ── DKG precompile reads ────────────────────────────────────────────

  it("reads operationalThreshold from DKG precompile", async () => {
    const threshold = await observer.getOperationalThreshold();
    console.log(`  Operational threshold: ${threshold}`);
    expect(threshold).toBeGreaterThanOrEqual(0n);
  });

  it("reads minReqRegisteredParticipants from DKG precompile", async () => {
    const minRegistered = await publicClient.readContract({
      address: contractAddresses.testnet.dkg,
      abi: dkgAbi,
      functionName: "minReqRegisteredParticipants",
    });
    console.log(`  Min registered participants: ${minRegistered}`);
    expect(minRegistered).toBeGreaterThanOrEqual(0n);
  });

  it("reads minReqFinalizedParticipants from DKG precompile", async () => {
    const minFinalized = await publicClient.readContract({
      address: contractAddresses.testnet.dkg,
      abi: dkgAbi,
      functionName: "minReqFinalizedParticipants",
    });
    console.log(`  Min finalized participants: ${minFinalized}`);
    expect(minFinalized).toBeGreaterThanOrEqual(0n);
  });

  it("reads DKG registration fee", async () => {
    const fee = await publicClient.readContract({
      address: contractAddresses.testnet.dkg,
      abi: dkgAbi,
      functionName: "fee",
    });
    console.log(`  DKG fee: ${fee} wei`);
    expect(fee).toBeGreaterThanOrEqual(0n);
  });

  // ── DKG events ──────────────────────────────────────────────────────

  it("scans for Registered events from genesis", async () => {
    const currentBlock = await publicClient.getBlockNumber();
    const CHUNK = 10000n;
    const allLogs: any[] = [];
    for (let from = 0n; from <= currentBlock; from += CHUNK) {
      const to = from + CHUNK - 1n > currentBlock ? currentBlock : from + CHUNK - 1n;
      const logs = await publicClient.getLogs({
        address: contractAddresses.testnet.dkg,
        fromBlock: from,
        toBlock: to,
      });
      allLogs.push(...logs);
    }
    console.log(`  Total DKG logs from genesis: ${allLogs.length}`);

    try {
      const registered = parseEventLogs({ abi: dkgAbi, logs: allLogs, eventName: "Registered" });
      console.log(`  Registered events: ${registered.length}`);
      for (const r of registered) {
        console.log(`    Block ${r.blockNumber}: validator=${r.args.validatorAddr}, round=${r.args.round}`);
      }
    } catch (_) {}

    try {
      const finalized = parseEventLogs({ abi: dkgAbi, logs: allLogs, eventName: "Finalized" });
      console.log(`  Finalized events: ${finalized.length}`);
      for (const f of finalized) {
        console.log(`    Block ${f.blockNumber}: validator=${f.args.validatorAddr}, round=${f.args.round}, globalPubKey=${(f.args as any).globalPubKey?.slice(0, 20)}...`);
      }
    } catch (_) {}

    expect(allLogs).toBeDefined();
  }, 30_000);

  it("attempts to get globalPubKey from Finalized events", async () => {
    try {
      const pubKey = await observer.getGlobalPubKey({ fromBlock: 0n });
      console.log(`  Global pub key: ${toHex(pubKey)}`);
      expect(pubKey.length).toBeGreaterThan(0);
    } catch (e: any) {
      if (e.message.includes("No Finalized event found")) {
        console.log("  No Finalized events yet — DKG may not have completed a round");
      } else {
        throw e;
      }
    }
  });

  // ── CDR precompile reads ────────────────────────────────────────────

  it("reads CDR allocateFee", async () => {
    const fee = await observer.getAllocateFee();
    console.log(`  CDR allocate fee: ${fee} wei`);
    expect(fee).toBeGreaterThanOrEqual(0n);
  });

  it("reads CDR writeFee", async () => {
    const fee = await observer.getWriteFee();
    console.log(`  CDR write fee: ${fee} wei`);
    expect(fee).toBeGreaterThanOrEqual(0n);
  });

  it("reads CDR readFee", async () => {
    const fee = await observer.getReadFee();
    console.log(`  CDR read fee: ${fee} wei`);
    expect(fee).toBeGreaterThanOrEqual(0n);
  });

  it("reads CDR current uuid counter", async () => {
    const currentUuid = await publicClient.readContract({
      address: contractAddresses.testnet.cdr,
      abi: cdrAbi,
      functionName: "uuid",
    });
    console.log(`  CDR uuid counter: ${currentUuid}`);
    expect(currentUuid).toBeGreaterThanOrEqual(0);
  });

  // ── Summary ─────────────────────────────────────────────────────────

  it("prints full DKG system summary", async () => {
    const [threshold, minRegistered, minFinalized, fee, blockNumber] = await Promise.all([
      observer.getOperationalThreshold(),
      publicClient.readContract({
        address: contractAddresses.testnet.dkg,
        abi: dkgAbi,
        functionName: "minReqRegisteredParticipants",
      }),
      publicClient.readContract({
        address: contractAddresses.testnet.dkg,
        abi: dkgAbi,
        functionName: "minReqFinalizedParticipants",
      }),
      publicClient.readContract({
        address: contractAddresses.testnet.dkg,
        abi: dkgAbi,
        functionName: "fee",
      }),
      publicClient.getBlockNumber(),
    ]);

    const [allocateFee, writeFee, readFee] = await Promise.all([
      observer.getAllocateFee(),
      observer.getWriteFee(),
      observer.getReadFee(),
    ]);

    console.log("\n  ═══════════════════════════════════════════");
    console.log("  DKG System State Summary");
    console.log("  ═══════════════════════════════════════════");
    console.log(`  Block number:                ${blockNumber}`);
    console.log(`  Operational threshold:       ${threshold}`);
    console.log(`  Min registered participants: ${minRegistered}`);
    console.log(`  Min finalized participants:  ${minFinalized}`);
    console.log(`  DKG registration fee:        ${fee} wei`);
    console.log("  ───────────────────────────────────────────");
    console.log(`  CDR allocate fee:            ${allocateFee} wei`);
    console.log(`  CDR write fee:               ${writeFee} wei`);
    console.log(`  CDR read fee:                ${readFee} wei`);
    console.log("  ═══════════════════════════════════════════\n");
  });
});

// ── Vault allocation & write tests (require wallet) ─────────────────

const describeWrite = RPC_URL && PRIVATE_KEY ? describe : describe.skip;

describeWrite("Integration: CDR vault allocation & write via SDK", () => {
  let publicClient: PublicClient;
  let walletClient: WalletClient;
  let client: CDRClient;
  let allocatedUuid: number;
  // Use wallet address as condition address — when msg.sender == conditionAddr, the check is bypassed
  let walletAddress: `0x${string}`;

  beforeAll(() => {
    const account = privateKeyToAccount(`0x${PRIVATE_KEY!.replace(/^0x/, "")}`);
    walletAddress = account.address;
    publicClient = createPublicClient({
      chain: devL1Chain,
      transport: http(RPC_URL),
    });
    walletClient = createWalletClient({
      account,
      chain: devL1Chain,
      transport: http(RPC_URL),
    });
    client = new CDRClient({
      network: "testnet",
      publicClient,
      walletClient,
    });
  });

  it("wallet has non-zero balance", async () => {
    const balance = await publicClient.getBalance({ address: walletAddress });
    console.log(`  Wallet ${walletAddress} balance: ${balance} wei (${Number(balance) / 1e18} IP)`);
    expect(balance).toBeGreaterThan(0n);
  });

  it("allocates a new vault", async () => {
    const { txHash, uuid } = await client.uploader.allocate({
      updatable: true,
      writeConditionAddr: walletAddress,
      readConditionAddr: walletAddress,
      writeConditionData: "0x",
      readConditionData: "0x",
    });

    allocatedUuid = uuid;
    console.log(`  Allocated vault UUID: ${uuid}`);
    console.log(`  Tx hash: ${txHash}`);

    expect(txHash).toMatch(/^0x[0-9a-f]{64}$/);
    expect(uuid).toBeGreaterThanOrEqual(0);
  }, 30_000);

  it("reads back the allocated vault via observer", async () => {
    const vault = await client.observer.getVault(allocatedUuid);
    console.log(`  Vault ${allocatedUuid}:`, JSON.stringify(vault, null, 2));

    expect(vault.uuid).toBe(allocatedUuid);
    expect(vault.updatable).toBe(true);
    expect(vault.encryptedData).toBe("0x"); // no data written yet
  });

  it("writes encrypted data to the vault", async () => {
    // Use dummy encrypted data for this test (real flow would use TDH2 encryption)
    const dummyEncryptedData = toHex(new TextEncoder().encode("test-encrypted-payload-for-vault"));

    const { txHash } = await client.uploader.write({
      uuid: allocatedUuid,
      accessAuxData: "0x",
      encryptedData: dummyEncryptedData as `0x${string}`,
    });

    console.log(`  Write tx hash: ${txHash}`);
    expect(txHash).toMatch(/^0x[0-9a-f]{64}$/);
  }, 30_000);

  it("verifies written data is stored on-chain", async () => {
    const vault = await client.observer.getVault(allocatedUuid);
    console.log(`  Vault ${allocatedUuid} encryptedData: ${vault.encryptedData}`);
    expect(vault.encryptedData).not.toBe("0x");
  });

  it("allocates a second (non-updatable) vault", async () => {
    const { txHash, uuid } = await client.uploader.allocate({
      updatable: false,
      writeConditionAddr: walletAddress,
      readConditionAddr: walletAddress,
      writeConditionData: "0x",
      readConditionData: "0x",
    });

    console.log(`  Second vault UUID: ${uuid}, tx: ${txHash}`);
    expect(uuid).toBeGreaterThan(allocatedUuid);
  }, 30_000);

  it("uuid counter incremented after allocations", async () => {
    const currentUuid = await publicClient.readContract({
      address: contractAddresses.testnet.cdr,
      abi: cdrAbi,
      functionName: "uuid",
    });
    console.log(`  CDR uuid counter: ${currentUuid}`);
    expect(currentUuid).toBeGreaterThanOrEqual(2);
  });
});

// ── Full CDR flow: encrypt → allocate → write → read request ────────

describeWrite("Integration: Full CDR flow (encrypt + vault + read request)", () => {
  let publicClient: PublicClient;
  let walletClient: WalletClient;
  let client: CDRClient;
  let walletAddress: `0x${string}`;
  let globalPubKey: Uint8Array | null = null;
  let dkgComplete = false;

  beforeAll(async () => {
    const account = privateKeyToAccount(`0x${PRIVATE_KEY!.replace(/^0x/, "")}`);
    walletAddress = account.address;
    publicClient = createPublicClient({
      chain: devL1Chain,
      transport: http(RPC_URL),
    });
    walletClient = createWalletClient({
      account,
      chain: devL1Chain,
      transport: http(RPC_URL),
    });
    client = new CDRClient({
      network: "testnet",
      publicClient,
      walletClient,
    });

    // Check if DKG has completed
    try {
      globalPubKey = await client.observer.getGlobalPubKey({ fromBlock: 0n });
      dkgComplete = true;
      console.log(`  DKG complete! Global pub key: ${toHex(globalPubKey)}`);
    } catch {
      console.log("  DKG not yet complete — full TDH2 encryption tests will be skipped");
    }
  });

  it("full uploadCDR flow with TDH2 encryption", async () => {
    if (!dkgComplete || !globalPubKey) {
      console.log("  SKIPPED: DKG not complete, no globalPubKey available for TDH2 encryption");
      return;
    }

    const dataKey = crypto.getRandomValues(new Uint8Array(32));
    const label = `test-vault-${Date.now()}`;

    const result = await client.uploader.uploadCDR({
      dataKey,
      globalPubKey,
      label,
      updatable: false,
      writeConditionAddr: walletAddress,
      readConditionAddr: walletAddress,
      writeConditionData: "0x",
      readConditionData: "0x",
      accessAuxData: "0x",
    });

    console.log(`  uploadCDR result:`);
    console.log(`    UUID: ${result.uuid}`);
    console.log(`    Allocate tx: ${result.txHashes.allocate}`);
    console.log(`    Write tx: ${result.txHashes.write}`);
    console.log(`    Ciphertext length: ${result.ciphertext.raw.length} bytes`);

    // Verify vault on-chain
    const vault = await client.observer.getVault(result.uuid);
    expect(vault.encryptedData).not.toBe("0x");
    expect(vault.updatable).toBe(false);
  }, 60_000);

  it("submits a read request for a vault", async () => {
    // First allocate + write a vault
    const dummyData = toHex(new TextEncoder().encode("read-test-payload"));
    const { uuid } = await client.uploader.allocate({
      updatable: false,
      writeConditionAddr: walletAddress,
      readConditionAddr: walletAddress,
      writeConditionData: "0x",
      readConditionData: "0x",
    });
    await client.uploader.write({
      uuid,
      accessAuxData: "0x",
      encryptedData: dummyData as `0x${string}`,
    });

    // Submit read request with a dummy requester public key
    const dummyPubKey = "0x" + "aa".repeat(65); // 65-byte uncompressed secp256k1 placeholder
    const { txHash } = await client.consumer.read({
      uuid,
      accessAuxData: "0x",
      requesterPubKey: dummyPubKey as `0x${string}`,
    });

    console.log(`  Read request for vault ${uuid}, tx: ${txHash}`);
    expect(txHash).toMatch(/^0x[0-9a-f]{64}$/);

    // Verify VaultRead event was emitted
    const receipt = await publicClient.waitForTransactionReceipt({ hash: txHash });
    const vaultReadEvents = parseEventLogs({
      abi: cdrAbi,
      logs: receipt.logs,
      eventName: "VaultRead",
    });
    console.log(`  VaultRead events in receipt: ${vaultReadEvents.length}`);
    expect(vaultReadEvents.length).toBe(1);
    expect(vaultReadEvents[0].args.uuid).toBe(uuid);
  }, 60_000);

  it("collectPartials times out quickly when no validators respond", async () => {
    if (!dkgComplete) {
      console.log("  SKIPPED: DKG not complete");
      return;
    }

    const fromBlock = await publicClient.getBlockNumber();
    const start = Date.now();

    try {
      await client.consumer.collectPartials({
        uuid: 999, // non-existent vault
        minPartials: 1,
        fromBlock,
        timeoutMs: 5_000,
        pollIntervalMs: 1_000,
      });
    } catch (e: any) {
      const elapsed = Date.now() - start;
      console.log(`  collectPartials timed out after ${elapsed}ms: ${e.message}`);
      expect(e.code).toBe("PARTIAL_COLLECTION_TIMEOUT");
    }
  }, 15_000);
});
