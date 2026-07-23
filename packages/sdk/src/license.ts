import {
  decodeEventLog,
  maxUint256,
  type PublicClient,
  type WalletClient,
} from "viem";
import {
  InsufficientBalanceError,
  InvalidParamsError,
  LicenseMintPreparationError,
  LicenseTokensMintedEventNotFoundError,
  LicenseTransactionRevertedError,
  UnsupportedLicenseCurrencyError,
} from "./errors.js";
import type { TransactionReceipt } from "viem";
import {
  type CDRPublicClient,
  type CDRWalletClient,
  getWalletAddress,
} from "./client-types.js";
import { type CDRLogger, noopLogger } from "./logger.js";
import { safeWriteContract } from "./_tx-submit.js";
import { waitForReceiptResilient } from "./_rpc-resilience.js";
import {
  LICENSING_MODULE_ADDRESS,
  PI_LICENSE_TEMPLATE_ADDRESS,
  ROYALTY_MODULE_ADDRESS,
  WIP_ADDRESS,
  licensingModuleAbi,
  wipAbi,
} from "./license-contracts.js";

/**
 * 100% in the licensing module's revenue-share basis points (1% = 10^6).
 * Passed as `maxRevenueShare` = "accept any licensor revenue share" — the
 * SDK does not restrict terms on the caller's behalf.
 */
const MAX_REVENUE_SHARE_100_PCT = 100_000_000;

export interface MintLicenseTokenResult {
  /** Minted token IDs, ready to encode as `accessAuxData` for `accessCDR`. */
  licenseTokenIds: bigint[];
  /** Fee paid (in WIP wei) for the whole mint; 0n for free terms. */
  feePaid: bigint;
  /** Native DATA wrapped into WIP by this call; 0n when balance sufficed. */
  wrappedWei: bigint;
  /** Hashes of the steps that actually ran (wrap/approve are skipped when unneeded). */
  txHashes: {
    deposit?: `0x${string}`;
    approve?: `0x${string}`;
    mint: `0x${string}`;
  };
}

export interface MintLicenseTokenParams {
  /** The licensor IP asset (IP ID) to mint a license for. */
  licensorIpId: `0x${string}`;
  /** License terms ID attached to the licensor IP. */
  licenseTermsId: bigint | number;
  /** Number of license tokens to mint (default 1). */
  amount?: bigint | number;
  /** Recipient of the minted tokens (default: the wallet address). */
  receiver?: `0x${string}`;
  /** License template the terms live on (default: PILicenseTemplate). */
  licenseTemplate?: `0x${string}`;
  /**
   * Auto-wrap native DATA into WIP when the WIP balance can't cover the
   * fee (default true). When false, a shortfall throws
   * {@link LicenseMintPreparationError} instead of wrapping.
   */
  autoWrap?: boolean;
  /**
   * Auto-approve the RoyaltyModule for the fee when the current allowance
   * is short (default true; approves `maxUint256`, so subsequent mints skip
   * the approval tx). When false, a short allowance throws
   * {@link LicenseMintPreparationError}.
   */
  autoApprove?: boolean;
}

/**
 * Mints Story Protocol license tokens, handling the WIP fee end-to-end
 * (#39): predicts the minting fee on-chain, wraps the missing amount of
 * native DATA into WIP, approves the RoyaltyModule, and executes the mint —
 * so reading a `LicenseReadCondition`-gated vault needs no manual
 * `deposit`/`approve` steps and no separate Story SDK.
 *
 * Fee preparation is idempotent: steps that aren't needed (sufficient WIP,
 * standing allowance, zero-fee terms) are skipped and absent from the
 * returned `txHashes`.
 *
 * The predicted fee is passed on-chain as `maxMintingFee`, so a fee raised
 * between prediction and execution reverts the mint instead of overpaying.
 *
 * @example
 * ```ts
 * const { licenseTokenIds } = await cdr.license.mintLicenseToken({
 *   licensorIpId: "0x072D...",
 *   licenseTermsId: 2645,
 * });
 * const accessAuxData = encodeAbiParameters(
 *   [{ type: "uint256[]" }],
 *   [licenseTokenIds],
 * );
 * const { dataKey } = await cdr.consumer.accessCDR({ uuid, accessAuxData });
 * ```
 */
export class LicenseClient {
  private publicClient: CDRPublicClient;
  private walletClient: CDRWalletClient;
  private logger: CDRLogger;

  constructor(params: {
    publicClient: CDRPublicClient;
    walletClient: CDRWalletClient;
    /** Optional structured logger; defaults to a no-op. */
    logger?: CDRLogger;
  }) {
    this.publicClient = params.publicClient;
    this.walletClient = params.walletClient;
    this.logger = params.logger ?? noopLogger;
  }

  /**
   * Submit a write, wait for its receipt, and fail loudly if it reverted.
   * `waitForReceiptResilient` returns reverted receipts rather than throwing
   * (see its docs), so without this a reverted deposit/approve would cascade
   * into a misleading "mint event not found" at the end.
   */
  private async writeAndConfirm(
    step: "deposit" | "approve" | "mint",
    params: Parameters<typeof safeWriteContract>[2],
  ): Promise<{ hash: `0x${string}`; receipt: TransactionReceipt }> {
    const hash = await safeWriteContract(
      this.walletClient as unknown as WalletClient,
      this.publicClient as unknown as PublicClient,
      params,
    );
    const receipt = await waitForReceiptResilient(
      this.publicClient as unknown as PublicClient,
      hash,
    );
    if (receipt.status === "reverted") {
      throw new LicenseTransactionRevertedError(step, hash);
    }
    return { hash, receipt };
  }

  async mintLicenseToken(
    params: MintLicenseTokenParams,
  ): Promise<MintLicenseTokenResult> {
    const amount = BigInt(params.amount ?? 1);
    // Upper bound is Number.MAX_SAFE_INTEGER because the token-id expansion
    // below uses `Number(amount)`; beyond it that conversion loses precision.
    // (Any real mint is a handful of tokens — this only rejects absurd input.)
    if (amount < 1n || amount > BigInt(Number.MAX_SAFE_INTEGER)) {
      throw new InvalidParamsError(
        `mintLicenseToken: amount must be between 1 and ${Number.MAX_SAFE_INTEGER}`,
      );
    }
    const licenseTermsId = BigInt(params.licenseTermsId);
    const licenseTemplate = params.licenseTemplate ?? PI_LICENSE_TEMPLATE_ADDRESS;
    const minter = getWalletAddress(this.walletClient.account);
    if (!minter) {
      throw new InvalidParamsError(
        "mintLicenseToken: walletClient has no resolvable account address",
      );
    }
    const receiver = params.receiver ?? minter;
    const autoWrap = params.autoWrap !== false;
    const autoApprove = params.autoApprove !== false;

    // 1. Predict the fee on-chain — returns the terms' currency too, which
    // doubles as the only-WIP-supported check.
    const [currencyToken, feeWei] = (await this.publicClient.readContract({
      address: LICENSING_MODULE_ADDRESS,
      abi: licensingModuleAbi,
      functionName: "predictMintingLicenseFee",
      args: [params.licensorIpId, licenseTemplate, licenseTermsId, amount, receiver, "0x"],
    })) as [`0x${string}`, bigint];
    this.logger.debug("license.fee.predicted", {
      licensorIpId: params.licensorIpId,
      licenseTermsId: licenseTermsId.toString(),
      currencyToken,
      feeWei: feeWei.toString(),
    });

    const txHashes: MintLicenseTokenResult["txHashes"] = { mint: "0x" };
    let wrappedWei = 0n;

    if (feeWei > 0n) {
      if (currencyToken.toLowerCase() !== WIP_ADDRESS.toLowerCase()) {
        throw new UnsupportedLicenseCurrencyError(currencyToken);
      }

      // 2. Wrap the shortfall (if any) from native DATA into WIP.
      const wipBalance = (await this.publicClient.readContract({
        address: WIP_ADDRESS,
        abi: wipAbi,
        functionName: "balanceOf",
        args: [minter],
      })) as bigint;
      const shortfall = feeWei > wipBalance ? feeWei - wipBalance : 0n;
      if (shortfall > 0n) {
        if (!autoWrap) {
          throw new LicenseMintPreparationError(
            `WIP balance ${wipBalance} is short of the ${feeWei} minting fee and autoWrap is disabled — wrap ${shortfall} manually via WIP.deposit() or re-enable autoWrap`,
          );
        }
        // Native must cover the wrap; check only when the structural client
        // exposes getBalance (mirrors Consumer.read's fee preflight). When it
        // doesn't, the deposit still reverts on-chain for a true shortfall —
        // just without the typed early error, so log the skip for parity.
        if (this.publicClient.getBalance) {
          const nativeBalance = await this.publicClient.getBalance({ address: minter });
          if (nativeBalance < shortfall) {
            throw new InsufficientBalanceError(
              nativeBalance,
              shortfall,
              "license minting fee (wrapping native DATA to WIP)",
            );
          }
        } else {
          this.logger.debug("license.wrap.preflight.skipped", {
            reason: "publicClient has no getBalance",
            shortfall: shortfall.toString(),
          });
        }
        ({ hash: txHashes.deposit } = await this.writeAndConfirm("deposit", {
          address: WIP_ADDRESS,
          abi: wipAbi,
          functionName: "deposit",
          args: [],
          value: shortfall,
        }));
        wrappedWei = shortfall;
        this.logger.debug("license.wrapped", {
          wrappedWei: shortfall.toString(),
          txHash: txHashes.deposit,
        });
      }

      // 3. Ensure the RoyaltyModule allowance covers the fee.
      const allowance = (await this.publicClient.readContract({
        address: WIP_ADDRESS,
        abi: wipAbi,
        functionName: "allowance",
        args: [minter, ROYALTY_MODULE_ADDRESS],
      })) as bigint;
      if (allowance < feeWei) {
        if (!autoApprove) {
          throw new LicenseMintPreparationError(
            `WIP allowance ${allowance} for the RoyaltyModule is short of the ${feeWei} minting fee and autoApprove is disabled — approve manually or re-enable autoApprove`,
          );
        }
        ({ hash: txHashes.approve } = await this.writeAndConfirm("approve", {
          address: WIP_ADDRESS,
          abi: wipAbi,
          functionName: "approve",
          args: [ROYALTY_MODULE_ADDRESS, maxUint256],
        }));
        this.logger.debug("license.approved", {
          spender: ROYALTY_MODULE_ADDRESS,
          txHash: txHashes.approve,
        });
      }
    }

    // 4. Mint. The predicted fee doubles as maxMintingFee so a fee raised
    // after prediction reverts instead of overpaying.
    const { hash: mintHash, receipt } = await this.writeAndConfirm("mint", {
      address: LICENSING_MODULE_ADDRESS,
      abi: licensingModuleAbi,
      functionName: "mintLicenseTokens",
      args: [
        params.licensorIpId,
        licenseTemplate,
        licenseTermsId,
        amount,
        receiver,
        "0x",
        feeWei,
        MAX_REVENUE_SHARE_100_PCT,
      ],
    });
    txHashes.mint = mintHash;

    // 5. Recover the minted token IDs from the LicenseTokensMinted event.
    let startLicenseTokenId: bigint | null = null;
    for (const log of receipt.logs ?? []) {
      if (log.address.toLowerCase() !== LICENSING_MODULE_ADDRESS.toLowerCase()) continue;
      try {
        const decoded = decodeEventLog({
          abi: licensingModuleAbi,
          eventName: "LicenseTokensMinted",
          data: log.data,
          topics: log.topics,
        });
        startLicenseTokenId = decoded.args.startLicenseTokenId;
        break;
      } catch {
        // Not the LicenseTokensMinted event — keep scanning.
      }
    }
    if (startLicenseTokenId === null) {
      throw new LicenseTokensMintedEventNotFoundError();
    }
    const licenseTokenIds = Array.from(
      { length: Number(amount) },
      (_, i) => startLicenseTokenId! + BigInt(i),
    );
    this.logger.debug("license.minted", {
      licenseTokenIds: licenseTokenIds.map(String),
      feePaid: feeWei.toString(),
      txHash: txHashes.mint,
    });

    return { licenseTokenIds, feePaid: feeWei, wrappedWei, txHashes };
  }
}

/**
 * Standalone form of {@link LicenseClient.mintLicenseToken} for callers
 * without a `CDRClient` — same parameters plus the two viem clients.
 */
export async function mintLicenseToken(
  params: MintLicenseTokenParams & {
    publicClient: CDRPublicClient;
    walletClient: CDRWalletClient;
    logger?: CDRLogger;
  },
): Promise<MintLicenseTokenResult> {
  const { publicClient, walletClient, logger, ...rest } = params;
  return new LicenseClient({ publicClient, walletClient, logger }).mintLicenseToken(rest);
}
