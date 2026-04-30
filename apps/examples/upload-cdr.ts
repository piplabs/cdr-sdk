/**
 * Example: Upload encrypted data to a CDR vault.
 *
 * Required env:
 *   CDR_API_URL              Story-API REST URL
 *   CDR_RPC_URL              EVM JSON-RPC URL on the same chain
 *   CDR_TEST_PRIVATE_KEY     Wallet private key
 *   WRITE_CONDITION          Write condition contract address (0x…)
 *   READ_CONDITION           Read condition contract address (0x…)
 *
 * Run via tsx (or `pnpm --filter @piplabs/cdr-examples upload`):
 *   tsx upload-cdr.ts
 *
 * This example walks the explicit step-by-step API. `Uploader.uploadCDR`
 * accepts an optional `globalPubKey`; if you omit it, the SDK auto-queries
 * the Observer. The explicit fetch below mirrors that internal step for
 * clarity. The vault UUID + raw data key printed at the end are the inputs
 * needed to later run `access-cdr.ts` against the same vault.
 */
import { createPublicClient, createWalletClient, http, toHex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { CDRClient, initWasm } from "@piplabs/cdr-sdk";

const CDR_API_URL = process.env.CDR_API_URL;
const CDR_RPC_URL = process.env.CDR_RPC_URL;
const CDR_TEST_PRIVATE_KEY = process.env.CDR_TEST_PRIVATE_KEY as `0x${string}` | undefined;
const WRITE_CONDITION = process.env.WRITE_CONDITION as `0x${string}` | undefined;
const READ_CONDITION = process.env.READ_CONDITION as `0x${string}` | undefined;

if (
  !CDR_API_URL ||
  !CDR_RPC_URL ||
  !CDR_TEST_PRIVATE_KEY ||
  !WRITE_CONDITION ||
  !READ_CONDITION
) {
  console.error(
    "Missing required env: CDR_API_URL, CDR_RPC_URL, CDR_TEST_PRIVATE_KEY, WRITE_CONDITION, READ_CONDITION.",
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

  // Step 1: Get DKG global public key.
  // (Could be omitted from uploadCDR — SDK would auto-query via the Observer.)
  console.log("Fetching DKG global public key...");
  const globalPubKey = await client.observer.getGlobalPubKey();
  console.log("Global pub key:", toHex(globalPubKey));

  // Step 2: Generate a fresh data key (the actual secret to seal).
  const dataKey = crypto.getRandomValues(new Uint8Array(32));
  console.log("Data key (input):", toHex(dataKey));

  // Step 3: Upload — bundles allocate + encrypt + write.
  console.log("\nUploading CDR (allocate + encrypt + write)...");
  const { uuid, txHashes } = await client.uploader.uploadCDR({
    dataKey,
    globalPubKey,
    updatable: false,
    writeConditionAddr: WRITE_CONDITION!,
    readConditionAddr: READ_CONDITION!,
    writeConditionData: "0x",
    readConditionData: "0x",
    accessAuxData: "0x",
  });

  console.log(`Vault allocated: uuid=${uuid}, tx=${txHashes.allocate}`);
  console.log(`Data written:    tx=${txHashes.write}`);
  console.log("\nVault UUID:", uuid);
  console.log("Data key (save this for later access):", toHex(dataKey));
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
