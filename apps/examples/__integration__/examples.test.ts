/**
 * Integration tests for the standalone examples in apps/examples/.
 *
 * Run from `apps/examples`:
 *   pnpm test:integration
 *
 * Required env (loaded from `.env.local` at the repo root by vitest):
 *   CDR_API_URL              Story-API REST URL
 *   CDR_RPC_URL              EVM JSON-RPC URL on the same chain
 *   CDR_TEST_PRIVATE_KEY     Funded wallet private key
 *
 * Cost model: 1 open-condition deploy + 1 bootstrap vault (for `access-cdr`)
 * + 3 examples that touch the chain (upload-cdr, access-cdr, e2e-demo).
 * Roughly 0.10–0.15 IP per run on DevNet.
 *
 * Test harness: spawn each example as a child process via `tsx <file>`
 * (no build step — tsx transpiles on the fly), capture stdout/stderr/
 * exitCode, assert on key markers in output.
 */

import { describe, it, expect, beforeAll } from "vitest";
import { execaNode } from "execa";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  createPublicClient,
  createWalletClient,
  http,
  type PublicClient,
  type WalletClient,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { CDRClient, initWasm } from "@piplabs/cdr-sdk";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DIST_DIR = path.resolve(__dirname, "..", "dist");

const API_URL = process.env.CDR_API_URL;
const RPC_URL = process.env.CDR_RPC_URL;
const PRIVATE_KEY = process.env.CDR_TEST_PRIVATE_KEY as `0x${string}` | undefined;

if (!API_URL) throw new Error("CDR_API_URL must be set in .env.local");
if (!RPC_URL) throw new Error("CDR_RPC_URL must be set in .env.local");
if (!PRIVATE_KEY) throw new Error("CDR_TEST_PRIVATE_KEY must be set in .env.local");

const BASE_ENV = {
  CDR_API_URL: API_URL!,
  CDR_RPC_URL: RPC_URL!,
  CDR_TEST_PRIVATE_KEY: PRIVATE_KEY!,
};

/**
 * Per-case diagnostic logger; mirrors the SDK / CLI suites.
 */
function logCase(label: string, value: unknown): void {
  const fullName = expect.getState().currentTestName ?? "(unknown)";
  const caseName = fullName.split(" > ").pop() ?? fullName;
  const formatted =
    typeof value === "string"
      ? value
      : typeof value === "number" || typeof value === "bigint"
        ? String(value)
        : JSON.stringify(value, null, 2);
  // eslint-disable-next-line no-console
  console.log(`\n[${caseName}] ${label}\n${formatted}`);
}

/**
 * Spawn a built example via plain node (no tsx loader), with an explicit
 * env (no parent inheritance) — mirrors `apps/cli` integration harness.
 */
async function runExample(file: string, env: Record<string, string>) {
  return execaNode(path.join(DIST_DIR, file), [], {
    env,
    extendEnv: false,
    reject: false,
  });
}

/** Open-condition contract address, deployed once per suite. */
let openCondition: `0x${string}`;
/** Vault UUID bootstrapped for the access-cdr example. */
let bootstrappedUuid: number;

beforeAll(async () => {
  const account = privateKeyToAccount(PRIVATE_KEY!);
  const publicClient = createPublicClient({ transport: http(RPC_URL) }) as PublicClient;
  const walletClient = createWalletClient({ account, transport: http(RPC_URL) }) as WalletClient;

  // Deploy the open-condition contract (same 10-byte runtime as
  // packages/sdk/__integration__).
  const bytecode = "0x600a600c600039600a6000f3600160005260206000f3" as `0x${string}`;
  const deployTx = await walletClient.sendTransaction({
    chain: walletClient.chain ?? null,
    account: walletClient.account ?? null,
    data: bytecode,
  });
  const deployReceipt = await publicClient.waitForTransactionReceipt({ hash: deployTx });
  if (!deployReceipt.contractAddress) {
    throw new Error("Open-condition deploy did not produce a contractAddress");
  }
  openCondition = deployReceipt.contractAddress;

  // Bootstrap a vault directly via SDK (so access-cdr.ts has a UUID to
  // read against, independent of the upload-cdr.ts test running first).
  // Uses the same wallet as the example will use, so the requesterPubKey
  // derived from CDR_TEST_PRIVATE_KEY matches.
  await initWasm();
  const sdkClient = new CDRClient({
    network: "testnet",
    publicClient,
    walletClient,
    apiUrl: API_URL!,
  });
  const dataKey = crypto.getRandomValues(new Uint8Array(32));
  const result = await sdkClient.uploader.uploadCDR({
    dataKey,
    updatable: false,
    writeConditionAddr: openCondition,
    readConditionAddr: openCondition,
    writeConditionData: "0x",
    readConditionData: "0x",
    accessAuxData: "0x",
  });
  bootstrappedUuid = result.uuid;
  // eslint-disable-next-line no-console
  console.log(
    `\n[suite-setup] openCondition=${openCondition}, bootstrap vault uuid=${bootstrappedUuid}\n`,
  );
}, 90_000);

// ---------------------------------------------------------------------------
// query-dkg-state.ts — read-only, no wallet, no chain mutation. Fastest case.
// ---------------------------------------------------------------------------

describe("query-dkg-state.ts", () => {
  it("prints DKG round, fees, and validators", async () => {
    const { stdout, stderr, exitCode } = await runExample("query-dkg-state.js", {
      CDR_API_URL: API_URL!,
      CDR_RPC_URL: RPC_URL!,
    });
    logCase("exitCode", exitCode);
    logCase("stdout (first 600 chars)", stdout.slice(0, 600));
    expect(exitCode, `stderr=${stderr}`).toBe(0);
    expect(stdout).toMatch(/=== Active DKG round ===/);
    expect(stdout).toMatch(/=== CDR contract fees ===/);
    expect(stdout).toMatch(/=== Registered validators/);
    expect(stdout).toMatch(/Allocate fee: \d+ wei/);
  }, 60_000);
});

// ---------------------------------------------------------------------------
// upload-cdr.ts — chain mutation. Creates a fresh vault and prints uuid +
// data key + tx hashes.
// ---------------------------------------------------------------------------

describe("upload-cdr.ts", () => {
  it("uploads a vault and prints uuid + dataKey + tx hashes", async () => {
    const { stdout, stderr, exitCode } = await runExample("upload-cdr.js", {
      ...BASE_ENV,
      WRITE_CONDITION: openCondition,
      READ_CONDITION: openCondition,
    });
    logCase("exitCode", exitCode);
    logCase("stdout (first 800 chars)", stdout.slice(0, 800));
    expect(exitCode, `stderr=${stderr}`).toBe(0);
    expect(stdout).toMatch(/Vault UUID: \d+/);
    expect(stdout).toMatch(/Allocate tx: |Vault allocated:.*tx=0x[0-9a-f]{64}/);
    expect(stdout).toMatch(/Data written:.*tx=0x[0-9a-f]{64}/);
    expect(stdout).toMatch(/Data key \(save this for later access\): 0x[0-9a-f]{64}/);
  }, 90_000);
});

// ---------------------------------------------------------------------------
// access-cdr.ts — reads the vault bootstrapped in beforeAll. The example uses
// the wallet privKey both as the read tx signer AND as the recipient secret
// for ECIES (same flow real users would follow when reading their own data).
// ---------------------------------------------------------------------------

describe("access-cdr.ts", () => {
  it("reads the bootstrapped vault and recovers a data key", async () => {
    const { stdout, stderr, exitCode } = await runExample("access-cdr.js", {
      ...BASE_ENV,
      VAULT_UUID: String(bootstrappedUuid),
    });
    logCase("exitCode", exitCode);
    logCase("stdout (first 800 chars)", stdout.slice(0, 800));
    expect(exitCode, `stderr=${stderr}`).toBe(0);
    expect(stdout).toMatch(/Read tx: 0x[0-9a-f]{64}/);
    expect(stdout).toMatch(/Recovered data key: 0x[0-9a-f]{64}/);
    // The bootstrapped vault was uploaded by the SDK directly (not the
    // example), so the recovered key isn't the same as upload-cdr.ts's
    // output. We only assert the example completes the flow.
  }, 180_000);
});

// ---------------------------------------------------------------------------
// e2e-demo.ts — full upload+access in one script, with internal byte-equal
// verification of the data key round-trip.
// ---------------------------------------------------------------------------

describe("e2e-demo.ts", () => {
  it("round-trips a data key through upload + access (uses convenience SDK API)", async () => {
    const { stdout, stderr, exitCode } = await runExample("e2e-demo.js", {
      ...BASE_ENV,
      WRITE_CONDITION: openCondition,
      READ_CONDITION: openCondition,
    });
    logCase("exitCode", exitCode);
    logCase("stdout (first 800 chars)", stdout.slice(0, 800));
    expect(exitCode, `stderr=${stderr}`).toBe(0);
    expect(stdout).toMatch(/SUCCESS: data key round-tripped correctly/);
  }, 240_000);
});
