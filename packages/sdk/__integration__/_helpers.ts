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
 * Creation bytecode for a minimal always-true condition contract that
 * implements the deployed CDR condition ABI:
 *   - checkWriteCondition(uint32,bytes,bytes,address)
 *   - checkReadCondition(uint32,bytes,bytes,address)
 *
 * Unknown selectors revert with empty data so the SDK's sentinel preflight
 * can distinguish this from a catch-all fallback.
 */
export const OPEN_CONDITION_BYTECODE =
  "0x602a600c600039602a6000f360003560e01c80635645dbbf14601f5780638db3eb1714601f5760006000fd5b600160005260206000f3" as `0x${string}`;

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
  /**
   * Per-wallet failure reasons, capped at 10 entries to keep the JSON
   * small. The workflow summary renders these as a table so a reviewer
   * can see why N of M wallets failed without clicking into the raw
   * vitest stack — the assertion `expect(failed.length).toBe(0)` alone
   * tells you the count but not the cause.
   */
  failedReasons: Array<{ idx: number; reason: string }> | null;
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

// Flat per-wallet fund constants.
//
// The previous formula scaled with cyclesPerWallet + per-suite cost shape
// (upload-vs-access-vs-cycle). Two problems with that:
//   1. `uploadFeeCost` included `baseFee` — but baseFee is paid by
//      validators when they submit partial decryptions, not by the user.
//      User-side `uploadCDR` only requires `allocateFee + writeFee`. The
//      old formula over-funded by `baseFee × cycles × 3` on every suite.
//   2. Sizing was so tight that a single fee bump on aeneid (0.01 → 0.03 IP)
//      tipped 100/100 wallets into insufficient-funds failures.
//
// New formula: every ephemeral suite gets the same fund regardless of
// cycles-per-wallet or which contract paths it exercises:
//
//   perWalletFund = BASE_GAS_BUDGET + (writeFee + allocateFee + readFee) × FUND_SAFETY_MULTIPLIER
//
// 1 IP base covers per-tx gas for any reasonable workload; ×3 of the
// user-side per-cycle fees absorbs fee bumps mid-run.
const BASE_GAS_BUDGET_WEI = 1_000_000_000_000_000_000n; // 1 IP
const FUND_SAFETY_MULTIPLIER = 3n;

/**
 * Required `payable` value for one user-side (allocate + write + read)
 * cycle, EXCLUDING gas and EXCLUDING the validator-paid `baseFee`.
 * Mirrors `require(msg.value == ...)` on each user-facing CDR path.
 */
function userPerCycleFee(fees: CDRFees): bigint {
  return fees.writeFee + fees.allocateFee + fees.readFee;
}

/**
 * Per-wallet fund used by every ephemeral suite. Flat formula:
 *   1 IP base + 3 × (writeFee + allocateFee + readFee)
 *
 * Independent of the suite's cycles-per-wallet count and which
 * contract paths it exercises — uniform funding keeps the test surface
 * predictable and tolerates fee bumps mid-run.
 */
function computePerWalletFund(fees: CDRFees): bigint {
  return BASE_GAS_BUDGET_WEI + userPerCycleFee(fees) * FUND_SAFETY_MULTIPLIER;
}

/**
 * Per-suite fee snapshot written to `/tmp/fee-stats-{label}.json` at the
 * end of each ephemeral suite setup. The integration workflow's summary
 * step globs these files and renders one table row per file in the Step
 * Summary, surfacing live fee values + gas price + actual per-wallet
 * fund used alongside the perf table.
 *
 * `base_fee_wei` is the validator-paid `baseFee` — it does NOT feed into
 * `per_wallet_fund_wei`. It is recorded here for ops visibility (if
 * baseFee is 0 the chain's evmengine handler silently drops every
 * partial submission — see piplabs/story client/x/evmengine/keeper/cdr.go).
 */
interface FeeStatsFile {
  label: string;
  network: string;
  base_fee_wei: string;
  write_fee_wei: string;
  read_fee_wei: string;
  allocate_fee_wei: string;
  gas_price_wei: string;
  user_per_cycle_fee_wei: string;
  /**
   * "formula" → per_wallet_fund_wei = base_gas_budget_wei + safety_multiplier × user_per_cycle_fee_wei.
   * "override" → per_wallet_fund_wei is a caller-provided flat value; safety_multiplier /
   *               base_gas_budget_wei are recorded as 0 and the workflow summary renders "—"
   *               in those cells. Used by suites whose per-wallet cost is dominated by
   *               cycle count rather than per-cycle fee (e.g. the 60-min stress suite which
   *               runs ~150 cycles/wallet on devnet — vastly exceeding any flat-formula budget).
   */
  fund_source: "formula" | "override";
  safety_multiplier: number;
  base_gas_budget_wei: string;
  per_wallet_fund_wei: string;
}

function writeFeeStats(file: FeeStatsFile): void {
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

/**
 * Suite-side convenience wrapper: query live fees + live gas price,
 * compute per-wallet fund via the flat formula (or accept a caller-provided
 * override), persist the fee-stats snapshot for the workflow summary, and
 * return the fund.
 *
 *   // formula path (default — short suites doing ≤ a few cycles per wallet)
 *   const perWalletFund = await sizeFundAndReport({
 *     label: "100w-fresh-aeneid",
 *     network: NETWORK,
 *     publicClient: funderPublic,
 *   });
 *
 *   // override path — suites whose per-wallet cost is dominated by
 *   // cycle count rather than per-cycle fee (e.g. 60-min stress runs
 *   // ~150 cycles/wallet, which the flat 1 IP base cannot cover).
 *   const perWalletFund = await sizeFundAndReport({
 *     label: "60min-stress",
 *     network: NETWORK,
 *     publicClient: funderPublic,
 *     overrideFundWei: parseEther("100"),
 *   });
 *
 * Even on the override path we still query live fees + gas price so the
 * workflow summary table has a row for every suite that runs, with the
 * same set of contextual columns. Unused balance is swept back via
 * `refundWallets` at the end of each suite — over-funding the override
 * value is cheap, exhausting it mid-run isn't.
 *
 * `baseFee` is not part of funding (validator-paid) but is recorded in
 * the fee-stats JSON for ops visibility. `gas_price_wei` is queried live
 * off the funder's public client so the workflow summary can surface it
 * next to fee values (gas-price spikes are the most common cause of
 * insufficient-funds at the read step on aeneid).
 */
export async function sizeFundAndReport(opts: {
  label: string;
  network: string;
  publicClient: PublicClient;
  contractNetwork?: Network;
  /**
   * When set, bypass the flat formula and use this exact value as the
   * per-wallet fund. Caller is responsible for picking a value that
   * comfortably covers their suite's per-wallet cost; `refundWallets`
   * sweeps any unused balance back to the funder at teardown.
   */
  overrideFundWei?: bigint;
}): Promise<bigint> {
  const [fees, gasPriceWei] = await Promise.all([
    queryCDRFees(opts.publicClient, opts.contractNetwork ?? "testnet"),
    opts.publicClient.getGasPrice(),
  ]);
  const userCycleFeeWei = userPerCycleFee(fees);
  const formulaFundWei = computePerWalletFund(fees);
  const isOverride = opts.overrideFundWei !== undefined;
  const perWalletFund = opts.overrideFundWei ?? formulaFundWei;
  const fundShape = isOverride
    ? { fund_source: "override" as const, safety_multiplier: 0, base_gas_budget_wei: "0" }
    : {
        fund_source: "formula" as const,
        safety_multiplier: Number(FUND_SAFETY_MULTIPLIER),
        base_gas_budget_wei: BASE_GAS_BUDGET_WEI.toString(),
      };
  writeFeeStats({
    label: opts.label,
    network: opts.network,
    base_fee_wei: fees.baseFee.toString(),
    write_fee_wei: fees.writeFee.toString(),
    read_fee_wei: fees.readFee.toString(),
    allocate_fee_wei: fees.allocateFee.toString(),
    gas_price_wei: gasPriceWei.toString(),
    user_per_cycle_fee_wei: userCycleFeeWei.toString(),
    ...fundShape,
    per_wallet_fund_wei: perWalletFund.toString(),
  });
  // eslint-disable-next-line no-console
  console.log(
    `[fee-sizing][${opts.label}] base=${fees.baseFee} write=${fees.writeFee} ` +
      `read=${fees.readFee} allocate=${fees.allocateFee} gasPrice=${gasPriceWei} ` +
      `userPerCycle=${userCycleFeeWei} perWalletFund=${perWalletFund} ` +
      `source=${fundShape.fund_source}` +
      (isOverride ? ` (formula would give ${formulaFundWei})` : ""),
  );
  return perWalletFund;
}
