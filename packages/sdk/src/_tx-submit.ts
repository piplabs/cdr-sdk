import {
  encodeFunctionData,
  keccak256,
  type Abi,
  type Account,
  type Address,
  type Chain,
  type Hash,
  type Hex,
  type PublicClient,
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

// How long to keep looking for an already-broadcast tx (json-rpc recovery)
// before giving up. The colliding tx is already in the pool, so it normally
// mines within a few blocks; this is just a backstop.
const NONCE_RECOVERY_DEADLINE_MS = 2 * 60 * 1000;
const NONCE_RECOVERY_POLL_MS = 2000;

/**
 * Idempotent replacement for `walletClient.writeContract(...)` against
 * shared/slow public RPCs.
 *
 * viem's default HTTP transport retries `eth_sendRawTransaction` /
 * `eth_sendTransaction` on slow acks. The first broadcast may have already
 * landed in the mempool, so a naive retry collides as a same-nonce
 * non-bumped replacement and the node rejects it with `replacement
 * transaction underpriced` / `already known` (surfaced by viem as the
 * misleading top-line `Missing or invalid parameters`). See
 * piplabs/cdr-sdk#122. The error is not actionable — the tx really is in
 * flight; the SDK just needs to learn its hash and wait on the receipt.
 *
 * Two account types, two recovery mechanisms (both end at the real tx hash):
 *
 * - LOCAL account (key in-process, e.g. `privateKeyToAccount`): we pre-sign
 *   so we know the hash up front, then on an "already submitted" collision
 *   return that precomputed hash.
 * - JSON-RPC account (browser wallet / MetaMask / node-managed keystore): the
 *   node signs via `eth_sendTransaction`, so we cannot pre-sign. We capture
 *   the sender + pending nonce before sending, defer to `writeContract`, and
 *   on a collision recover the hash by scanning for the mined tx with that
 *   `(sender, nonce)`. There is no standard RPC to look a tx up by nonce, so
 *   this is a bounded block scan — fine on a low-volume chain like aeneid.
 *
 * `nonce too low` is intentionally NOT treated as "already submitted": it can
 * mean a *different* tx consumed the nonce, in which case ours never lands.
 */
export async function safeWriteContract(
  walletClient: WalletClient,
  publicClient: PublicClient,
  params: SafeWriteContractParams,
): Promise<Hash> {
  const account = params.account ?? walletClient.account ?? null;
  const isLocalAccount =
    typeof account === "object" && account !== null && (account as Account).type === "local";

  if (!isLocalAccount) {
    return submitViaNode(walletClient, publicClient, params, account);
  }

  return submitPreSigned(walletClient, params);
}

/**
 * Local-account path: pre-sign to learn the hash, broadcast the raw tx, and
 * return the precomputed hash on an already-submitted collision.
 */
async function submitPreSigned(
  walletClient: WalletClient,
  params: SafeWriteContractParams,
): Promise<Hash> {
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

/**
 * JSON-RPC-account path: the node signs, so we can't pre-sign. Capture the
 * sender + pending nonce, defer to writeContract, and on an already-submitted
 * collision recover the hash by finding the mined tx with that (sender, nonce).
 */
async function submitViaNode(
  walletClient: WalletClient,
  publicClient: PublicClient,
  params: SafeWriteContractParams,
  account: Account | Address | null,
): Promise<Hash> {
  const from = accountAddress(account);

  // Capture (nonce, startBlock) BEFORE sending so a collision is recoverable.
  // Best-effort: if these reads fail we still attempt the send and just can't
  // recover a colliding hash (same as before this path existed).
  let nonce: number | undefined;
  let startBlock: bigint | undefined;
  if (from) {
    try {
      nonce = await publicClient.getTransactionCount({ address: from, blockTag: "pending" });
      startBlock = await publicClient.getBlockNumber();
    } catch {
      // ignore — recovery just won't be possible
    }
  }

  try {
    return await walletClient.writeContract({
      account: params.account,
      chain: params.chain,
      address: params.address,
      abi: params.abi,
      functionName: params.functionName,
      args: params.args as readonly unknown[],
      value: params.value,
    } as Parameters<typeof walletClient.writeContract>[0]);
  } catch (err) {
    if (
      isAlreadySubmittedError(err) &&
      from &&
      nonce !== undefined &&
      startBlock !== undefined
    ) {
      return recoverHashBySenderNonce(publicClient, from, nonce, startBlock);
    }
    throw err;
  }
}

function accountAddress(account: Account | Address | null): Address | null {
  if (typeof account === "string") return account;
  if (account && typeof account === "object" && typeof (account as Account).address === "string") {
    return (account as Account).address;
  }
  return null;
}

/**
 * Find the hash of an already-broadcast tx by its (sender, nonce) — used to
 * recover from a json-rpc retry self-collision where we never learned the
 * hash. There is no standard RPC for nonce lookup, so we scan blocks from
 * `fromBlock` forward (a given (sender, nonce) maps to at most one mined tx).
 * Bounded by a deadline; throws if not found in time.
 */
async function recoverHashBySenderNonce(
  publicClient: PublicClient,
  from: Address,
  nonce: number,
  fromBlock: bigint,
): Promise<Hash> {
  const fromLc = from.toLowerCase();
  const deadline = Date.now() + NONCE_RECOVERY_DEADLINE_MS;
  let next = fromBlock;

  while (Date.now() < deadline) {
    const head = await publicClient.getBlockNumber();
    for (; next <= head; next++) {
      const block = await publicClient.getBlock({ blockNumber: next, includeTransactions: true });
      for (const tx of block.transactions) {
        if (
          typeof tx === "object" &&
          tx.from?.toLowerCase() === fromLc &&
          tx.nonce === nonce
        ) {
          return tx.hash;
        }
      }
    }
    await new Promise((resolve) => setTimeout(resolve, NONCE_RECOVERY_POLL_MS));
  }

  throw new Error(
    `safeWriteContract: tx was accepted by the node (already-in-mempool) but its hash ` +
      `could not be recovered for sender ${from} nonce ${nonce} within ` +
      `${NONCE_RECOVERY_DEADLINE_MS}ms`,
  );
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
