/**
 * Example: Query DKG and CDR state from Story L1
 *
 * Usage: pnpm --filter @piplabs/cdr-examples query
 */
import { createPublicClient, http } from "viem";
import { CDRClient } from "@piplabs/cdr-sdk";

const RPC_URL = process.env.RPC_URL ?? "https://odyssey.storyrpc.io";

async function main() {
  // Create a read-only client (no wallet needed)
  const publicClient = createPublicClient({ transport: http(RPC_URL) });
  const client = new CDRClient({ network: "testnet", publicClient });

  // Query operational threshold from DKG contract
  console.log("Querying DKG operational threshold...");
  const threshold = await client.observer.getOperationalThreshold();
  console.log(`Operational threshold: ${threshold}`);

  // Query CDR fees
  console.log("\nQuerying CDR fees...");
  const [allocateFee, writeFee, readFee] = await Promise.all([
    client.observer.getAllocateFee(),
    client.observer.getWriteFee(),
    client.observer.getReadFee(),
  ]);
  console.log(`Allocate fee: ${allocateFee} wei`);
  console.log(`Write fee:    ${writeFee} wei`);
  console.log(`Read fee:     ${readFee} wei`);

  // Query a vault (if UUID is provided)
  const vaultUuid = process.env.VAULT_UUID;
  if (vaultUuid) {
    console.log(`\nQuerying vault ${vaultUuid}...`);
    const vault = await client.observer.getVault(parseInt(vaultUuid));
    console.log(vault);
  }
}

main().catch(console.error);
