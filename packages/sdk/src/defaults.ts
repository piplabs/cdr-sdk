import type { Network } from "@piplabs/cdr-contracts";

/**
 * Per-network defaults for SDK constructor options.
 *
 * Constants live here so Consumer and Observer share a single source of
 * truth and SDK consumers can override per-instance via constructor
 * options. Resolution order: explicit constructor arg > network default
 * (from these tables).
 */

/**
 * Default lookback window when scanning DKG `Registered` / `Finalized`
 * events on long-running chains. Tuned to ~7 days of block production
 * at ~2 s/block (302_400 blocks). One full DKG cycle on Story is
 * 241_920 blocks (4 phases × 34_560 / 34_560 / 34_560 / 138_240); a
 * 7-day window safely covers >1 full active phase plus buffer.
 *
 * Both networks currently share the same value because both target
 * Story chains running the same x/dkg cadence. Forks or private
 * deployments with different block time / DKG params should override
 * via the `lookbackBlocks` constructor option rather than editing
 * this table.
 */
export const DEFAULT_LOOKBACK_BLOCKS_BY_NETWORK: Record<Network, bigint> = {
  mainnet: 302_400n,
  testnet: 302_400n,
};

export function resolveLookbackBlocks(
  network: Network,
  override?: bigint,
): bigint {
  return override ?? DEFAULT_LOOKBACK_BLOCKS_BY_NETWORK[network];
}
