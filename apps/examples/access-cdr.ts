/**
 * Example: Access and decrypt data from a CDR vault.
 *
 * Required env (the same fixture used by the SDK / CLI integration tests):
 *   CDR_API_URL              Story-API REST URL
 *   CDR_RPC_URL              EVM JSON-RPC URL on the same chain
 *   CDR_TEST_PRIVATE_KEY     Wallet private key (used both to send the read
 *                            tx AND as the recipient secret for ECIES)
 *   VAULT_UUID               Existing vault to read
 *
 * Run via tsx (or `pnpm --filter @piplabs/cdr-examples access`):
 *   tsx access-cdr.ts
 *
 * This example walks the explicit step-by-step API for didactic clarity.
 * `Consumer.accessCDR` accepts simpler shorthand:
 *   - omit `globalPubKey` → SDK auto-queries via the Observer
 *   - omit `requesterPubKey` + `recipientPrivKey` → SDK generates an
 *     ephemeral keypair (and zeroes the private key after decrypt)
 * Use the simplified form in production; the explicit form below shows
 * what's happening under the hood.
 */
import { createPublicClient, createWalletClient, http, toHex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { secp256k1 } from "@noble/curves/secp256k1";
import { CDRClient, initWasm } from "@piplabs/cdr-sdk";

const CDR_API_URL = process.env.CDR_API_URL;
const CDR_RPC_URL = process.env.CDR_RPC_URL;
const CDR_TEST_PRIVATE_KEY = process.env.CDR_TEST_PRIVATE_KEY as `0x${string}` | undefined;
const VAULT_UUID = process.env.VAULT_UUID;

if (!CDR_API_URL || !CDR_RPC_URL || !CDR_TEST_PRIVATE_KEY || !VAULT_UUID) {
  console.error(
    "Missing required env: CDR_API_URL, CDR_RPC_URL, CDR_TEST_PRIVATE_KEY, VAULT_UUID. " +
      "See .env.local.example at the repo root.",
  );
  process.exit(1);
}

async function main() {
  await initWasm();

  const account = privateKeyToAccount(CDR_TEST_PRIVATE_KEY!);
  const publicClient = createPublicClient({ transport: http(CDR_RPC_URL) });
  const walletClient = createWalletClient({ account, transport: http(CDR_RPC_URL) });
  const client = new CDRClient({
    network: "testnet",
    publicClient,
    walletClient,
    apiUrl: CDR_API_URL!,
  });

  const uuid = parseInt(VAULT_UUID!);

  // Step 1: Read vault metadata
  const vault = await client.observer.getVault(uuid);
  console.log("Vault:", vault);

  // Step 2: Get DKG global public key.
  // (Could be omitted from accessCDR — SDK would auto-query via the Observer.)
  console.log("\nFetching DKG global public key...");
  const globalPubKey = await client.observer.getGlobalPubKey();
  console.log("Global pub key:", toHex(globalPubKey));

  // Step 3: Derive requester's secp256k1 public key from the wallet private
  // key. (Could be omitted from accessCDR — SDK would generate an ephemeral
  // keypair internally.)
  const privKeyBytes = Buffer.from(CDR_TEST_PRIVATE_KEY!.slice(2), "hex");
  const requesterPubKey = toHex(secp256k1.getPublicKey(privKeyBytes, false));

  // Step 4: Access CDR (read tx + collect partials + decrypt).
  console.log("\nAccessing CDR vault...");
  const { dataKey, txHash } = await client.consumer.accessCDR({
    uuid,
    accessAuxData: "0x",
    requesterPubKey: requesterPubKey as `0x${string}`,
    recipientPrivKey: privKeyBytes,
    globalPubKey,
  });

  console.log(`Read tx: ${txHash}`);
  console.log("Recovered data key:", toHex(dataKey));
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
