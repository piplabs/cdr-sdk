/**
 * Shared helpers for integration suites under `__integration__/`.
 *
 * The default vitest include glob is `**\/*.{test,spec}.ts`, so this file
 * is NOT picked up as a test file — safe place to colocate test utilities
 * with the suites that use them.
 */

import { expect, vi } from "vitest";
import { bytesToHex } from "../src/story-api/index.js";

/**
 * `JSON.stringify` replacer for live response logging:
 *   - `Map`        → plain object (so commPubKey-by-validator dumps cleanly)
 *   - `Uint8Array` → hex (truncated for fields longer than 80 hex chars,
 *     so e.g. a 4.7 KiB enclaveReport doesn't drown the console)
 *   - `bigint`     → string (so block heights serialize cleanly)
 */
export function pretty(value: unknown): string {
  return JSON.stringify(
    value,
    (_key, v) => {
      if (v instanceof Map) return Object.fromEntries(v);
      if (v instanceof Uint8Array) {
        const hex = bytesToHex(v);
        return hex.length > 80 ? `${hex.slice(0, 60)}…(${v.length}B)` : hex;
      }
      if (typeof v === "bigint") return v.toString();
      return v;
    },
    2,
  );
}

/**
 * Log a labeled value scoped to the current vitest test case. Prefixes
 * every block with the case name so that, when many integration tests
 * stream stdout interleaved into the same terminal, each line stays
 * attributable to its `it(...)`.
 *
 *   logCase("round", 4)
 *   → [getActiveRound matches latest_active.round] round
 *     4
 *
 * Strings and numbers/bigints render as-is; everything else goes through
 * `pretty()`.
 */
export function logCase(label: string, value: unknown): void {
  const fullName = expect.getState().currentTestName ?? "(unknown)";
  // Take the last `it(...)` segment to drop the long `describe(...)` chain.
  const caseName = fullName.split(" > ").pop() ?? fullName;
  const formatted =
    typeof value === "string"
      ? value
      : typeof value === "number" || typeof value === "bigint"
        ? String(value)
        : pretty(value);
  // eslint-disable-next-line no-console
  console.log(`\n[${caseName}] ${label}\n${formatted}`);
}

/** All recorded fetch URLs that hit a `/dkg/*` endpoint, in order. */
export function dkgFetchUrls(spy: ReturnType<typeof vi.spyOn>): string[] {
  return spy.mock.calls
    .map(([url]) => {
      if (typeof url === "string") return url;
      if (url instanceof URL) return url.href;
      return (url as Request).url;
    })
    .filter((u): u is string => typeof u === "string" && u.includes("/dkg/"));
}

/** Count fetch calls whose URL contains the given path substring. */
export function countFetchCallsTo(
  spy: ReturnType<typeof vi.spyOn>,
  path: string,
): number {
  return dkgFetchUrls(spy).filter((u) => u.includes(path)).length;
}
