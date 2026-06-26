import {
  TransactionReceiptNotFoundError,
  WaitForTransactionReceiptTimeoutError,
  type Hash,
  type PublicClient,
} from "viem";

/**
 * Wraps `publicClient.waitForTransactionReceipt` for public RPC endpoints
 * (e.g. `https://aeneid.storyrpc.io`) where receipt propagation can lag
 * block production by tens of seconds for a small tail of txs.
 *
 * The key failure this guards against: viem observes the tx included in a
 * block, immediately calls `eth_getTransactionReceipt`, and the pool node
 * serving that call hasn't surfaced the receipt yet → viem throws
 * `TransactionReceiptNotFoundError` out of its block-watcher callback. That
 * throw does NOT respect the `timeout` / `retryCount` options — those cover
 * the overall deadline and transport-level errors, not a receipt that is
 * momentarily null after the block is seen. So bumping `timeout`/`retryCount`
 * alone (the previous approach) still failed on this race:
 *   - run 26379164817 wallet idx=29: allocate 0x914c3c... mined block
 *     0x11d2547 status=1, viem gave up first (1/100 fail in 100w-fresh-aeneid)
 *   - run 26501253421: uploadCDR write 0x8d1ae... committed block 0x11eb8d2
 *     status=1, threw TransactionReceiptNotFoundError after ~8s, failing the
 *     consumer feeOverride test (which itself never waits on a receipt — the
 *     throw came from its uploadCDR preamble)
 *
 * Fix: re-poll the whole `waitForTransactionReceipt` on
 * `TransactionReceiptNotFoundError` / `WaitForTransactionReceiptTimeoutError`,
 * bounded by an overall 5 min deadline. A genuinely reverted tx returns a
 * receipt with `status: "reverted"` (it does NOT throw), so this never masks
 * a real revert. Test code has a mirror in
 * `packages/sdk/__integration__/_rpc-resilience.ts`; the duplication is
 * intentional — the SDK shouldn't take a dependency on test-only files.
 */
export async function waitForReceiptResilient(publicClient: PublicClient, hash: Hash) {
  const deadlineMs = Date.now() + 5 * 60 * 1000;
  let lastError: unknown;
  while (Date.now() < deadlineMs) {
    try {
      return await publicClient.waitForTransactionReceipt({
        hash,
        timeout: 30_000,
        pollingInterval: 2000,
        retryCount: 10,
      });
    } catch (err) {
      if (
        !(err instanceof TransactionReceiptNotFoundError) &&
        !(err instanceof WaitForTransactionReceiptTimeoutError)
      ) {
        throw err;
      }
      lastError = err;
      await new Promise((resolve) => setTimeout(resolve, 2000));
    }
  }
  // The loop always runs at least once (deadlineMs is now + 5 min), so
  // lastError is always set here — the fallback is for the type-checker and
  // to avoid a stackless `throw undefined` if the deadline logic ever changes.
  throw lastError ?? new Error("waitForReceiptResilient: receipt wait deadline exceeded");
}
