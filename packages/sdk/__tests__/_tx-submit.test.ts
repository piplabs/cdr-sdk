import { describe, it, expect, vi } from "vitest";
import { keccak256 } from "viem";

import { safeWriteContract, isAlreadySubmittedError } from "../src/_tx-submit.js";

const SAMPLE_ABI = [
  {
    type: "function",
    name: "ping",
    inputs: [{ name: "n", type: "uint256" }],
    outputs: [],
    stateMutability: "payable",
  },
] as const;

const ACCOUNT = {
  address: "0x5B07483b0D1235a399A483aC8cCE665eCB5E3a75" as const,
  type: "json-rpc" as const,
};

const CHAIN = { id: 1315 } as any;

const ADDRESS = "0xcccccc0000000000000000000000000000000005" as const;

const SAMPLE_SERIALIZED =
  "0x02f868018203118080825208808080c080a04012522854168b27e5dc3d5839bab5e6b39e1a0ffd343901ce1622e3d64b48f1a04e00902ae0502c4728cbf12156290df99c3ed7de85b1dbfe20b5c36931733a33" as const;

const EXPECTED_HASH = keccak256(SAMPLE_SERIALIZED);

function mockWallet(opts: {
  sendImpl: () => Promise<`0x${string}`>;
}) {
  const wallet = {
    prepareTransactionRequest: vi.fn(async (_args: unknown) => ({
      to: ADDRESS,
      data: "0xdeadbeef",
      chainId: 1315,
      type: "eip1559",
      account: ACCOUNT,
    })),
    signTransaction: vi.fn(async () => SAMPLE_SERIALIZED),
    sendRawTransaction: vi.fn(opts.sendImpl),
  } as any;
  return wallet;
}

function rpcErrLike(opts: { details?: string; message?: string; cause?: unknown } = {}) {
  return Object.assign(new Error(opts.message ?? "Missing or invalid parameters."), {
    details: opts.details,
    cause: opts.cause,
    code: -32000,
  });
}

describe("safeWriteContract", () => {
  it("happy path: returns the hash from sendRawTransaction", async () => {
    const wallet = mockWallet({ sendImpl: async () => EXPECTED_HASH });
    const hash = await safeWriteContract(wallet, {
      account: ACCOUNT,
      chain: CHAIN,
      address: ADDRESS,
      abi: SAMPLE_ABI as any,
      functionName: "ping",
      args: [42n],
      value: 0n,
    });
    expect(hash).toBe(EXPECTED_HASH);
    expect(wallet.prepareTransactionRequest).toHaveBeenCalledTimes(1);
    expect(wallet.signTransaction).toHaveBeenCalledTimes(1);
    expect(wallet.sendRawTransaction).toHaveBeenCalledTimes(1);
  });

  it("recovers from `replacement transaction underpriced` and returns the precomputed hash", async () => {
    const wallet = mockWallet({
      sendImpl: async () => {
        throw rpcErrLike({
          details: "replacement transaction underpriced",
          message: "Missing or invalid parameters.",
        });
      },
    });
    const hash = await safeWriteContract(wallet, {
      account: ACCOUNT,
      chain: CHAIN,
      address: ADDRESS,
      abi: SAMPLE_ABI as any,
      functionName: "ping",
      args: [42n],
    });
    expect(hash).toBe(EXPECTED_HASH);
  });

  it("recovers from `already known`", async () => {
    const wallet = mockWallet({
      sendImpl: async () => {
        throw rpcErrLike({ details: "already known" });
      },
    });
    const hash = await safeWriteContract(wallet, {
      account: ACCOUNT,
      chain: CHAIN,
      address: ADDRESS,
      abi: SAMPLE_ABI as any,
      functionName: "ping",
      args: [42n],
    });
    expect(hash).toBe(EXPECTED_HASH);
  });

  it("rethrows `nonce too low` (ambiguous — a different tx may have consumed the nonce)", async () => {
    const wallet = mockWallet({
      sendImpl: async () => {
        throw rpcErrLike({ details: "nonce too low" });
      },
    });
    await expect(
      safeWriteContract(wallet, {
        account: ACCOUNT,
        chain: CHAIN,
        address: ADDRESS,
        abi: SAMPLE_ABI as any,
        functionName: "ping",
        args: [42n],
      }),
    ).rejects.toThrow(/Missing or invalid parameters|nonce too low/);
  });

  it("walks the `cause` chain to find the real error", async () => {
    const wallet = mockWallet({
      sendImpl: async () => {
        const inner = rpcErrLike({ details: "replacement transaction underpriced" });
        const middle = rpcErrLike({
          details: "RPC Request failed.",
          message: "Missing or invalid parameters.",
          cause: inner,
        });
        const outer = rpcErrLike({
          details: undefined,
          message: "ContractFunctionExecutionError",
          cause: middle,
        });
        throw outer;
      },
    });
    const hash = await safeWriteContract(wallet, {
      account: ACCOUNT,
      chain: CHAIN,
      address: ADDRESS,
      abi: SAMPLE_ABI as any,
      functionName: "ping",
      args: [42n],
    });
    expect(hash).toBe(EXPECTED_HASH);
  });

  it("rethrows unrelated errors (e.g. revert / out of gas)", async () => {
    const wallet = mockWallet({
      sendImpl: async () => {
        throw rpcErrLike({
          details: "execution reverted: Invalid fee amount",
          message: "ContractFunctionExecutionError",
        });
      },
    });
    await expect(
      safeWriteContract(wallet, {
        account: ACCOUNT,
        chain: CHAIN,
        address: ADDRESS,
        abi: SAMPLE_ABI as any,
        functionName: "ping",
        args: [42n],
      }),
    ).rejects.toThrow(/ContractFunctionExecutionError/);
  });

  it("passes account=null / chain=null through to viem unchanged (matches writeContract)", async () => {
    // Historical writeContract usage in this SDK is
    //   account: walletClient.account ?? null,
    //   chain:   walletClient.chain   ?? null,
    // so the helper must accept null without throwing of its own accord and
    // let viem do the same validation the old call path did.
    const wallet = mockWallet({ sendImpl: async () => EXPECTED_HASH });
    const hash = await safeWriteContract(wallet, {
      account: null,
      chain: null,
      address: ADDRESS,
      abi: SAMPLE_ABI as any,
      functionName: "ping",
      args: [42n],
    });
    expect(hash).toBe(EXPECTED_HASH);
    const prepArg = wallet.prepareTransactionRequest.mock.calls[0][0];
    expect(prepArg.account).toBeUndefined();
    expect(prepArg.chain).toBeUndefined();
  });
});

describe("isAlreadySubmittedError", () => {
  it.each([
    "replacement transaction underpriced",
    "already known",
    "Replacement Transaction Underpriced",
    "Already Known",
  ])("detects %q in details", (detailsText) => {
    expect(isAlreadySubmittedError({ details: detailsText })).toBe(true);
  });

  it.each([
    "nonce too low",
    "NONCE TOO LOW",
    "execution reverted",
    "insufficient funds",
    "intrinsic gas too low",
    "",
    "Missing or invalid parameters.",
  ])("returns false for %q", (detailsText) => {
    expect(isAlreadySubmittedError({ details: detailsText })).toBe(false);
  });

  it("returns false for null / undefined / non-objects", () => {
    expect(isAlreadySubmittedError(null)).toBe(false);
    expect(isAlreadySubmittedError(undefined)).toBe(false);
    expect(isAlreadySubmittedError("replacement transaction underpriced")).toBe(false);
    expect(isAlreadySubmittedError(42)).toBe(false);
  });

  it("guards against cyclic cause chains", () => {
    const a: any = { details: "wrap" };
    const b: any = { details: "wrap", cause: a };
    a.cause = b;
    expect(isAlreadySubmittedError(a)).toBe(false);
  });
});
