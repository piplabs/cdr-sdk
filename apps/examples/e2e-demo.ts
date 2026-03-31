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
import { createPublicClient, createWalletClient, http, toHex, toBytes } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { secp256k1 } from "@noble/curves/secp256k1";
import { CDRClient, initWasm, uuidToLabel, tdh2Verify, tdh2Combine, decryptPartial as eciesDecrypt, cdrAbi, contractAddresses, getWasm, type DecryptedPartial } from "@piplabs/cdr-sdk";

const RPC_URL = process.env.RPC_URL ?? "https://aeneid.storyrpc.io";
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
  const threshold = await client.observer.getThreshold();
  console.log("Global pub key:", toHex(globalPubKey));
  console.log("Threshold:", threshold);

  // ===== Step 2: Upload =====
  const dataKey = crypto.getRandomValues(new Uint8Array(32));
  console.log("\nOriginal data key:", toHex(dataKey));

  console.log("Uploading CDR (allocate + encrypt + write)...");
  const { uuid, ciphertext, txHashes } = await client.uploader.uploadCDR({
    dataKey,
    globalPubKey,
    updatable: false,
    writeConditionAddr: writeCondition,
    readConditionAddr: readCondition,
    writeConditionData: "0x",
    readConditionData: "0x",
    accessAuxData: "0x",
  });
  console.log(`Vault allocated: uuid=${uuid}, tx=${txHashes.allocate}`);
  console.log(`Data written: tx=${txHashes.write}`);

  // ===== Debug: Verify ciphertext locally =====
  const label = uuidToLabel(uuid);
  console.log("\nDebug — label:", toHex(label));
  console.log("Debug — ciphertext len:", ciphertext.raw.length);
  console.log("Debug — ciphertext hex:", toHex(ciphertext.raw));
  // Strip 0x043f prefix to get raw 32-byte point (what validator stores as GlobalPubKey)
  console.log("Debug — raw global pub key (no prefix):", toHex(globalPubKey.slice(2)));

  // Read back the on-chain ciphertext and compare
  const vaultData = await publicClient.readContract({
    address: contractAddresses.testnet.cdr,
    abi: cdrAbi,
    functionName: "vaults",
    args: [uuid],
  });
  const onChainCiphertext = (vaultData as any).encryptedData as `0x${string}`;
  console.log("Debug — on-chain ciphertext len:", (onChainCiphertext.length - 2) / 2, "bytes");
  console.log("Debug — ciphertexts match:", toHex(ciphertext.raw) === onChainCiphertext);

  const valid = await tdh2Verify({ ciphertext: ciphertext.raw, globalPubKey, label });
  console.log("Debug — WASM tdh2Verify:", valid ? "PASS" : "FAIL");

  // Self-test: encrypt a tiny payload and immediately verify, same key
  const wasm = getWasm()!;
  const testPlain = new Uint8Array([1, 2, 3, 4]);
  const testLabel = new Uint8Array(32); // all zeros
  const testCt = wasm.tdh2Encrypt(globalPubKey, testPlain, testLabel);
  const testOk = wasm.tdh2Verify(globalPubKey, testCt, testLabel);
  console.log("Debug — self-test encrypt→verify:", testOk ? "PASS" : "FAIL", "ct_len:", testCt.length);

  // ===== Step 3: Access =====
  const privKeyBytes = Buffer.from(PRIVATE_KEY.slice(2), "hex");
  const requesterPubKey = toHex(secp256k1.getPublicKey(privKeyBytes, false));

  console.log("\nAccessing CDR vault...");

  // Break apart accessCDR for debugging
  const vaultData2 = await publicClient.readContract({
    address: contractAddresses.testnet.cdr,
    abi: cdrAbi,
    functionName: "vaults",
    args: [uuid],
  });
  const encryptedData = toBytes((vaultData2 as any).encryptedData);

  const fromBlock = await publicClient.getBlockNumber();
  const { txHash: readTx } = await client.consumer.read({
    uuid,
    accessAuxData: "0x",
    requesterPubKey: requesterPubKey as `0x${string}`,
  });
  console.log(`Read requested: tx=${readTx}`);

  const partialEvents = await client.consumer.collectPartials({
    uuid,
    minPartials: threshold,
    fromBlock,
  });
  console.log(`Collected ${partialEvents.length} partial decryption events`);

  // Debug: inspect each partial event
  for (const p of partialEvents) {
    const encPartialBytes = toBytes(p.encryptedPartial);
    const ephPubBytes = toBytes(p.ephemeralPubKey);
    const pubShareBytes = toBytes(p.pubShare);
    console.log(`\nDebug partial — pid=${p.pid}, validator=${p.validator}`);
    console.log(`  encryptedPartial: ${encPartialBytes.length} bytes, hex=${p.encryptedPartial.slice(0, 40)}...`);
    console.log(`  ephemeralPubKey: ${ephPubBytes.length} bytes, first2=${toHex(ephPubBytes.slice(0, 2))}`);
    console.log(`  pubShare: ${pubShareBytes.length} bytes, hex=${p.pubShare}`);
  }

  // ECIES decrypt each partial
  const decryptedPartials: DecryptedPartial[] = await Promise.all(
    partialEvents.map(async (p) => {
      const decrypted = await eciesDecrypt({
        encryptedPartial: toBytes(p.encryptedPartial),
        ephemeralPubKey: toBytes(p.ephemeralPubKey),
        recipientPrivKey: privKeyBytes,
      });
      return {
        name: String(p.pid),
        pubShare: toBytes(p.pubShare),
        partial: decrypted,
      };
    }),
  );

  // Debug: inspect decrypted partials before combine
  for (const dp of decryptedPartials) {
    console.log(`\nDebug decrypted — name=${dp.name}`);
    console.log(`  pubShare: ${dp.pubShare.length} bytes, hex=${toHex(dp.pubShare)}`);
    console.log(`  partial: ${dp.partial.length} bytes, hex=${toHex(dp.partial)}`);
  }

  console.log(`\nDebug combine inputs:`);
  console.log(`  globalPubKey: ${globalPubKey.length} bytes, hex=${toHex(globalPubKey)}`);
  console.log(`  ciphertext: ${encryptedData.length} bytes`);
  console.log(`  label: ${toHex(label)}`);
  console.log(`  threshold: ${threshold}`);
  console.log(`  names: [${decryptedPartials.map(d => d.name).join(", ")}]`);

  // Now combine
  const recoveredKey = await tdh2Combine({
    ciphertext: { raw: encryptedData, label },
    partials: decryptedPartials,
    globalPubKey,
    label,
    threshold,
  });

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
