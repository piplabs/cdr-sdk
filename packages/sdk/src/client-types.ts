/**
 * Structural subsets of viem's `PublicClient` / `WalletClient` — only the
 * methods + fields this SDK actually invokes.
 *
 * Public API surface accepts these types instead of viem's concrete clients
 * to avoid dual-version nominal-type breakage when a consuming app and the
 * SDK resolve to different `viem` releases under `node_modules/.pnpm/...`.
 * Any client (viem, wagmi wrapper, custom) that satisfies the shape works.
 *
 * Method args/results are intentionally permissive; call sites cast results
 * to the concrete type they expect. Optional methods are only required by
 * the flows that call them.
 */

export interface CDRPublicClient {
  readContract(args: unknown): Promise<unknown>;
  waitForTransactionReceipt(args: {
    hash: `0x${string}`;
    timeout?: number;
    pollingInterval?: number;
    retryCount?: number;
  }): Promise<{ logs: unknown[] }>;
  simulateContract?(args: unknown): Promise<unknown>;
  getBalance?(args: { address: `0x${string}` }): Promise<bigint>;
}

/**
 * The wallet's `account` is shaped loosely on purpose: viem accepts either a
 * raw address (`0x...`) or an `Account` object with `address`. We accept
 * either form, plus `null` / `undefined` for unconnected wallets.
 */
export interface CDRWalletClient {
  account?: { address: `0x${string}` } | `0x${string}` | null;
  chain?: unknown;
  writeContract(args: unknown): Promise<`0x${string}`>;
}

/**
 * Extract a hex address from the loosely-typed `account` field. Returns
 * `undefined` if the account is missing or its shape is unrecognized.
 *
 * Used by balance-preflight and other helpers that need the sender address
 * before submitting a transaction.
 */
export function getWalletAddress(
  account: CDRWalletClient["account"],
): `0x${string}` | undefined {
  if (!account) return undefined;
  if (typeof account === "string") {
    return account.startsWith("0x") ? (account as `0x${string}`) : undefined;
  }
  if (typeof account === "object" && "address" in account) {
    const addr = account.address;
    return typeof addr === "string" && addr.startsWith("0x")
      ? (addr as `0x${string}`)
      : undefined;
  }
  return undefined;
}
