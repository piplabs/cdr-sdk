import { describe, it, expect, vi, beforeEach } from "vitest";
import { encodeEventTopics, encodeAbiParameters, getAddress, maxUint256 } from "viem";
import { LicenseClient, mintLicenseToken } from "../src/license.js";
import {
  LICENSING_MODULE_ADDRESS,
  PI_LICENSE_TEMPLATE_ADDRESS,
  ROYALTY_MODULE_ADDRESS,
  WIP_ADDRESS,
  licensingModuleAbi,
  wipAbi,
} from "../src/license-contracts.js";
import {
  InsufficientBalanceError,
  InvalidParamsError,
  LicenseMintPreparationError,
  LicenseTokensMintedEventNotFoundError,
  LicenseTransactionRevertedError,
  UnsupportedLicenseCurrencyError,
  WalletClientRequiredError,
} from "../src/errors.js";
import { CDRClient } from "../src/client.js";
import { makeWalletMock, decodeWriteCalls } from "./_write-contract-mock.js";

const MINTER = "0xaaaa000000000000000000000000000000000001" as `0x${string}`;
const LICENSOR = "0x072d000000000000000000000000000000000001" as `0x${string}`;
const OTHER_TOKEN = "0x9999000000000000000000000000000000009999" as `0x${string}`;
const COMBINED_ABI = [...wipAbi, ...licensingModuleAbi];

function makeMintLog(opts: {
  startId: bigint;
  amount?: bigint;
  receiver?: `0x${string}`;
}) {
  const topics = encodeEventTopics({
    abi: licensingModuleAbi,
    eventName: "LicenseTokensMinted",
    args: { caller: MINTER, licensorIpId: LICENSOR, licenseTermsId: 2645n },
  });
  const data = encodeAbiParameters(
    [
      { type: "address" },
      { type: "uint256" },
      { type: "address" },
      { type: "uint256" },
    ],
    [
      PI_LICENSE_TEMPLATE_ADDRESS,
      opts.amount ?? 1n,
      opts.receiver ?? MINTER,
      opts.startId,
    ],
  );
  return { address: LICENSING_MODULE_ADDRESS, topics, data };
}

function makeClients(opts: {
  fee?: bigint;
  currency?: `0x${string}`;
  wipBalance?: bigint;
  allowance?: bigint;
  nativeBalance?: bigint;
  receiptLogs?: ReturnType<typeof makeMintLog>[];
  /** Status for every receipt (default "success"). Use to simulate a revert. */
  receiptStatus?: "success" | "reverted";
} = {}) {
  const readContract = vi.fn().mockImplementation((args: unknown) => {
    const a = args as { functionName?: string };
    switch (a.functionName) {
      case "predictMintingLicenseFee":
        return Promise.resolve([opts.currency ?? WIP_ADDRESS, opts.fee ?? 0n]);
      case "balanceOf":
        return Promise.resolve(opts.wipBalance ?? 0n);
      case "allowance":
        return Promise.resolve(opts.allowance ?? 0n);
    }
    return Promise.resolve(undefined);
  });
  const publicClient = {
    readContract,
    getBalance: vi.fn().mockResolvedValue(opts.nativeBalance ?? 10n ** 18n),
    waitForTransactionReceipt: vi.fn().mockResolvedValue({
      status: opts.receiptStatus ?? "success",
      logs: opts.receiptLogs ?? [makeMintLog({ startId: 100n })],
    }),
  };
  const walletClient = { ...makeWalletMock(), chain: { id: 1315 } };
  // Full-length address: license writes ABI-encode the minter/receiver, which
  // viem validates (unlike the CDR write paths the shared mock default serves).
  (walletClient as any).account = { address: MINTER, type: "local" };
  walletClient.sendRawTransaction.mockResolvedValue("0xtxhash" as `0x${string}`);
  const license = new LicenseClient({
    publicClient: publicClient as any,
    walletClient: walletClient as any,
  });
  return { license, publicClient, walletClient };
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("LicenseClient.mintLicenseToken", () => {
  it("free terms: mints with no wrap/approve and parses the token id", async () => {
    const { license, walletClient } = makeClients({ fee: 0n });
    const result = await license.mintLicenseToken({
      licensorIpId: LICENSOR,
      licenseTermsId: 2645,
    });
    expect(result.licenseTokenIds).toEqual([100n]);
    expect(result.feePaid).toBe(0n);
    expect(result.wrappedWei).toBe(0n);
    expect(result.txHashes.deposit).toBeUndefined();
    expect(result.txHashes.approve).toBeUndefined();
    const writes = decodeWriteCalls(walletClient, COMBINED_ABI as any);
    expect(writes).toHaveLength(1);
    expect(writes[0].functionName).toBe("mintLicenseTokens");
  });

  it("sufficient WIP + standing allowance: mint is the only transaction", async () => {
    const { license, walletClient } = makeClients({
      fee: 10n,
      wipBalance: 50n,
      allowance: maxUint256,
    });
    const result = await license.mintLicenseToken({
      licensorIpId: LICENSOR,
      licenseTermsId: 2645,
    });
    expect(result.wrappedWei).toBe(0n);
    expect(result.txHashes.deposit).toBeUndefined();
    expect(result.txHashes.approve).toBeUndefined();
    expect(decodeWriteCalls(walletClient, COMBINED_ABI as any)).toHaveLength(1);
  });

  it("short allowance: approves the RoyaltyModule for maxUint256 before minting", async () => {
    const { license, walletClient } = makeClients({
      fee: 10n,
      wipBalance: 50n,
      allowance: 0n,
    });
    const result = await license.mintLicenseToken({
      licensorIpId: LICENSOR,
      licenseTermsId: 2645,
    });
    expect(result.txHashes.approve).toBeDefined();
    const writes = decodeWriteCalls(walletClient, COMBINED_ABI as any);
    expect(writes.map((w) => w.functionName)).toEqual(["approve", "mintLicenseTokens"]);
    expect(writes[0].args).toEqual([ROYALTY_MODULE_ADDRESS, maxUint256]);
    expect(writes[0].address).toBe(WIP_ADDRESS);
  });

  it("WIP shortfall: wraps exactly the missing amount, then approves and mints", async () => {
    const { license, walletClient } = makeClients({
      fee: 10n,
      wipBalance: 4n,
      allowance: 0n,
    });
    const result = await license.mintLicenseToken({
      licensorIpId: LICENSOR,
      licenseTermsId: 2645,
    });
    expect(result.wrappedWei).toBe(6n);
    const writes = decodeWriteCalls(walletClient, COMBINED_ABI as any);
    expect(writes.map((w) => w.functionName)).toEqual([
      "deposit",
      "approve",
      "mintLicenseTokens",
    ]);
    expect(writes[0].address).toBe(WIP_ADDRESS);
    expect(writes[0].value).toBe(6n);
  });

  it("insufficient native for the wrap: throws InsufficientBalanceError before any tx", async () => {
    const { license, walletClient } = makeClients({
      fee: 10n,
      wipBalance: 0n,
      nativeBalance: 5n,
    });
    await expect(
      license.mintLicenseToken({ licensorIpId: LICENSOR, licenseTermsId: 2645 }),
    ).rejects.toThrow(InsufficientBalanceError);
    expect(walletClient.prepareTransactionRequest).not.toHaveBeenCalled();
  });

  it("rejects amount < 1 and amount beyond MAX_SAFE_INTEGER", async () => {
    const { license } = makeClients({ fee: 0n });
    await expect(
      license.mintLicenseToken({ licensorIpId: LICENSOR, licenseTermsId: 2645, amount: 0 }),
    ).rejects.toThrow(InvalidParamsError);
    await expect(
      license.mintLicenseToken({
        licensorIpId: LICENSOR,
        licenseTermsId: 2645,
        amount: BigInt(Number.MAX_SAFE_INTEGER) + 1n,
      }),
    ).rejects.toThrow(InvalidParamsError);
  });

  it("missing getBalance: skips the native preflight and proceeds to wrap", async () => {
    const { license, publicClient, walletClient } = makeClients({
      fee: 10n,
      wipBalance: 0n,
    });
    // Structural client without getBalance — the typed preflight is skipped.
    delete (publicClient as any).getBalance;
    const result = await license.mintLicenseToken({
      licensorIpId: LICENSOR,
      licenseTermsId: 2645,
    });
    expect(result.wrappedWei).toBe(10n);
    expect(result.txHashes.deposit).toBeDefined();
    expect(walletClient.prepareTransactionRequest).toHaveBeenCalled();
  });

  it("non-WIP fee currency: throws UnsupportedLicenseCurrencyError", async () => {
    const { license } = makeClients({ fee: 10n, currency: OTHER_TOKEN });
    await expect(
      license.mintLicenseToken({ licensorIpId: LICENSOR, licenseTermsId: 2645 }),
    ).rejects.toThrow(UnsupportedLicenseCurrencyError);
  });

  it("autoWrap:false with shortfall: throws LicenseMintPreparationError", async () => {
    const { license } = makeClients({ fee: 10n, wipBalance: 0n });
    await expect(
      license.mintLicenseToken({
        licensorIpId: LICENSOR,
        licenseTermsId: 2645,
        autoWrap: false,
      }),
    ).rejects.toThrow(LicenseMintPreparationError);
  });

  it("autoApprove:false with short allowance: throws LicenseMintPreparationError", async () => {
    const { license } = makeClients({ fee: 10n, wipBalance: 50n, allowance: 0n });
    await expect(
      license.mintLicenseToken({
        licensorIpId: LICENSOR,
        licenseTermsId: 2645,
        autoApprove: false,
      }),
    ).rejects.toThrow(LicenseMintPreparationError);
  });

  it("amount > 1: returns sequential ids and passes the predicted fee as maxMintingFee", async () => {
    const { license, walletClient } = makeClients({
      fee: 30n,
      wipBalance: 50n,
      allowance: maxUint256,
      receiptLogs: [makeMintLog({ startId: 200n, amount: 3n })],
    });
    const result = await license.mintLicenseToken({
      licensorIpId: LICENSOR,
      licenseTermsId: 2645,
      amount: 3,
    });
    expect(result.licenseTokenIds).toEqual([200n, 201n, 202n]);
    const [mint] = decodeWriteCalls(walletClient, COMBINED_ABI as any);
    expect(mint.functionName).toBe("mintLicenseTokens");
    // [licensorIpId, licenseTemplate, licenseTermsId, amount, receiver,
    //  royaltyContext, maxMintingFee, maxRevenueShare]
    // decodeFunctionData returns checksummed addresses.
    expect(mint.args).toEqual([
      getAddress(LICENSOR),
      PI_LICENSE_TEMPLATE_ADDRESS,
      2645n,
      3n,
      getAddress(MINTER),
      "0x",
      30n,
      100_000_000,
    ]);
  });

  it("receipt without the mint event: throws LicenseTokensMintedEventNotFoundError", async () => {
    const { license } = makeClients({ fee: 0n, receiptLogs: [] });
    await expect(
      license.mintLicenseToken({ licensorIpId: LICENSOR, licenseTermsId: 2645 }),
    ).rejects.toThrow(LicenseTokensMintedEventNotFoundError);
  });

  it("reverted mint tx: throws LicenseTransactionRevertedError (not event-not-found)", async () => {
    // A reverted mint emits no logs; waitForReceiptResilient returns the
    // reverted receipt without throwing, so the status check must catch it
    // rather than falling through to 'mint event not found'.
    const { license } = makeClients({
      fee: 0n,
      receiptStatus: "reverted",
      receiptLogs: [],
    });
    try {
      await license.mintLicenseToken({ licensorIpId: LICENSOR, licenseTermsId: 2645 });
      expect.fail("expected LicenseTransactionRevertedError");
    } catch (err) {
      expect(err).toBeInstanceOf(LicenseTransactionRevertedError);
      expect((err as LicenseTransactionRevertedError).step).toBe("mint");
      expect((err as LicenseTransactionRevertedError).code).toBe(
        "LICENSE_TRANSACTION_REVERTED",
      );
    }
  });

  it("reverted deposit tx: throws at the deposit step, before approve/mint", async () => {
    const { license, walletClient } = makeClients({
      fee: 10n,
      wipBalance: 0n,
      receiptStatus: "reverted",
    });
    try {
      await license.mintLicenseToken({ licensorIpId: LICENSOR, licenseTermsId: 2645 });
      expect.fail("expected LicenseTransactionRevertedError");
    } catch (err) {
      expect(err).toBeInstanceOf(LicenseTransactionRevertedError);
      expect((err as LicenseTransactionRevertedError).step).toBe("deposit");
    }
    // Only the deposit was attempted — no approve/mint after the revert.
    expect(walletClient.prepareTransactionRequest).toHaveBeenCalledTimes(1);
  });

  it("standalone mintLicenseToken function works without a CDRClient", async () => {
    const { publicClient, walletClient } = makeClients({ fee: 0n });
    const result = await mintLicenseToken({
      publicClient: publicClient as any,
      walletClient: walletClient as any,
      licensorIpId: LICENSOR,
      licenseTermsId: 2645,
    });
    expect(result.licenseTokenIds).toEqual([100n]);
  });
});

describe("CDRClient.license getter", () => {
  it("throws WalletClientRequiredError without a wallet", () => {
    const client = new CDRClient({
      network: "testnet",
      publicClient: { readContract: vi.fn() } as any,
      apiUrl: "http://test:1317",
    });
    expect(() => client.license).toThrow(WalletClientRequiredError);
  });
});
