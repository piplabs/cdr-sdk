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
  type WalletClient,
  createWalletClient,
  http,
  parseEther,
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
  const receipt = await publicClient.waitForTransactionReceipt({ hash });
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
  await publicClient.waitForTransactionReceipt({ hash: txHash });

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
 * minus `gasReserveWei` per wallet (covers the sweep tx's own gas).
 * Per-wallet refunds run concurrently — order-independent.
 *
 * On any individual sweep failure the helper does NOT throw; it counts
 * the failure and continues. The reasoning: a single ephemeral wallet
 * being un-refundable (e.g. it ran out of gas mid-workload, or its
 * nonce is wedged) should not mask the test's primary outcome.
 */
export async function refundWallets(
  publicClient: PublicClient,
  wallets: EphemeralWallet[],
  recipient: Address,
  rpcUrl: string,
  gasReserveWei: bigint = parseEther("0.001"),
): Promise<RefundResult> {
  const chain = publicClient.chain as Chain;

  const perWalletRefundWei = await Promise.all(
    wallets.map(async (w) => {
      try {
        const balance = await publicClient.getBalance({ address: w.address });
        if (balance <= gasReserveWei) return 0n;

        const sweepAmount = balance - gasReserveWei;
        const wc = createWalletClient({
          account: w.account,
          chain,
          transport: http(rpcUrl),
        });
        const hash = await wc.sendTransaction({
          to: recipient,
          value: sweepAmount,
          gas: 21_000n,
        });
        await publicClient.waitForTransactionReceipt({ hash });
        return sweepAmount;
      } catch {
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
