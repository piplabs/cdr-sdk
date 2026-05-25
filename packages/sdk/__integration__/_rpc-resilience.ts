/**
 * RPC resilience helpers for integration tests that target rate-limited
 * public endpoints (e.g. `https://aeneid.storyrpc.io`).
 *
 * **Scope of use**: ONLY the `*-aeneid.test.ts` files. The DevNet-targeted
 * suites import `http` directly from viem and run at full concurrency —
 * adding retry / throttling there would mask real validator-side issues.
 *
 * Helpers are ordered along the chain of resilience layers a public-RPC
 * test composes from the outside in:
 *
 *   1. `resilientHttp`         — viem transport with bumped HTTP retry budget
 *   2. `pLimit`                — caps concurrent in-flight RPC calls
 *   3. `waitForReceiptResilient` — bumps viem's per-call receipt timeout
 *   4. `withAeneidFlakeRetry`  — retries a whole upload→access cycle on the
 *                                 two known public-pool consistency bugs
 */

import { http, type Hash, type PublicClient } from "viem";

/**
 * `http()` with retry budget tuned for public-RPC throttling.
 *
 * viem already retries on HTTP 429 / 408 / 413 / 500 / 502 / 503 / 504 with
 * exponential backoff (`~~(1 << count) * retryDelay`) and honors any
 * `Retry-After` header (viem `buildRequest.js`). The defaults
 * (`retryCount: 3`, `retryDelay: 150`) exhaust in ~1s — too fast for a
 * 100-way burst against a public endpoint. The values below give a
 * ~31s envelope (500ms, 1s, 2s, 4s, 8s, 16s) across 5 retries.
 */
export function resilientHttp(rpcUrl: string, opts?: {
  retryCount?: number;
  retryDelay?: number;
}) {
  return http(rpcUrl, {
    retryCount: opts?.retryCount ?? 5,
    retryDelay: opts?.retryDelay ?? 500,
  });
}

/**
 * Tiny in-process semaphore. Returns a `run` function that gates `fn`
 * to at most `maxConcurrency` in-flight executions; surplus callers
 * wait FIFO.
 *
 * Used to cap burst pressure on a public RPC: the test still launches
 * N logical workers, but the RPC sees at most `maxConcurrency`
 * outstanding requests at a time.
 *
 * **Usage contract (closed-system)**: every caller of `run()` must
 * enter inside a single synchronous tick (e.g. `wallets.map(w =>
 * run(...))`). No new `run()` calls may interleave with already-running
 * or already-queued workers' completions. In this mode, the first
 * `maxConcurrency` callers admit immediately and the rest queue;
 * thereafter the system is closed and each completion admits exactly
 * one waiter — `active` is provably bounded by `maxConcurrency`.
 *
 * The `active++` after the await deliberately omits a re-check (jinn
 * #L54). A streaming/open-system caller arriving between a releaser's
 * `next()` and the awaiting waiter's resume could read a stale `active`
 * and admit itself, leaving the resumed waiter to over-increment past
 * `maxConcurrency`. If this helper is ever reused in a streaming
 * pattern, replace this with a pre-increment-on-admit design (releaser
 * does `active++` before `next()`, waiter skips the post-await `active++`).
 */
export function pLimit(maxConcurrency: number) {
  if (!Number.isInteger(maxConcurrency) || maxConcurrency < 1) {
    throw new Error(`pLimit: maxConcurrency must be a positive integer, got ${maxConcurrency}`);
  }
  const queue: Array<() => void> = [];
  let active = 0;
  return async function run<T>(fn: () => Promise<T>): Promise<T> {
    if (active >= maxConcurrency) {
      await new Promise<void>((resolve) => queue.push(resolve));
    }
    active++;
    try {
      return await fn();
    } finally {
      active--;
      const next = queue.shift();
      if (next) next();
    }
  };
}

/**
 * `publicClient.waitForTransactionReceipt` with `timeout` widened to 5 min
 * for public-RPC endpoints whose `eth_getTransactionReceipt` can lag block
 * production by tens of seconds (viem default `timeout: 180_000` is too
 * tight for the tail). Mirrors the SDK-internal helper in
 * `packages/sdk/src/uploader.ts`; the duplication is intentional — the
 * SDK shouldn't take a dependency on test-only files.
 */
export async function waitForReceiptResilient(
  publicClient: PublicClient,
  hash: Hash,
) {
  return publicClient.waitForTransactionReceipt({
    hash,
    timeout: 5 * 60 * 1000,
    pollingInterval: 2000,
    retryCount: 30,
  });
}

/**
 * Retries `fn` on the two known aeneid public-RPC pool consistency bugs:
 *
 *   1. **receipt-not-found** — `eth_getTransactionReceipt` is served by a
 *      pool node that lags the one which served `eth_sendRawTransaction`.
 *      Viem throws `TransactionReceiptNotFoundError` /
 *      `WaitForTransactionReceiptTimeoutError` even though the tx is
 *      mined. Sleep then re-poll — the lagging node usually catches up.
 *   2. **write-state-race** — an SDK `uploadCDR` allocate→write sequence
 *      gets its `write()` simulation served by a node that hasn't yet
 *      applied the allocate's state, so the contract's
 *      `require(writeConditionAddr != address(0))` reverts with `CDR:
 *      Write condition address not set` even though the chain state
 *      *does* have the address set. Retrying the whole cycle re-runs
 *      allocate against a (different / caught-up) pool node and the
 *      write simulation passes.
 *
 * Both rethrow unrelated errors immediately so genuine bugs still fail
 * the test on the first attempt. Default budget: 3 attempts, 5s between.
 * For an idempotent upload→access cycle the retry burns at most ~2× the
 * cycle fee (typically ~0.24 IP / cycle on aeneid), well under the
 * `safetyMultiplier: 3` headroom in `_helpers.computePerWalletFund`.
 */
export async function withAeneidFlakeRetry<T>(
  fn: () => Promise<T>,
  opts?: { attempts?: number; delayMs?: number },
): Promise<T> {
  const attempts = opts?.attempts ?? 3;
  const delayMs = opts?.delayMs ?? 5000;
  let lastError: unknown;
  for (let attempt = 0; attempt < attempts; attempt++) {
    try {
      return await fn();
    } catch (err) {
      lastError = err;
      if (!isAeneidPoolFlake(err)) throw err;
      if (attempt + 1 < attempts) {
        await new Promise<void>((resolve) => setTimeout(resolve, delayMs));
      }
    }
  }
  throw lastError;
}

function isAeneidPoolFlake(err: unknown): boolean {
  if (!(err instanceof Error)) return false;
  // Viem tags receipt-related errors via `.name` even when wrapped.
  if (
    err.name === "TransactionReceiptNotFoundError" ||
    err.name === "WaitForTransactionReceiptTimeoutError"
  ) {
    return true;
  }
  // Contract reverts from CDR.sol when a stale read pool serves the
  // simulation before the preceding tx propagated.
  const msg = err.message;
  return (
    msg.includes("CDR: Write condition address not set") ||
    msg.includes("CDR: Read condition address not set")
  );
}
