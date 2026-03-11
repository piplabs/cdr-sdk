/**
 * Example: Upload encrypted data to a CDR vault
 *
 * Usage: CDR_PRIVATE_KEY=0x... WRITE_CONDITION=0x... READ_CONDITION=0x... pnpm --filter @piplabs/cdr-examples upload
 *
 * This example:
 * 1. Fetches the DKG global public key from the Finalized event
 * 2. Encrypts a data key using TDH2 to the DKG global public key
 * 3. Allocates a new vault with write/read conditions
 * 4. Writes the encrypted data key to the vault
 */
import { createPublicClient, createWalletClient, http, toHex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { CDRClient, initWasm } from "@piplabs/cdr-sdk";

const RPC_URL = process.env.RPC_URL ?? "https://odyssey.storyrpc.io";
const PRIVATE_KEY = process.env.CDR_PRIVATE_KEY;

async function main() {
  if (!PRIVATE_KEY) {
    console.error("Set CDR_PRIVATE_KEY environment variable");
    process.exit(1);
  }

  // Initialize WASM for TDH2 encryption
  await initWasm();

  const account = privateKeyToAccount(PRIVATE_KEY as `0x${string}`);
  const publicClient = createPublicClient({ transport: http(RPC_URL) });
  const walletClient = createWalletClient({ account, transport: http(RPC_URL) });
  const client = new CDRClient({ network: "testnet", publicClient, walletClient });

  // Step 1: Get DKG global public key
  console.log("Fetching DKG global public key...");
  const globalPubKey = await client.observer.getGlobalPubKey();
  console.log("Global pub key:", toHex(globalPubKey));

  // Step 2: Encrypt a random data key using TDH2
  const dataKey = crypto.getRandomValues(new Uint8Array(32));
  console.log("Data key:", toHex(dataKey));

  const writeCondition = process.env.WRITE_CONDITION as `0x${string}`;
  const readCondition = process.env.READ_CONDITION as `0x${string}`;
  if (!writeCondition || !readCondition) {
    console.error("Set WRITE_CONDITION and READ_CONDITION environment variables");
    process.exit(1);
  }

  console.log("\nUploading CDR (encrypt + allocate + write)...");
  const { uuid, txHashes } = await client.uploader.uploadCDR({
    dataKey,
    globalPubKey,
    label: `vault-${Date.now()}`,
    updatable: false,
    writeConditionAddr: writeCondition,
    readConditionAddr: readCondition,
    writeConditionData: "0x",
    readConditionData: "0x",
    accessAuxData: "0x",
  });

  console.log(`Vault allocated: uuid=${uuid}, tx=${txHashes.allocate}`);
  console.log(`Data written: tx=${txHashes.write}`);
  console.log("\nDone! Vault UUID:", uuid);
}

main().catch(console.error);
