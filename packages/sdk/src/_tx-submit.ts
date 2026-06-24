import {
  encodeFunctionData,
  keccak256,
  type Abi,
  type Account,
  type Address,
  type Chain,
  type Hash,
  type Hex,
  type WalletClient,
} from "viem";

export interface SafeWriteContractParams {
  account: Account | Address | null;
  chain: Chain | null;
  address: Address;
  abi: Abi;
  functionName: string;
  args: readonly unknown[];
  value?: bigint;
}

/**
 * Idempotent replacement for `walletClient.writeContract(...)` against
 * shared/slow public RPCs.
 *
 * viem's default HTTP transport retries `eth_sendRawTransaction` on slow
 * acks. The first broadcast may have already landed in the mempool, so a
 * naive retry collides as a same-nonce non-bumped replacement and the
 * node rejects it with `replacement transaction underpriced` (surfaced
 * by viem as the misleading top-line `Missing or invalid parameters`).
 * See piplabs/cdr-sdk#122.
 *
 * The fix here pre-signs the tx so we know its hash up front, then
 * recognises the "already submitted" error family — `replacement
 * transaction underpriced` and `already known`, which unambiguously
 * mean *this exact tx* is already in flight — and returns the
 * precomputed hash so the caller can wait for the receipt as if the
 * original broadcast had succeeded. `nonce too low` is intentionally
 * NOT in this set: it can also mean a *different* tx consumed the
 * nonce, in which case ours never lands and the precomputed hash
 * would hang `waitForTransactionReceipt`.
 *
 * Account types: only a LOCAL account (private key in-process, e.g.
 * `privateKeyToAccount`) can be signed without the node, which is what lets
 * us precompute the hash. A JSON-RPC account (browser wallet / MetaMask /
 * node-managed keystore) signs through the node (`eth_sendTransaction`) and
 * cannot be pre-signed locally — for those we fall back to viem's
 * `writeContract` (exactly the pre-existing call path). That fallback does
 * NOT get the retry-self-collision recovery, but it keeps JSON-RPC-account
 * wallets working.
 */
export async function safeWriteContract(
  walletClient: WalletClient,
  params: SafeWriteContractParams,
): Promise<Hash> {
  // Decide whether we can sign locally (and thus precompute the hash). Only a
  // local account (type === "local") holds the key in-process; a JSON-RPC
  // account or bare address is signed by the node.
  const account = params.account ?? walletClient.account ?? null;
  const isLocalAccount =
    typeof account === "object" && account !== null && (account as Account).type === "local";

  if (!isLocalAccount) {
    // Node-managed signer (MetaMask / JSON-RPC account / bare address): we
    // cannot pre-sign to learn the hash, so defer to viem's writeContract —
    // the same path the call sites used before this helper. No idempotent
    // retry recovery on this path, but it keeps these wallets working.
    return walletClient.writeContract({
      account: params.account,
      chain: params.chain,
      address: params.address,
      abi: params.abi,
      functionName: params.functionName,
      args: params.args as readonly unknown[],
      value: params.value,
    } as Parameters<typeof walletClient.writeContract>[0]);
  }

  const data: Hex = encodeFunctionData({
    abi: params.abi,
    functionName: params.functionName,
    args: params.args as readonly unknown[],
  });

  // null is the historical writeContract sentinel for "no override" — viem
  // accepts it (and validates internally). Coerce to undefined so the typed
  // surface of prepareTransactionRequest matches.
  const request = await walletClient.prepareTransactionRequest({
    account: params.account ?? undefined,
    chain: params.chain ?? undefined,
    to: params.address,
    data,
    value: params.value,
  } as Parameters<typeof walletClient.prepareTransactionRequest>[0]);

  // `signTransaction` calls `assertCurrentChain`, which throws if no chain
  // is in scope. `prepareTransactionRequest` only stores `chainId` on its
  // result, not a Chain object — so we synthesize a minimal one from the
  // request when the caller didn't supply chain explicitly. The full
  // writeContract path does the equivalent internally.
  const requestChainId = (request as { chainId?: number }).chainId;
  const chainForSigning: Chain | undefined =
    params.chain ??
    (typeof requestChainId === "number" ? ({ id: requestChainId } as Chain) : undefined);

  const serialized = await walletClient.signTransaction({
    ...request,
    chain: chainForSigning,
  } as Parameters<typeof walletClient.signTransaction>[0]);
  const expectedHash = keccak256(serialized);

  try {
    return await walletClient.sendRawTransaction({ serializedTransaction: serialized });
  } catch (err) {
    if (isAlreadySubmittedError(err)) {
      return expectedHash;
    }
    throw err;
  }
}

const ALREADY_SUBMITTED_PATTERNS = [
  "replacement transaction underpriced",
  "already known",
];

/**
 * Recognise the JSON-RPC error family that means "the tx is already in
 * flight" — i.e. the SDK should treat the submission as successful and
 * proceed to wait for the receipt.
 *
 * viem maps the real `-32000` reason into a generic top-line
 * `shortMessage`, so we walk the `cause` chain and match on `details` /
 * `message` of every link.
 */
export function isAlreadySubmittedError(err: unknown): boolean {
  let cur: unknown = err;
  let depth = 0;
  while (cur && typeof cur === "object" && depth < 10) {
    const c = cur as { details?: unknown; message?: unknown; cause?: unknown };
    const haystacks: string[] = [];
    if (typeof c.details === "string") haystacks.push(c.details.toLowerCase());
    if (typeof c.message === "string") haystacks.push(c.message.toLowerCase());
    for (const h of haystacks) {
      for (const pat of ALREADY_SUBMITTED_PATTERNS) {
        if (h.includes(pat)) return true;
      }
    }
    cur = c.cause;
    depth++;
  }
  return false;
}
