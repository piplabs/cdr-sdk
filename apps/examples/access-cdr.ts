/**
 * Example: Access and decrypt data from a CDR vault
 *
 * Usage: CDR_PRIVATE_KEY=0x... VAULT_UUID=1 pnpm --filter @piplabs/cdr-examples access
 *
 * This example:
 * 1. Fetches the DKG global public key and operational threshold
 * 2. Sends a read request to the CDR contract
 * 3. Collects partial decryptions from validators
 * 4. ECIES-decrypts each partial, then TDH2-combines to recover the data key
 *
 * NOTE: Requires a live DKG network with active validators.
 */
import { createPublicClient, createWalletClient, http, toHex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { secp256k1 } from "@noble/curves/secp256k1";
import { CDRClient, initWasm } from "@piplabs/cdr-sdk";

const RPC_URL = process.env.RPC_URL ?? "https://odyssey.storyrpc.io";
const PRIVATE_KEY = process.env.CDR_PRIVATE_KEY;
const VAULT_UUID = process.env.VAULT_UUID;

async function main() {
  if (!PRIVATE_KEY || !VAULT_UUID) {
    console.error("Set CDR_PRIVATE_KEY and VAULT_UUID environment variables");
    process.exit(1);
  }

  await initWasm();

  const account = privateKeyToAccount(PRIVATE_KEY as `0x${string}`);
  const publicClient = createPublicClient({ transport: http(RPC_URL) });
  const walletClient = createWalletClient({ account, transport: http(RPC_URL) });
  const client = new CDRClient({ network: "testnet", publicClient, walletClient });

  const uuid = parseInt(VAULT_UUID);

  // Step 1: Read vault info
  const vault = await client.observer.getVault(uuid);
  console.log("Vault:", vault);

  // Step 2: Get DKG parameters
  console.log("\nFetching DKG parameters...");
  const globalPubKey = await client.observer.getGlobalPubKey();
  const threshold = Number(await client.observer.getOperationalThreshold());
  console.log("Global pub key:", toHex(globalPubKey));
  console.log("Threshold:", threshold);

  // Step 3: Derive requester's secp256k1 public key from private key
  const privKeyBytes = Buffer.from(PRIVATE_KEY.slice(2), "hex");
  const requesterPubKey = toHex(secp256k1.getPublicKey(privKeyBytes, false));

  // Step 4: Access CDR (read + collect partials + decrypt)
  console.log("\nAccessing CDR vault...");
  const { dataKey, txHash } = await client.consumer.accessCDR({
    uuid,
    accessAuxData: "0x",
    requesterPubKey: requesterPubKey as `0x${string}`,
    recipientPrivKey: privKeyBytes,
    globalPubKey,
    threshold,
  });

  console.log(`Read requested: tx=${txHash}`);
  console.log("Recovered data key:", toHex(dataKey));
}

main().catch(console.error);
