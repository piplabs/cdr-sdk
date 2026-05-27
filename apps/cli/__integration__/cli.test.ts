/**
 * Integration tests for the cdr-cli binary against a live Story L1 CDR
 * deployment (DevNet by default).
 *
 * Run from `apps/cli`:
 *   pnpm test:integration
 *
 * Required env (loaded from `.env.local` at the workspace root by vitest):
 *   CDR_API_URL              Story-API REST URL
 *   CDR_RPC_URL              EVM JSON-RPC URL on the same chain
 *   CDR_TEST_PRIVATE_KEY     Funded wallet private key
 *
 * Cost model: 1 open-condition deploy in beforeAll + 1 uploadCDR + 1
 * accessCDR end-to-end → ~0.06 IP per run on DevNet.
 *
 * Test harness: `tsc → dist/index.js`, then each case spawns the binary
 * via `execaNode` with an explicitly controlled env (no inheritance) to
 * isolate flag-vs-env precedence behavior.
 */

import { describe, it, expect, beforeAll } from "vitest";
import { execaNode } from "execa";
import path from "node:path";
import { fileURLToPath } from "node:url";

/**
 * Per-case diagnostic logger. Mirrors `packages/sdk/__integration__/_helpers.ts:logCase`
 * so CLI test output reads similarly to the SDK suite — every block is
 * prefixed with the current test name, which keeps interleaved stdout
 * attributable when many cases stream through the same terminal.
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
import {
  createPublicClient,
  createWalletClient,
  http,
  type PublicClient,
  type WalletClient,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CLI_PATH = path.resolve(__dirname, "../dist/index.js");

const API_URL = process.env.CDR_API_URL;
const RPC_URL = process.env.CDR_RPC_URL;
const PRIVATE_KEY = process.env.CDR_TEST_PRIVATE_KEY as `0x${string}` | undefined;

if (!API_URL) throw new Error("CDR_API_URL must be set in .env.local");
if (!RPC_URL) throw new Error("CDR_RPC_URL must be set in .env.local");
if (!PRIVATE_KEY) throw new Error("CDR_TEST_PRIVATE_KEY must be set in .env.local");

/** Full CLI env: read + write capable. */
const FULL_ENV = {
  CDR_API_URL: API_URL!,
  CDR_RPC_URL: RPC_URL!,
  CDR_TEST_PRIVATE_KEY: PRIVATE_KEY!,
};

/** Read-only env: no wallet. Used to exercise the requireWallet=false path. */
const READ_ONLY_ENV = {
  CDR_API_URL: API_URL!,
  CDR_RPC_URL: RPC_URL!,
};

// Accepts the deployed CDR condition selectors and cleanly rejects unknown selectors.
const OPEN_CONDITION_BYTECODE =
  "0x602a600c600039602a6000f360003560e01c80635645dbbf14601f5780638db3eb1714601f5760006000fd5b600160005260206000f3" as `0x${string}`;

/**
 * Spawn the built CLI binary with an explicit env (no parent inheritance,
 * so the test's own env doesn't leak). `reject: false` lets us inspect
 * non-zero exits in error-UX cases.
 */
async function runCli(args: string[], env: Record<string, string>) {
  return execaNode(CLI_PATH, args, {
    env,
    extendEnv: false,
    reject: false,
  });
}

/**
 * Pull the first JSON-shaped line out of combined stdout+stderr. The
 * --json error path writes JSON to stderr; happy paths write to stdout.
 * Either way, locate the JSON object and parse it.
 */
function extractJson(combined: string): unknown {
  const line = combined.split("\n").find((l) => l.trim().startsWith("{"));
  if (!line) throw new Error(`No JSON object found in output:\n${combined}`);
  return JSON.parse(line);
}

/** Open-condition contract address, deployed once per suite. */
let openCondition: `0x${string}`;

beforeAll(async () => {
  const account = privateKeyToAccount(PRIVATE_KEY!);
  const publicClient = createPublicClient({ transport: http(RPC_URL) }) as PublicClient;
  const walletClient = createWalletClient({ account, transport: http(RPC_URL) }) as WalletClient;

  const txHash = await walletClient.sendTransaction({
    chain: walletClient.chain ?? null,
    account: walletClient.account ?? null,
    data: OPEN_CONDITION_BYTECODE,
  });
  const receipt = await publicClient.waitForTransactionReceipt({ hash: txHash });
  if (!receipt.contractAddress) {
    throw new Error("Open-condition deploy did not produce a contract address");
  }
  openCondition = receipt.contractAddress;
  // eslint-disable-next-line no-console
  console.log(`\n[suite-setup] openCondition deployed at ${openCondition}\n`);
}, 30_000);

// ---------------------------------------------------------------------------
// Read-only `status` commands — no wallet required, no chain mutation.
// ---------------------------------------------------------------------------

describe("status (read-only)", () => {
  it("status fees returns three bigint-string fees", async () => {
    const { stdout, exitCode } = await runCli(["status", "fees", "--json"], READ_ONLY_ENV);
    expect(exitCode).toBe(0);
    const parsed = JSON.parse(stdout) as { allocateFee: string; writeFee: string; readFee: string };
    logCase("parsed", parsed);
    for (const k of ["allocateFee", "writeFee", "readFee"] as const) {
      expect(typeof parsed[k]).toBe("string");
      expect(parsed[k]).toMatch(/^\d+$/);
    }
  }, 30_000);

  it("status round returns full DKG network state", async () => {
    const { stdout, exitCode } = await runCli(["status", "round", "--json"], READ_ONLY_ENV);
    expect(exitCode).toBe(0);
    const network = JSON.parse(stdout) as Record<string, unknown>;
    logCase("network", network);
    expect(network.round).toBeGreaterThan(0);
    expect(network.stage).toBe(4); // Active
    expect(network.total).toBeGreaterThan(0);
    expect(network.threshold).toBeGreaterThan(0);
    expect(typeof network.startBlockHeight).toBe("string"); // bigint stringified
    expect(network.startBlockHash).toMatch(/^0x[0-9a-f]+$/);
    expect(network.globalPublicKey).toMatch(/^0x[0-9a-f]+$/);
    expect(Array.isArray(network.activeValSet)).toBe(true);
    expect(Array.isArray(network.publicCoeffs)).toBe(true);
    expect(typeof network.isResharing).toBe("boolean");
  }, 30_000);

  it("status validators returns address → commPubKey hex map", async () => {
    const { stdout, exitCode } = await runCli(["status", "validators", "--json"], READ_ONLY_ENV);
    expect(exitCode).toBe(0);
    const validators = JSON.parse(stdout) as Record<string, string>;
    const entries = Object.entries(validators);
    logCase("validators", validators);
    logCase("count", entries.length);
    expect(entries.length).toBeGreaterThan(0);
    for (const [addr, hex] of entries) {
      expect(addr).toMatch(/^0x[0-9a-f]{40}$/);
      expect(hex).toMatch(/^0x[0-9a-f]+$/);
    }
  }, 30_000);
});

// ---------------------------------------------------------------------------
// Chain mutations: `upload` + `access` happy path, plus `status vault` of
// the just-uploaded vault. State threads through `let uploadedUuid` /
// `uploadedDataKey` since vitest runs sibling `it` blocks in declaration
// order within a describe.
// ---------------------------------------------------------------------------

describe("upload + access (mutations + e2e round-trip)", () => {
  let uploadedUuid: number;
  let uploadedDataKey: string;

  it("upload produces {uuid, dataKey, txHashes}", async () => {
    const { stdout, exitCode, stderr } = await runCli(
      [
        "upload",
        "--write-condition", openCondition,
        "--read-condition", openCondition,
        "--json",
      ],
      FULL_ENV,
    );
    expect(exitCode, `stderr=${stderr}`).toBe(0);
    const parsed = JSON.parse(stdout) as {
      uuid: number;
      dataKey: string;
      txHashes: { allocate: string; write: string };
    };
    logCase("upload result", parsed);
    expect(typeof parsed.uuid).toBe("number");
    expect(parsed.uuid).toBeGreaterThanOrEqual(0);
    expect(parsed.dataKey).toMatch(/^0x[0-9a-f]{64}$/); // 32 bytes
    expect(parsed.txHashes.allocate).toMatch(/^0x[0-9a-f]{64}$/);
    expect(parsed.txHashes.write).toMatch(/^0x[0-9a-f]{64}$/);
    uploadedUuid = parsed.uuid;
    uploadedDataKey = parsed.dataKey;
  }, 90_000);

  it("access <uuid> recovers the original dataKey (e2e round-trip)", async () => {
    const { stdout, exitCode, stderr } = await runCli(
      ["access", String(uploadedUuid), "--json"],
      FULL_ENV,
    );
    expect(exitCode, `stderr=${stderr}`).toBe(0);
    const parsed = JSON.parse(stdout) as { dataKey: string; txHash: string };
    logCase("access result", parsed);
    logCase("expected dataKey (from upload)", uploadedDataKey);
    expect(parsed.dataKey).toBe(uploadedDataKey); // byte-equal
    expect(parsed.txHash).toMatch(/^0x[0-9a-f]{64}$/);
  }, 180_000);

  it("status vault <uuid> returns the vault uploaded above", async () => {
    const { stdout, exitCode } = await runCli(
      ["status", "vault", String(uploadedUuid), "--json"],
      READ_ONLY_ENV,
    );
    expect(exitCode).toBe(0);
    const vault = JSON.parse(stdout) as Record<string, unknown>;
    logCase("vault", vault);
    expect(vault.uuid).toBe(uploadedUuid);
    expect(vault.encryptedData).toMatch(/^0x[0-9a-f]+$/);
    expect((vault.writeConditionAddr as string).toLowerCase()).toBe(openCondition.toLowerCase());
    expect((vault.readConditionAddr as string).toLowerCase()).toBe(openCondition.toLowerCase());
  }, 30_000);
});

// ---------------------------------------------------------------------------
// Env / flag fallback + error UX.
// ---------------------------------------------------------------------------

describe("env fallback + error UX", () => {
  it("status fees works using env vars only (no flags)", async () => {
    // Already exercised by all the cases above (none pass --api-url / --rpc-url),
    // but pin it explicitly here so a regression where flags become required
    // surfaces with a clear-named test.
    const { stdout, exitCode } = await runCli(["status", "fees", "--json"], READ_ONLY_ENV);
    expect(exitCode).toBe(0);
    logCase("exitCode", exitCode);
    logCase("parsed", JSON.parse(stdout));
  }, 30_000);

  it("missing CDR_API_URL exits 1 with structured JSON error", async () => {
    const { stdout, stderr, exitCode } = await runCli(
      ["status", "fees", "--json"],
      {}, // no env at all
    );
    expect(exitCode).toBe(1);
    const parsed = extractJson(stdout + stderr) as {
      error: { message: string; missing?: string };
    };
    logCase("exitCode", exitCode);
    logCase("error", parsed);
    expect(parsed.error).toBeDefined();
    expect(parsed.error.missing).toBe("CDR_API_URL");
  }, 30_000);

  it("upload without CDR_TEST_PRIVATE_KEY exits 1 with per-command missing-key error", async () => {
    const { stdout, stderr, exitCode } = await runCli(
      [
        "upload",
        "--write-condition", openCondition,
        "--read-condition", openCondition,
        "--json",
      ],
      READ_ONLY_ENV, // has API_URL + RPC_URL but no PRIVATE_KEY
    );
    expect(exitCode).toBe(1);
    const parsed = extractJson(stdout + stderr) as {
      error: { message: string; missing?: string };
    };
    logCase("exitCode", exitCode);
    logCase("error", parsed);
    expect(parsed.error.missing).toBe("CDR_TEST_PRIVATE_KEY");
  }, 30_000);
});
