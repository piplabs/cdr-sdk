/**
 * Shared helpers for integration suites under `__integration__/`.
 *
 * The default vitest include glob is `**\/*.{test,spec}.ts`, so this file
 * is NOT picked up as a test file — safe place to colocate test utilities
 * with the suites that use them.
 */

import { expect, vi } from "vitest";
import type { PublicClient } from "viem";
import { cdrAbi, contractAddresses, type Network } from "@piplabs/cdr-contracts";
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

export function statsOf(samples: number[]): LatencyStats | null {
  // Empty samples → null, not zero-valued stats. Returning a "0ms across
  // the board" object would let the workflow's perf-table jq (which
  // gates on `!= null`) render rows reading "0ms" for every percentile,
  // which a casual reader can misinterpret as a real (and suspiciously
  // fast) latency rather than "no data". Forcing null here makes the
  // zero-sample case skipped in the table, which is the truthful signal.
  if (samples.length === 0) {
    return null;
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
 * `accessMs` is present for suites that read a single uuid (100w-shared,
 * 100w-fresh, 1000w-perf). `uploadMs` is null for read-only suites.
 * The stress suite uses `accessSharedMs` + `accessFreshMs` instead of
 * `accessMs` to separate same-uuid vs fresh-uuid read latency in one
 * cycle. `refund` is null for suites that don't sweep wallets.
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
  /** Stress suite only: same-uuid read latency (validator cache benefit). */
  accessSharedMs: LatencyStats | null;
  /** Stress suite only: fresh-uuid read latency (no caching). */
  accessFreshMs: LatencyStats | null;
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

/**
 * The four fee getters on the CDR contract, all denominated in wei.
 * Per-tx payable composition (current contract behavior on aeneid + devnet):
 *
 *   uploadCDR.value = baseFee + writeFee + allocateFee
 *   accessCDR.value = readFee                       (NO baseFee)
 *
 * `baseFee` is only charged on the upload path. Read-only suites
 * (100w-shared, 1000w-perf) pay readFee only.
 */
export interface CDRFees {
  baseFee: bigint;
  writeFee: bigint;
  readFee: bigint;
  allocateFee: bigint;
}

/**
 * Query all four fees off the live CDR proxy at
 * `contractAddresses[network].cdr`. One RPC roundtrip per getter (4 total).
 * Each ephemeral suite calls this once at setup so the per-wallet fund
 * tracks whatever fees are live on the target chain — avoids the
 * hard-coded `parseEther("0.1")` shortfall that broke 100w-fresh-aeneid
 * once aeneid raised all four fees from 0.01 IP → 0.03 IP.
 */
export async function queryCDRFees(
  publicClient: PublicClient,
  network: Network,
): Promise<CDRFees> {
  const cdrAddress = contractAddresses[network].cdr;
  const [baseFee, writeFee, readFee, allocateFee] = await Promise.all([
    publicClient.readContract({
      address: cdrAddress,
      abi: cdrAbi,
      functionName: "baseFee",
    }) as Promise<bigint>,
    publicClient.readContract({
      address: cdrAddress,
      abi: cdrAbi,
      functionName: "writeFee",
    }) as Promise<bigint>,
    publicClient.readContract({
      address: cdrAddress,
      abi: cdrAbi,
      functionName: "readFee",
    }) as Promise<bigint>,
    publicClient.readContract({
      address: cdrAddress,
      abi: cdrAbi,
      functionName: "allocateFee",
    }) as Promise<bigint>,
  ]);
  return { baseFee, writeFee, readFee, allocateFee };
}

/**
 * Required `payable` value for one uploadCDR call, EXCLUDING gas.
 * Mirrors the contract's `require(msg.value == baseFee + writeFee +
 * allocateFee)` on the write path.
 */
export function uploadFeeCost(fees: CDRFees): bigint {
  return fees.baseFee + fees.writeFee + fees.allocateFee;
}

/**
 * Required `payable` value for one accessCDR call, EXCLUDING gas.
 * Mirrors `require(msg.value == readFee)` on the read path. `baseFee`
 * is NOT charged on access — read-only suites (100w-shared, 1000w-perf)
 * pay only this.
 */
export function accessFeeCost(fees: CDRFees): bigint {
  return fees.readFee;
}

/**
 * Required `payable` value for one (upload + access) cycle. Suites that
 * exercise both paths per wallet (100w-fresh*, 60min-stress) use this.
 */
export function cycleFeeCost(fees: CDRFees): bigint {
  return uploadFeeCost(fees) + accessFeeCost(fees);
}

/**
 * Compute per-wallet fund for an ephemeral suite. Callers pass the
 * per-cycle cost they expect (`cycleFeeCost`/`uploadFeeCost`/
 * `accessFeeCost`) so this helper stays agnostic to which contract
 * paths the suite exercises.
 *
 *   funded = perCycleWei × cyclesPerWallet × safetyMultiplier
 *          + gasReserveWei × cyclesPerWallet
 *
 * `safetyMultiplier` covers fee bumps mid-run + per-tx gas variance;
 * default 3× tracks the historical funded/needed ratio on devnet
 * (PER_WALLET_FUND=0.1 IP vs single-cycle fee cost ≈ 0.04 IP).
 * `gasReserveWei` defaults to 0.005 IP per tx, matching the same
 * conservative gas reserve used by `_ephemeral-wallets.ts::refundWallets`.
 *
 * Returns a bigint suitable for passing straight into `fundWallets`.
 */
export function computePerWalletFund(opts: {
  perCycleWei: bigint;
  cyclesPerWallet: number;
  safetyMultiplier?: number;
  gasReserveWei?: bigint;
}): bigint {
  const cycles = BigInt(opts.cyclesPerWallet);
  const multiplier = BigInt(Math.round((opts.safetyMultiplier ?? 3) * 100));
  // Multiply by safetyMultiplier × 100 then divide by 100 to keep bigint
  // math integral when callers pass a fractional multiplier like 2.5.
  const padded = (opts.perCycleWei * cycles * multiplier) / 100n;
  const gas = opts.gasReserveWei ?? 5_000_000_000_000_000n; // 0.005 IP
  return padded + gas * cycles;
}

/**
 * Per-suite fee snapshot written to `/tmp/fee-stats-{label}.json` at the
 * end of each ephemeral suite setup. The integration workflow's summary
 * step globs these files and renders one table row per file in the Step
 * Summary, surfacing live fee values + actual per-wallet fund used
 * alongside the perf table.
 */
export interface FeeStatsFile {
  label: string;
  network: string;
  baseFee_wei: string;
  writeFee_wei: string;
  readFee_wei: string;
  allocateFee_wei: string;
  /**
   * The per-cycle fee cost the suite used to compute its fund — either
   * `cycleFeeCost` (full upload+access), `uploadFeeCost`, or `accessFeeCost`
   * depending on which contract path the suite exercises.
   */
  per_cycle_wei: string;
  cycles_per_wallet: number;
  safety_multiplier: number;
  per_wallet_fund_wei: string;
}

export function writeFeeStats(file: FeeStatsFile): void {
  // Lazy fs import — see writePerfStats above for the rationale.
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const fs = require("node:fs") as typeof import("node:fs");
  const path = `/tmp/fee-stats-${file.label}.json`;
  try {
    fs.writeFileSync(path, JSON.stringify(file, null, 2));
    // eslint-disable-next-line no-console
    console.log(`[fee-stats] wrote ${path}`);
  } catch (e) {
    // eslint-disable-next-line no-console
    console.warn(`[fee-stats] failed to write ${path}: ${(e as Error).message}`);
  }
}
