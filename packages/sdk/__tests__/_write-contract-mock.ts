import { vi } from "vitest";
import { decodeFunctionData, type Abi } from "viem";

/**
 * Build a mock walletClient that supports `safeWriteContract`'s flow
 * (`prepareTransactionRequest` → `signTransaction` → `sendRawTransaction`).
 * Queue the broadcast hash via `walletClient.sendRawTransaction.mockResolvedValueOnce(...)`.
 */
export function makeWalletMock() {
  return {
    // type: "local" so safeWriteContract takes the pre-sign path these mocks
    // exercise (prepareTransactionRequest → signTransaction → sendRawTransaction).
    account: { address: "0xaaaa", type: "local" } as const,
    prepareTransactionRequest: vi.fn(async (args: any) => ({
      ...args,
      type: "eip1559",
      nonce: 0,
      gas: 21000n,
      maxFeePerGas: 1n,
      maxPriorityFeePerGas: 1n,
    })),
    signTransaction: vi.fn(async () => "0xsigned" as `0x${string}`),
    sendRawTransaction: vi.fn(),
  };
}

/**
 * Decode a `safeWriteContract` invocation back into the writeContract-shape
 * args `{ address, functionName, args, value }` so legacy assertions on
 * `functionName` / `args` still work after the helper's encode/sign path.
 */
export function decodeWriteCalls(walletClient: any, abi: Abi) {
  return (walletClient.prepareTransactionRequest.mock.calls as any[][]).map(([prep]) => {
    const { functionName, args } = decodeFunctionData({ abi, data: prep.data });
    return { address: prep.to, value: prep.value, functionName, args };
  });
}
