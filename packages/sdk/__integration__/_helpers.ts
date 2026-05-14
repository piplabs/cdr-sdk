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

/**
 * Numeric statistics for the perf / stress / 100w suites.
 *
 * Quantile uses the "nearest-rank" method (no interpolation) so the
 * returned value is always an actual sample from the input — easier to
 * cross-check against the raw timing log.
 */
export function quantile(values: number[], p: number): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const idx = Math.min(
    Math.max(0, Math.ceil((p / 100) * sorted.length) - 1),
    sorted.length - 1,
  );
  return sorted[idx];
}

export const p50 = (v: number[]): number => quantile(v, 50);
export const p95 = (v: number[]): number => quantile(v, 95);
export const p99 = (v: number[]): number => quantile(v, 99);

export function mean(values: number[]): number {
  if (values.length === 0) return 0;
  return values.reduce((a, b) => a + b, 0) / values.length;
}

export function max(values: number[]): number {
  if (values.length === 0) return 0;
  return values.reduce((a, b) => (a > b ? a : b));
}

/** Format milliseconds as a short human-readable string (e.g. `12.3s`, `850ms`). */
export function formatMs(ms: number): string {
  if (ms < 1000) return `${ms.toFixed(0)}ms`;
  return `${(ms / 1000).toFixed(2)}s`;
}

/**
 * Statistical summary of a latency sample, in milliseconds. All percentiles
 * use the nearest-rank method (no interpolation) — same as `quantile()` above
 * so values cross-check against the raw sample log cleanly.
 */
export interface LatencyStats {
  count: number;
  min_ms: number;
  p50_ms: number;
  mean_ms: number;
  p95_ms: number;
  p99_ms: number;
  max_ms: number;
}

export function statsOf(samples: number[]): LatencyStats {
  if (samples.length === 0) {
    return { count: 0, min_ms: 0, p50_ms: 0, mean_ms: 0, p95_ms: 0, p99_ms: 0, max_ms: 0 };
  }
  const sorted = [...samples].sort((a, b) => a - b);
  return {
    count: sorted.length,
    min_ms: Math.round(sorted[0]),
    p50_ms: Math.round(p50(sorted)),
    mean_ms: Math.round(mean(sorted)),
    p95_ms: Math.round(p95(sorted)),
    p99_ms: Math.round(p99(sorted)),
    max_ms: Math.round(sorted[sorted.length - 1]),
  };
}

/**
 * Per-suite perf stats written to `/tmp/perf-stats-{label}.json` at the end
 * of each ephemeral suite. The integration workflow's summary step globs
 * these files and renders one table row per file in the Step Summary, so
 * a single CI run lists every suite's latency distribution side by side.
 *
 * `accessMs` is always present; `uploadMs` is null for read-only suites
 * (e.g. 100w-shared, 1000w-perf). `refund` is null for suites that don't
 * sweep wallets (none today, but reserved).
 */
export interface PerfStatsFile {
  label: string;
  network: string;
  wallets: number;
  fulfilled: number;
  failed: number;
  wall_clock_ms: number;
  accessMs: LatencyStats | null;
  uploadMs: LatencyStats | null;
  tickMs: LatencyStats | null;
  refund: {
    funded_wei: string;
    refunded_wei: string;
    burned_wei: string;
    failed_sweeps: number;
  } | null;
  /** Optional: stress-style derived counters that don't fit the per-wallet model. */
  extra: Record<string, number | string> | null;
}

/**
 * Persist a perf-stats summary to disk for the workflow to pick up.
 *
 * Writes synchronously with `fs.writeFileSync` — the test typically calls
 * this from `afterAll`, where async I/O is fine but `writeFileSync` is
 * simpler and matches the existing `/tmp/cdr-stress.log` pattern. Failing
 * to write is logged but never thrown (a write failure shouldn't fail
 * the actual test).
 */
export function writePerfStats(file: PerfStatsFile): void {
  // `fs` is intentionally imported lazily so this module stays browser-
  // safe (the unit tests under packages/sdk/src/__tests__ run in jsdom).
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const fs = require("node:fs") as typeof import("node:fs");
  const path = `/tmp/perf-stats-${file.label}.json`;
  try {
    fs.writeFileSync(path, JSON.stringify(file, null, 2));
    // eslint-disable-next-line no-console
    console.log(`[perf-stats] wrote ${path}`);
  } catch (e) {
    // eslint-disable-next-line no-console
    console.warn(`[perf-stats] failed to write ${path}: ${(e as Error).message}`);
  }
}
