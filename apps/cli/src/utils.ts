import { type PublicClient, type WalletClient, createPublicClient, createWalletClient, http } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { CDRClient, type Network } from "@piplabs/cdr-sdk";

const DEFAULT_RPC_URLS: Record<Network, string> = {
  mainnet: "https://rpc.story.foundation",
  testnet: "https://aeneid.storyrpc.io",
};

export interface GlobalOptions {
  network: Network;
  rpcUrl?: string;
  /** Story-API REST URL. Falls back to `CDR_API_URL` env. No baked-in default — must be supplied explicitly. */
  apiUrl?: string;
  privateKey?: string;
  json: boolean;
}

export interface ResolvedConfig {
  network: Network;
  rpcUrl: string;
  apiUrl: string;
  /** Resolved private key, present iff supplied via flag or env. */
  privateKey?: `0x${string}`;
  json: boolean;
}

/**
 * Validate global options + resolve from env. Precedence: CLI flag > env var.
 *
 * `requireWallet=true` for commands that send transactions (`upload`,
 * `access`); `false` for read-only Observer queries (`status *`). Missing
 * required values exit the process with code 1; in `--json` mode the error
 * is emitted as `{"error": {"message", "missing"}}` so scripts can parse it.
 */
export function resolveConfig(opts: GlobalOptions, requireWallet: boolean): ResolvedConfig {
  const apiUrl = opts.apiUrl ?? process.env.CDR_API_URL;
  if (!apiUrl) {
    errExit(
      opts.json,
      "Story-API REST URL is required. Pass --api-url <url> or set CDR_API_URL env.",
      "CDR_API_URL",
    );
  }

  // RPC has a network-default fallback so read-only commands work out of the
  // box on mainnet/testnet. To override (e.g., for DevNet), pass --rpc-url
  // or set CDR_RPC_URL env.
  const rpcUrl = opts.rpcUrl ?? process.env.CDR_RPC_URL ?? DEFAULT_RPC_URLS[opts.network];

  const privateKey = (opts.privateKey ?? process.env.CDR_TEST_PRIVATE_KEY) as `0x${string}` | undefined;
  if (requireWallet && !privateKey) {
    errExit(
      opts.json,
      "Wallet private key is required for this command. Pass --private-key <hex> or set CDR_TEST_PRIVATE_KEY env.",
      "CDR_TEST_PRIVATE_KEY",
    );
  }

  return {
    network: opts.network,
    rpcUrl,
    apiUrl,
    privateKey,
    json: opts.json,
  };
}

export function createClient(cfg: ResolvedConfig): CDRClient {
  const publicClient = createPublicClient({ transport: http(cfg.rpcUrl) }) as PublicClient;
  let walletClient: WalletClient | undefined;
  if (cfg.privateKey) {
    const account = privateKeyToAccount(cfg.privateKey);
    walletClient = createWalletClient({ account, transport: http(cfg.rpcUrl) }) as WalletClient;
  }
  return new CDRClient({
    network: cfg.network,
    publicClient,
    walletClient,
    apiUrl: cfg.apiUrl,
  });
}

/**
 * Parse a CLI numeric argument with strict whole-string validation.
 *
 * `parseInt("12oops")` returns `12` because it stops at the first
 * non-digit — that lets malformed user input silently coerce into
 * a valid-looking number. We gate on `/^\d+$/` so the *entire* input
 * must be digits (no trailing garbage, no signs, no decimal, no
 * scientific notation, no whitespace, no hex prefix).
 *
 * Calls `errExit` on rejection — the caller does not need to handle
 * the error path.
 */
export function parseNonNegInt(value: string, label: string, json: boolean): number {
  if (!/^\d+$/.test(value)) {
    errExit(json, `Invalid ${label}: ${value}. Must be a non-negative integer.`);
  }
  const n = parseInt(value, 10);
  // Defensive: a 21-digit input parses to a non-safe-integer like 1e21.
  // uuid is uint32 (max 10 digits) so legitimate values can never trip
  // this branch; it just blocks pathological input from flowing on.
  if (!Number.isSafeInteger(n)) {
    errExit(json, `Invalid ${label}: ${value}. Exceeds safe integer range.`);
  }
  return n;
}

/**
 * Print an error and exit. In `--json` mode, output structured JSON with
 * `error.message` (and optionally `error.missing` for missing-config errors)
 * to stderr; otherwise print a plain message. Always exits 1.
 */
export function errExit(json: boolean, message: string, missing?: string): never {
  if (json) {
    const payload = missing ? { error: { message, missing } } : { error: { message } };
    console.error(JSON.stringify(payload));
  } else {
    console.error(`Error: ${message}`);
  }
  process.exit(1);
}

export function output(data: unknown, json: boolean): void {
  if (json) {
    console.log(JSON.stringify(data, replacer, 2));
    return;
  }
  // Human-readable: top-level object → "key: value" per line; nested
  // values are inlined as compact JSON. The replacer normalises bigint /
  // Uint8Array / Map first so values render naturally.
  const normalised = JSON.parse(JSON.stringify(data, replacer)) as unknown;
  if (normalised === null || typeof normalised !== "object" || Array.isArray(normalised)) {
    console.log(typeof normalised === "string" ? normalised : JSON.stringify(normalised));
    return;
  }
  for (const [k, v] of Object.entries(normalised as Record<string, unknown>)) {
    const rendered =
      v === null || typeof v !== "object"
        ? String(v)
        : JSON.stringify(v);
    console.log(`${k}: ${rendered}`);
  }
}

/**
 * JSON.stringify replacer that handles SDK return values:
 * - `bigint` → decimal string (so JSON parsers don't choke)
 * - `Uint8Array` → `0x`-prefixed hex string
 * - `Map` → plain object (so getRegisteredValidators output round-trips through JSON)
 */
function replacer(_key: string, value: unknown): unknown {
  if (typeof value === "bigint") return value.toString();
  if (value instanceof Uint8Array) {
    return "0x" + Array.from(value).map((b) => b.toString(16).padStart(2, "0")).join("");
  }
  if (value instanceof Map) return Object.fromEntries(value);
  return value;
}
