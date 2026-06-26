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
  type: "local" as const,
};

const JSON_RPC_ACCOUNT = {
  address: "0x5B07483b0D1235a399A483aC8cCE665eCB5E3a75" as const,
  type: "json-rpc" as const,
};

const CHAIN = { id: 1315 } as any;

// Minimal publicClient stub. The local (pre-sign) path never touches it; the
// json-rpc path reads getTransactionCount/getBlockNumber best-effort (failures
// are swallowed). Tests that exercise nonce recovery build their own.
const PUBLIC = {} as any;

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
    writeContract: vi.fn(async () => EXPECTED_HASH),
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

// Invoke safeWriteContract with the common writeContract-shape boilerplate.
// account defaults to the local ACCOUNT and chain to CHAIN; pass overrides
// (e.g. a JSON-RPC account, or null) to exercise the other paths.
function callPing(
  wallet: any,
  publicClient: any = PUBLIC,
  overrides: { account?: unknown; chain?: unknown } = {},
) {
  return safeWriteContract(wallet, publicClient, {
    account: ("account" in overrides ? overrides.account : ACCOUNT) as any,
    chain: ("chain" in overrides ? overrides.chain : CHAIN) as any,
    address: ADDRESS,
    abi: SAMPLE_ABI as any,
    functionName: "ping",
    args: [42n],
  });
}

describe("safeWriteContract", () => {
  it("happy path: returns the hash from sendRawTransaction", async () => {
    const wallet = mockWallet({ sendImpl: async () => EXPECTED_HASH });
    const hash = await callPing(wallet);
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
    expect(await callPing(wallet)).toBe(EXPECTED_HASH);
  });

  it("recovers from `already known`", async () => {
    const wallet = mockWallet({
      sendImpl: async () => {
        throw rpcErrLike({ details: "already known" });
      },
    });
    expect(await callPing(wallet)).toBe(EXPECTED_HASH);
  });

  it("rethrows `nonce too low` (ambiguous — a different tx may have consumed the nonce)", async () => {
    const wallet = mockWallet({
      sendImpl: async () => {
        throw rpcErrLike({ details: "nonce too low" });
      },
    });
    await expect(callPing(wallet)).rejects.toThrow(/Missing or invalid parameters|nonce too low/);
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
    expect(await callPing(wallet)).toBe(EXPECTED_HASH);
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
    await expect(callPing(wallet)).rejects.toThrow(/ContractFunctionExecutionError/);
  });

  it("falls back to writeContract for a JSON-RPC account (cannot pre-sign locally)", async () => {
    // A node-managed account (MetaMask / json-rpc) has no in-process key, so
    // signTransaction would hit eth_signTransaction (unsupported on public
    // RPCs). The helper must defer to writeContract instead of pre-signing.
    const wallet = mockWallet({ sendImpl: async () => EXPECTED_HASH });
    const hash = await callPing(wallet, PUBLIC, { account: JSON_RPC_ACCOUNT });
    expect(hash).toBe(EXPECTED_HASH);
    expect(wallet.writeContract).toHaveBeenCalledTimes(1);
    expect(wallet.signTransaction).not.toHaveBeenCalled();
    expect(wallet.sendRawTransaction).not.toHaveBeenCalled();
    const wcArg = wallet.writeContract.mock.calls[0][0];
    expect(wcArg.functionName).toBe("ping");
    expect(wcArg.account).toBe(JSON_RPC_ACCOUNT);
  });

  it("falls back to writeContract when account is null (node-managed, matches old call path)", async () => {
    // Historical writeContract usage in this SDK is
    //   account: walletClient.account ?? null,
    //   chain:   walletClient.chain   ?? null,
    // With no resolvable local account the helper defers to writeContract,
    // exactly as the pre-existing call path did.
    const wallet = mockWallet({ sendImpl: async () => EXPECTED_HASH });
    const hash = await callPing(wallet, PUBLIC, { account: null, chain: null });
    expect(hash).toBe(EXPECTED_HASH);
    expect(wallet.writeContract).toHaveBeenCalledTimes(1);
    const wcArg = wallet.writeContract.mock.calls[0][0];
    expect(wcArg.account).toBeNull();
    expect(wcArg.chain).toBeNull();
  });

  it("JSON-RPC account: recovers the hash by (sender,nonce) block scan on a retry collision", async () => {
    // The node-managed send collides (already in mempool) but writeContract
    // never gave us the hash. We captured the pending nonce before sending and
    // recover the hash by finding the mined tx with that (sender, nonce).
    const FROM = JSON_RPC_ACCOUNT.address;
    const RECOVERED = "0xdecafbad" as `0x${string}`;
    const wallet = mockWallet({ sendImpl: async () => EXPECTED_HASH });
    wallet.writeContract = vi.fn(async () => {
      throw rpcErrLike({ details: "replacement transaction underpriced" });
    });
    const publicClient = {
      getTransactionCount: vi.fn(async () => 7),
      getBlockNumber: vi.fn(async () => 100n),
      getBlock: vi.fn(async ({ blockNumber }: { blockNumber: bigint }) => {
        // tx with (FROM, nonce 7) lands in block 101
        if (blockNumber === 101n) {
          return {
            transactions: [
              { from: "0x0000000000000000000000000000000000000001", nonce: 3, hash: "0xother" },
              { from: FROM.toLowerCase(), nonce: 7, hash: RECOVERED },
            ],
          };
        }
        return { transactions: [] };
      }),
    } as any;
    // head advances to 101 on the second poll
    publicClient.getBlockNumber
      .mockResolvedValueOnce(100n)
      .mockResolvedValue(101n);

    const hash = await callPing(wallet, publicClient, { account: JSON_RPC_ACCOUNT });
    expect(hash).toBe(RECOVERED);
    expect(publicClient.getTransactionCount).toHaveBeenCalledWith({ address: FROM, blockTag: "pending" });
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
