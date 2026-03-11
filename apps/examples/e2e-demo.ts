/**
 * End-to-end demo: Upload then access a CDR vault
 *
 * This script demonstrates the full CDR lifecycle:
 *   1. Fetch DKG global pub key and threshold
 *   2. Encrypt a data key using TDH2
 *   3. Allocate vault and write encrypted data
 *   4. Request read, collect partial decryptions, and recover data key
 *
 * NOTE: Requires a live Story L1 node with active DKG network.
 *
 * Usage: CDR_PRIVATE_KEY=0x... WRITE_CONDITION=0x... READ_CONDITION=0x... pnpm --filter @piplabs/cdr-examples e2e
 */
import { createPublicClient, createWalletClient, http, toHex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { secp256k1 } from "@noble/curves/secp256k1";
import { CDRClient, initWasm } from "@piplabs/cdr-sdk";

const RPC_URL = process.env.RPC_URL ?? "https://odyssey.storyrpc.io";
const PRIVATE_KEY = process.env.CDR_PRIVATE_KEY;

async function main() {
  if (!PRIVATE_KEY) {
    console.error("Set CDR_PRIVATE_KEY environment variable");
    process.exit(1);
  }

  const writeCondition = process.env.WRITE_CONDITION as `0x${string}`;
  const readCondition = process.env.READ_CONDITION as `0x${string}`;
  if (!writeCondition || !readCondition) {
    console.error("Set WRITE_CONDITION and READ_CONDITION environment variables");
    process.exit(1);
  }

  // Initialize WASM for TDH2 encryption/decryption
  await initWasm();

  const account = privateKeyToAccount(PRIVATE_KEY as `0x${string}`);
  const publicClient = createPublicClient({ transport: http(RPC_URL) });
  const walletClient = createWalletClient({ account, transport: http(RPC_URL) });
  const client = new CDRClient({ network: "testnet", publicClient, walletClient });

  // ===== Step 1: Fetch DKG parameters =====
  console.log("Fetching DKG parameters...");
  const globalPubKey = await client.observer.getGlobalPubKey();
  const threshold = Number(await client.observer.getOperationalThreshold());
  console.log("Global pub key:", toHex(globalPubKey));
  console.log("Threshold:", threshold);

  // ===== Step 2: Upload =====
  const dataKey = crypto.getRandomValues(new Uint8Array(32));
  const label = `vault-${Date.now()}`;
  console.log("\nOriginal data key:", toHex(dataKey));

  console.log("Uploading CDR (encrypt + allocate + write)...");
  const { uuid, txHashes } = await client.uploader.uploadCDR({
    dataKey,
    globalPubKey,
    label,
    updatable: false,
    writeConditionAddr: writeCondition,
    readConditionAddr: readCondition,
    writeConditionData: "0x",
    readConditionData: "0x",
    accessAuxData: "0x",
  });
  console.log(`Vault allocated: uuid=${uuid}, tx=${txHashes.allocate}`);
  console.log(`Data written: tx=${txHashes.write}`);

  // ===== Step 3: Access =====
  const privKeyBytes = Buffer.from(PRIVATE_KEY.slice(2), "hex");
  const requesterPubKey = toHex(secp256k1.getPublicKey(privKeyBytes, false));

  console.log("\nAccessing CDR vault...");
  const { dataKey: recoveredKey, txHash: readTx } = await client.consumer.accessCDR({
    uuid,
    accessAuxData: "0x",
    requesterPubKey: requesterPubKey as `0x${string}`,
    recipientPrivKey: privKeyBytes,
    globalPubKey,
    label: new TextEncoder().encode(label),
    threshold,
  });
  console.log(`Read requested: tx=${readTx}`);

  // ===== Step 4: Verify =====
  const original = toHex(dataKey);
  const recovered = toHex(recoveredKey);
  console.log("\nOriginal data key: ", original);
  console.log("Recovered data key:", recovered);

  if (original === recovered) {
    console.log("\nSUCCESS: Data key round-tripped correctly!");
  } else {
    console.error("\nFAILURE: Recovered key does not match original!");
    process.exit(1);
  }
}

main().catch(console.error);
