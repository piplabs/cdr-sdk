/**
 * Ephemeral-wallet lifecycle helpers shared by the 100w / 1000w / stress suites.
 *
 * Flow:
 *   1. generateEphemeralWallets(N)              — fresh viem accounts in memory
 *   2. fundWallets(funder, wallets, perWalletWei)
 *      - On first call per chain, ensures a Multicall3 instance exists
 *        (canonical 0xcA11... if deployed, else deploys a fresh one and
 *        caches the address for the rest of the test session).
 *      - Sends a single tx that batch-distributes perWalletWei to every
 *        ephemeral wallet via Multicall3.aggregate3Value.
 *   3. (run workload — each wallet uses its own viem WalletClient)
 *   4. refundWallets(wallets, recipient, rpcUrl)
 *      - Each ephemeral wallet sweeps its remaining balance (minus a small
 *        gas reserve) back to the recipient, concurrently.
 *
 * Net cost per session = sum of gas fees + write fees + the gas reserve
 * left in each wallet at refund time. The summary printed by the test
 * (see _format.ts) reports this delta explicitly.
 */

import {
  type Address,
  type Chain,
  type Hex,
  type PublicClient,
  type Transport,
  type WalletClient,
  createWalletClient,
  http,
} from "viem";
import {
  generatePrivateKey,
  privateKeyToAccount,
  type PrivateKeyAccount,
} from "viem/accounts";
import {
  CANONICAL_MULTICALL3_ADDR,
  MULTICALL3_ABI,
  buildMulticall3CreationBytecode,
} from "./_multicall3-artifact.js";
import { waitForReceiptResilient } from "./_rpc-resilience.js";

export interface EphemeralWallet {
  privateKey: Hex;
  account: PrivateKeyAccount;
  address: Address;
}

/** Generate N fresh secp256k1 keypairs, in memory only — never persisted. */
export function generateEphemeralWallets(count: number): EphemeralWallet[] {
  return Array.from({ length: count }, () => {
    const privateKey = generatePrivateKey();
    const account = privateKeyToAccount(privateKey);
    return { privateKey, account, address: account.address };
  });
}

// Per-chain cache: ChainID → deployed Multicall3 address. Lives for the
// test process's lifetime. After a DevNet reset the cache is irrelevant
// (process restarts too), so we re-check / re-deploy.
const multicall3Cache = new Map<number, Address>();

/**
 * Return a usable Multicall3 address on this chain:
 *  1. Canonical 0xcA11... if `eth_getCode` shows non-empty bytecode there.
 *  2. Otherwise deploy a fresh instance and cache the result.
 */
export async function ensureMulticall3(
  publicClient: PublicClient,
  walletClient: WalletClient,
): Promise<Address> {
  const chainId = await publicClient.getChainId();
  const cached = multicall3Cache.get(chainId);
  if (cached) return cached;

  const canonicalCode = await publicClient.getCode({
    address: CANONICAL_MULTICALL3_ADDR,
  });
  if (canonicalCode && canonicalCode.length > 2) {
    multicall3Cache.set(chainId, CANONICAL_MULTICALL3_ADDR);
    return CANONICAL_MULTICALL3_ADDR;
  }

  const account = walletClient.account;
  if (!account) {
    throw new Error(
      "ensureMulticall3: walletClient.account is required to deploy a fresh Multicall3",
    );
  }

  const hash = await walletClient.sendTransaction({
    account,
    chain: walletClient.chain as Chain,
    to: null,
    data: buildMulticall3CreationBytecode(),
  });
  const receipt = await waitForReceiptResilient(publicClient, hash);
  if (!receipt.contractAddress) {
    throw new Error(
      `ensureMulticall3: deployment receipt missing contractAddress (tx ${hash})`,
    );
  }
  multicall3Cache.set(chainId, receipt.contractAddress);
  return receipt.contractAddress;
}

export interface FundResult {
  /** Multicall3 instance used for the batch send. */
  multicall3Address: Address;
  /** Total wei sent across all N wallets (= perWalletWei × N). */
  totalFundedWei: bigint;
  /** Tx hash of the single batched funding call. */
  txHash: Hex;
}

/**
 * Fund every ephemeral wallet with `perWalletWei` in a single Multicall3 tx.
 * Reverts whole batch if any individual call fails (`allowFailure: false`).
 */
export async function fundWallets(
  publicClient: PublicClient,
  walletClient: WalletClient,
  wallets: EphemeralWallet[],
  perWalletWei: bigint,
): Promise<FundResult> {
  if (wallets.length === 0) {
    throw new Error("fundWallets: no wallets supplied");
  }
  const account = walletClient.account;
  if (!account) {
    throw new Error("fundWallets: walletClient.account is required");
  }

  const multicall3Address = await ensureMulticall3(publicClient, walletClient);

  const calls = wallets.map((w) => ({
    target: w.address,
    allowFailure: false,
    value: perWalletWei,
    callData: "0x" as Hex,
  }));
  const totalFundedWei = perWalletWei * BigInt(wallets.length);

  const txHash = await walletClient.writeContract({
    account,
    chain: walletClient.chain as Chain,
    address: multicall3Address,
    abi: MULTICALL3_ABI,
    functionName: "aggregate3Value",
    args: [calls],
    value: totalFundedWei,
  });
  await waitForReceiptResilient(publicClient, txHash);

  return { multicall3Address, totalFundedWei, txHash };
}

export interface RefundResult {
  /** Sum of all per-wallet refunds successfully swept back to recipient. */
  totalRefundedWei: bigint;
  /** Per-wallet refund amount, parallel index to the input `wallets`. 0 = nothing swept. */
  perWalletRefundWei: bigint[];
  /** Wallets whose refund tx failed (network/nonce/etc.) — informational. */
  failedRefunds: number;
}

/**
 * Sweep every ephemeral wallet's remaining balance back to `recipient`,
 * minus a per-tx gas reserve. Per-wallet refunds run concurrently —
 * order-independent.
 *
 * `gasReserveWei` defaults to `undefined`; in that case the reserve is
 * computed once at entry from the live fee market:
 *
 *   reserve = 21000 × maxFeePerGas × 1.5
 *
 * `maxFeePerGas` here is `estimateFeesPerGas` — but viem's
 * `prepareTransactionRequest` pads that by another **1.2×** (the default
 * `baseFeeMultiplier`) when actually building the tx, so the true
 * worst-case gas cost is `21000 × estimateFeesPerGas × 1.2`. The 1.5×
 * multiplier covers the 1.2× prep padding (25% headroom over that) plus
 * any fee spike between this probe and the sweep tx.
 *
 * The previous fixed default `parseEther("0.001")` (≈ 21000 × 50 gwei)
 * was just under the prep-padded cost on aeneid — 21000 × 1.2 × 42.71
 * gwei ≈ 0.00108 IP > 0.001 IP — so every sweep tx was rejected by viem
 * with "insufficient funds for gas * price + value", surfaced as
 * `failedRefunds: <wallet_count>` in cdr-sdk runs 26501253421 and
 * 26561212732 on `100w-fresh-aeneid` + `100w-shared` (~200 IP stranded
 * per run across the two suites' ephemeral wallets). On a directly-
 * connected DevNet at 10 gwei the static default worked fine; dynamic
 * sizing makes the helper safe across chains regardless of gas market.
 *
 * On any individual sweep failure the helper does NOT throw; it counts
 * the failure and continues. The reasoning: a single ephemeral wallet
 * being un-refundable (e.g. it ran out of gas mid-workload, or its
 * nonce is wedged) should not mask the test's primary outcome.
 *
 * `transportFactory` defaults to viem's bare `http`; on rate-limited
 * public endpoints (e.g. Aeneid) callers may pass `resilientHttp` so
 * a 429 storm during the refund pass doesn't silently inflate the
 * `failedRefunds` count (which would in turn overstate the cost-model
 * `burned_wei` derived from refund totals). DevNet callers omit the
 * arg and behavior is byte-identical to the pre-arg version.
 */
export async function refundWallets(
  publicClient: PublicClient,
  wallets: EphemeralWallet[],
  recipient: Address,
  rpcUrl: string,
  gasReserveWei?: bigint,
  transportFactory: (url: string) => Transport = http,
): Promise<RefundResult> {
  const chain = publicClient.chain as Chain;

  let effectiveReserveWei: bigint;
  if (gasReserveWei !== undefined) {
    effectiveReserveWei = gasReserveWei;
  } else {
    const fees = await publicClient.estimateFeesPerGas();
    // 21000 (sweep tx gas) × maxFeePerGas × 1.5 — see header comment for the
    // 1.5× rationale (covers viem's 1.2× baseFeeMultiplier prep padding +
    // ~25% spike headroom).
    effectiveReserveWei = (21_000n * fees.maxFeePerGas * 3n) / 2n;
  }

  const perWalletRefundWei = await Promise.all(
    wallets.map(async (w) => {
      try {
        const balance = await publicClient.getBalance({ address: w.address });
        if (balance <= effectiveReserveWei) return 0n;

        const sweepAmount = balance - effectiveReserveWei;
        const wc = createWalletClient({
          account: w.account,
          chain,
          transport: transportFactory(rpcUrl),
        });
        const hash = await wc.sendTransaction({
          to: recipient,
          value: sweepAmount,
          gas: 21_000n,
        });
        await waitForReceiptResilient(publicClient, hash);
        return sweepAmount;
      } catch (err) {
        // eslint-disable-next-line no-console
        const e = err as { shortMessage?: string; message?: string };
        console.warn(`[refundWallets][${w.address}] sweep failed: ${e.shortMessage ?? e.message ?? String(err)}`);
        return -1n; // sentinel for failed sweep
      }
    }),
  );

  const failedRefunds = perWalletRefundWei.filter((v) => v === -1n).length;
  const totalRefundedWei = perWalletRefundWei
    .filter((v) => v > 0n)
    .reduce((a, b) => a + b, 0n);
  const cleaned = perWalletRefundWei.map((v) => (v === -1n ? 0n : v));

  return { totalRefundedWei, perWalletRefundWei: cleaned, failedRefunds };
}
