/**
 * Test-suite + network gating for the CDR SDK integration workflow.
 *
 * The workflow dispatches with one of:
 *   default                   — basic integration + 100-wallet ephemeral tests
 *   all                       — everything including 1000w perf + 60min stress
 *   1000-wallet-performance-devnet-only   — only the 1000-wallet perf suite
 *   1H-stress-devnet-only     — only the 60-min combined stress (DevNet only)
 *
 * Test files gate their `describe` block via:
 *   describe.skipIf(skipUnlessSuite("1000-wallet-performance-devnet-only"))(...)
 *
 * `all` always runs every gated suite.
 */

export type TestSuite =
  | "default"
  | "all"
  | "1000-wallet-performance-devnet-only"
  | "1H-stress-devnet-only";

export type Network = "devnet" | "aeneid";

export const TEST_SUITE: TestSuite =
  (process.env.TEST_SUITE as TestSuite | undefined) ?? "default";

export const NETWORK: Network =
  (process.env.NETWORK as Network | undefined) ?? "devnet";

/**
 * Returns `true` (= skip) when the current TEST_SUITE is not one of the
 * `allowed` suites and not `"all"`.
 */
export function skipUnlessSuite(...allowed: TestSuite[]): boolean {
  if (TEST_SUITE === "all") return false;
  return !allowed.includes(TEST_SUITE);
}

/** Returns `true` (= skip) when NETWORK is not DevNet. */
export function skipUnlessDevnet(): boolean {
  return NETWORK !== "devnet";
}
