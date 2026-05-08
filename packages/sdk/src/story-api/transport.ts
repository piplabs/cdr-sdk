/**
 * HTTP transport for the Story-API REST client.
 * Handles the `{ code, msg, error }` envelope, 3-attempt retry on 5xx /
 * network errors, and the 404-vs-error distinction.
 */

import { StoryApiError, StoryApiNotFoundError } from "./errors.js";

const RETRY_ATTEMPTS = 3;
const RETRY_BASE_MS = 500;

/** Caller-supplied options accepted by every query function. */
export interface QueryOptions {
  /** Story-API base URL, e.g. `"http://node:1317"`. No trailing slash required. */
  apiUrl: string;
  /** Optional AbortSignal for cancellation. */
  signal?: AbortSignal;
}

interface Envelope<T> {
  code: number;
  msg: T | null;
  error: string;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export function joinPath(base: string, path: string): string {
  return `${base.replace(/\/+$/, "")}${path}`;
}

/**
 * Fetch + retry + envelope unwrap. Returns the inner `msg` on success.
 * 404 → `StoryApiNotFoundError`. Other failures → `StoryApiError`.
 */
export async function fetchJSON<T>(url: string, opts: QueryOptions): Promise<T> {
  let lastError: Error | undefined;

  for (let attempt = 0; attempt < RETRY_ATTEMPTS; attempt++) {
    if (opts.signal?.aborted) {
      throw opts.signal.reason ?? new Error("aborted");
    }

    try {
      const res = await fetch(url, {
        signal: opts.signal,
        headers: { Accept: "application/json" },
      });

      const bodyText = await res.text();

      // 5xx → retry
      if (res.status >= 500) {
        lastError = new StoryApiError(
          res.status,
          `5xx response: ${bodyText.slice(0, 200)}`,
        );
        if (attempt < RETRY_ATTEMPTS - 1) {
          await sleep(RETRY_BASE_MS * 2 ** attempt);
          continue;
        }
        throw lastError;
      }

      // Story-API returns JSON for registered endpoints; the Go HTTP mux
      // returns plain text "404 page not found" for unregistered paths.
      let envelope: Envelope<T> | undefined;
      try {
        envelope = JSON.parse(bodyText) as Envelope<T>;
      } catch {
        // Not JSON — fall through to status-based handling.
      }

      if (res.status === 404) {
        throw new StoryApiNotFoundError(
          envelope?.error ?? bodyText.trim() ?? "not found",
        );
      }

      if (envelope == null) {
        throw new StoryApiError(
          res.status,
          `non-JSON body: ${bodyText.slice(0, 200)}`,
        );
      }

      if (envelope.code !== 200 || envelope.msg == null) {
        throw new StoryApiError(
          res.status,
          envelope.error || `code=${envelope.code}`,
          envelope.code,
        );
      }

      return envelope.msg;
    } catch (err) {
      // Pass through abort + typed errors (no retry)
      if (err instanceof StoryApiNotFoundError) throw err;
      if (err instanceof StoryApiError && err.status < 500) throw err;
      if (opts.signal?.aborted) throw err;

      // Network errors / 5xx → retry
      lastError = err instanceof Error ? err : new Error(String(err));
      if (attempt < RETRY_ATTEMPTS - 1) {
        await sleep(RETRY_BASE_MS * 2 ** attempt);
        continue;
      }
      throw lastError;
    }
  }

  // Unreachable if RETRY_ATTEMPTS > 0, but keeps TS happy.
  throw lastError ?? new Error("fetchJSON: unknown error");
}
