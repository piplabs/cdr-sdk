/**
 * End-to-end demo: upload then access a CDR vault, verifying the data key
 * round-trips correctly.
 *
 * Required env:
 *   CDR_API_URL              Story-API REST URL
 *   CDR_RPC_URL              EVM JSON-RPC URL on the same chain
 *   CDR_TEST_PRIVATE_KEY     Wallet private key
 *   WRITE_CONDITION          Write condition contract address (0x…)
 *   READ_CONDITION           Read condition contract address (0x…)
 *
 * Run via tsx (or `pnpm --filter @piplabs/cdr-examples e2e`):
 *   tsx e2e-demo.ts
 *
 * Uses the SDK's high-level convenience methods (`uploadCDR` + `accessCDR`)
 * end-to-end. The hand-written TDH2 / WASM combine path is covered by the
 * SDK's own unit and integration tests; production code should never need
 * to call into the WASM directly.
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

  // ===== Step 1: Upload =====
  // uploadCDR auto-queries the DKG global public key (since `globalPubKey`
  // is omitted), encrypts the dataKey under TDH2, allocates the vault, and
  // writes the ciphertext on-chain — all in one call.
  const dataKey = crypto.getRandomValues(new Uint8Array(32));
  console.log("Original data key:", toHex(dataKey));

  console.log("\nUploading CDR (allocate + encrypt + write)...");
  const { uuid, txHashes } = await client.uploader.uploadCDR({
    dataKey,
    updatable: false,
    writeConditionAddr: WRITE_CONDITION!,
    readConditionAddr: READ_CONDITION!,
    writeConditionData: "0x",
    readConditionData: "0x",
    accessAuxData: "0x",
  });
  console.log(`Vault uuid=${uuid}`);
  console.log(`Allocate tx: ${txHashes.allocate}`);
  console.log(`Write tx:    ${txHashes.write}`);

  // ===== Step 2: Access =====
  // accessCDR sends the read tx, polls the keeper for partial decryptions,
  // ECIES-decrypts each partial, and TDH2-combines them back into the data
  // key — the inverse of upload. With no explicit keypair, an ephemeral
  // secp256k1 keypair is generated internally and the private key is zeroed
  // after decrypt.
  console.log("\nAccessing CDR vault...");
  const { dataKey: recoveredKey, txHash: readTx } = await client.consumer.accessCDR({
    uuid,
    accessAuxData: "0x",
  });
  console.log(`Read tx: ${readTx}`);
  console.log("Recovered data key:", toHex(recoveredKey));

  // ===== Step 3: Verify =====
  const original = toHex(dataKey);
  const recovered = toHex(recoveredKey);
  if (original === recovered) {
    console.log("\nSUCCESS: data key round-tripped correctly");
  } else {
    console.error("\nFAILURE: recovered key does not match original");
    process.exit(1);
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
