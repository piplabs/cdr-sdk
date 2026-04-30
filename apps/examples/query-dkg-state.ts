/**
 * Example: Query full DKG and CDR state from Story L1.
 *
 * Required env:
 *   CDR_API_URL              Story-API REST URL
 *   CDR_RPC_URL              EVM JSON-RPC URL on the same chain
 *
 * Optional env:
 *   VAULT_UUID               Also dump a specific vault's metadata
 *
 * Run via tsx (or `pnpm --filter @piplabs/cdr-examples query`):
 *   tsx query-dkg-state.ts
 *
 * Read-only example — no wallet required. Surfaces the complete chain-level
 * picture: full DKG network state, registered validators (commPubKey map),
 * CDR contract fees, the operational threshold, and (optionally) a vault.
 */
import { createPublicClient, http } from "viem";
import { CDRClient, queryLatestActiveDKGNetwork } from "@piplabs/cdr-sdk";

const CDR_API_URL = process.env.CDR_API_URL;
const CDR_RPC_URL = process.env.CDR_RPC_URL;

if (!CDR_API_URL || !CDR_RPC_URL) {
  console.error("Missing required env: CDR_API_URL, CDR_RPC_URL.");
  process.exit(1);
}

async function main() {
  const publicClient = createPublicClient({ transport: http(CDR_RPC_URL) });
  const client = new CDRClient({
    network: "testnet",
    publicClient,
    apiUrl: CDR_API_URL!,
  });

  // 1. Full DKG network state via direct REST call (round, stage, total,
  //    threshold, isResharing, globalPublicKey, activeValSet, publicCoeffs,
  //    startBlockHeight, startBlockHash).
  console.log("=== Active DKG round ===");
  const network = await queryLatestActiveDKGNetwork({ apiUrl: CDR_API_URL! });
  console.log(JSON.stringify(network, replacer, 2));

  // 2. CDR contract fees (EVM reads via Observer).
  console.log("\n=== CDR contract fees ===");
  const [allocateFee, writeFee, readFee] = await Promise.all([
    client.observer.getAllocateFee(),
    client.observer.getWriteFee(),
    client.observer.getReadFee(),
  ]);
  console.log("Allocate fee:", allocateFee.toString(), "wei");
  console.log("Write fee:   ", writeFee.toString(), "wei");
  console.log("Read fee:    ", readFee.toString(), "wei");

  // 3. Operational threshold (DKG contract constant — distinct from
  //    per-round threshold above).
  const opThreshold = await client.observer.getOperationalThreshold();
  console.log("\nOperational threshold (DKG contract):", opThreshold.toString());

  // 4. Registered validators of the active round.
  console.log("\n=== Registered validators (active round) ===");
  const validators = await client.observer.getRegisteredValidators();
  for (const [addr, commPubKey] of validators) {
    const hex =
      "0x" +
      Array.from(commPubKey)
        .map((b) => b.toString(16).padStart(2, "0"))
        .join("");
    console.log(`  ${addr}: ${hex.slice(0, 30)}…(${commPubKey.length}B)`);
  }

  // 5. Optional: dump a specific vault.
  const vaultUuid = process.env.VAULT_UUID;
  if (vaultUuid) {
    console.log(`\n=== Vault ${vaultUuid} ===`);
    const vault = await client.observer.getVault(parseInt(vaultUuid));
    console.log(JSON.stringify(vault, replacer, 2));
  }
}

function replacer(_key: string, value: unknown): unknown {
  if (typeof value === "bigint") return value.toString();
  if (value instanceof Uint8Array) {
    return (
      "0x" +
      Array.from(value)
        .map((b) => b.toString(16).padStart(2, "0"))
        .join("")
    );
  }
  return value;
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
