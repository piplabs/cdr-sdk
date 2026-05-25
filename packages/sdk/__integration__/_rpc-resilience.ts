/**
 * RPC resilience helpers for integration tests that target rate-limited
 * public endpoints (e.g. `https://aeneid.storyrpc.io`).
 *
 * **Scope of use**: ONLY the `*-aeneid.test.ts` files. The DevNet-targeted
 * suites import `http` directly from viem and run at full concurrency —
 * adding retry / throttling there would mask real validator-side issues.
 */

import { http, type Hash, type PublicClient } from "viem";

/**
 * `publicClient.waitForTransactionReceipt` with parameters tuned for
 * public RPC endpoints (default viem `timeout: 180_000` is too tight when
 * receipt propagation lags block production — see cdr-sdk run
 * 26379164817, wallet idx=29: tx 0x914c3c... landed in block 0x11d2547
 * but viem gave up first, failing 1/100 in 100w-fresh-aeneid). Bumping
 * `timeout` to 5 min covers any realistic public-RPC tail.
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
