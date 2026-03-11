import { describe, it, expect, vi, beforeEach } from "vitest";
import { encodeAbiParameters, keccak256, toBytes } from "viem";

// Mock @piplabs/cdr-crypto before importing Uploader so the WASM loader is never executed.
vi.mock("@piplabs/cdr-crypto", () => ({
  tdh2Encrypt: vi.fn(),
}));

import { Uploader } from "../src/uploader.js";
import { tdh2Encrypt } from "@piplabs/cdr-crypto";

// Build a properly ABI-encoded VaultAllocated log that viem's parseEventLogs can decode.
// All fields in VaultAllocated are non-indexed, so they live entirely in `data`.
// topic0 = keccak256("VaultAllocated(uint32,bool,address,address,bytes,bytes)")
function makeVaultAllocatedLog(uuid: number) {
  const topic0 = keccak256(
    toBytes("VaultAllocated(uint32,bool,address,address,bytes,bytes)"),
  );

  const data = encodeAbiParameters(
    [
      { name: "uuid", type: "uint32" },
      { name: "updatable", type: "bool" },
      { name: "writeConditionAddr", type: "address" },
      { name: "readConditionAddr", type: "address" },
      { name: "writeConditionData", type: "bytes" },
      { name: "readConditionData", type: "bytes" },
    ],
    [
      uuid,
      false,
      "0x1111111111111111111111111111111111111111",
      "0x2222222222222222222222222222222222222222",
      "0x",
      "0x",
    ],
  );

  return {
    address: "0xcccccc0000000000000000000000000000000005" as `0x${string}`,
    topics: [topic0] as [`0x${string}`],
    data,
    blockHash: "0x0000000000000000000000000000000000000000000000000000000000000000" as `0x${string}`,
    blockNumber: 1n,
    transactionHash: "0x0000000000000000000000000000000000000000000000000000000000000001" as `0x${string}`,
    transactionIndex: 0,
    logIndex: 0,
    removed: false,
  };
}

function mockClients() {
  const publicClient = {
    readContract: vi.fn(),
    waitForTransactionReceipt: vi.fn(),
    getTransactionReceipt: vi.fn(),
  } as any;
  const walletClient = {
    writeContract: vi.fn(),
    account: { address: "0xaaaa" },
  } as any;
  return { publicClient, walletClient };
}

describe("Uploader", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("allocate sends tx with correct fee and returns uuid from event", async () => {
    const { publicClient, walletClient } = mockClients();
    publicClient.readContract.mockResolvedValueOnce(1000n);
    walletClient.writeContract.mockResolvedValueOnce("0xtxhash" as `0x${string}`);
    publicClient.waitForTransactionReceipt.mockResolvedValueOnce({
      logs: [makeVaultAllocatedLog(42)],
    });

    const uploader = new Uploader({
      network: "testnet",
      publicClient,
      walletClient,
    });

    const result = await uploader.allocate({
      updatable: false,
      writeConditionAddr: "0x1111111111111111111111111111111111111111",
      readConditionAddr: "0x2222222222222222222222222222222222222222",
      writeConditionData: "0x",
      readConditionData: "0x",
    });

    expect(walletClient.writeContract).toHaveBeenCalledOnce();
    const callArgs = walletClient.writeContract.mock.calls[0][0];
    expect(callArgs.value).toBe(1000n);
    expect(result.uuid).toBe(42);
    expect(result.txHash).toBe("0xtxhash");
  });

  it("allocate uses feeOverride when provided and skips readContract", async () => {
    const { publicClient, walletClient } = mockClients();
    walletClient.writeContract.mockResolvedValueOnce("0xtxhash2" as `0x${string}`);
    publicClient.waitForTransactionReceipt.mockResolvedValueOnce({
      logs: [makeVaultAllocatedLog(7)],
    });

    const uploader = new Uploader({
      network: "testnet",
      publicClient,
      walletClient,
    });

    const result = await uploader.allocate({
      updatable: false,
      writeConditionAddr: "0x1111111111111111111111111111111111111111",
      readConditionAddr: "0x2222222222222222222222222222222222222222",
      writeConditionData: "0x",
      readConditionData: "0x",
      feeOverride: 500n,
    });

    const callArgs = walletClient.writeContract.mock.calls[0][0];
    expect(callArgs.value).toBe(500n);
    expect(publicClient.readContract).not.toHaveBeenCalled();
    expect(result.uuid).toBe(7);
  });

  it("write sends tx with correct fee", async () => {
    const { publicClient, walletClient } = mockClients();
    publicClient.readContract.mockResolvedValueOnce(200n);
    walletClient.writeContract.mockResolvedValueOnce("0xwritetx" as `0x${string}`);

    const uploader = new Uploader({
      network: "testnet",
      publicClient,
      walletClient,
    });

    const result = await uploader.write({
      uuid: 1,
      accessAuxData: "0x",
      encryptedData: "0xdeadbeef",
    });

    expect(walletClient.writeContract).toHaveBeenCalledOnce();
    const callArgs = walletClient.writeContract.mock.calls[0][0];
    expect(callArgs.value).toBe(200n);
    expect(callArgs.functionName).toBe("write");
    expect(result.txHash).toBe("0xwritetx");
  });

  it("write uses feeOverride when provided and skips readContract", async () => {
    const { publicClient, walletClient } = mockClients();
    walletClient.writeContract.mockResolvedValueOnce("0xwritetx2" as `0x${string}`);

    const uploader = new Uploader({
      network: "testnet",
      publicClient,
      walletClient,
    });

    await uploader.write({
      uuid: 5,
      accessAuxData: "0x",
      encryptedData: "0xcafe",
      feeOverride: 99n,
    });

    const callArgs = walletClient.writeContract.mock.calls[0][0];
    expect(callArgs.value).toBe(99n);
    expect(publicClient.readContract).not.toHaveBeenCalled();
  });

  it("parseVaultAllocatedUuid throws when no VaultAllocated event in logs", async () => {
    const { publicClient, walletClient } = mockClients();
    walletClient.writeContract.mockResolvedValueOnce("0xtxhash" as `0x${string}`);
    publicClient.waitForTransactionReceipt.mockResolvedValueOnce({ logs: [] });

    const uploader = new Uploader({
      network: "testnet",
      publicClient,
      walletClient,
    });

    await expect(
      uploader.allocate({
        updatable: false,
        writeConditionAddr: "0x1111111111111111111111111111111111111111",
        readConditionAddr: "0x2222222222222222222222222222222222222222",
        writeConditionData: "0x",
        readConditionData: "0x",
        feeOverride: 0n,
      }),
    ).rejects.toThrow("VaultAllocated event not found in transaction logs");
  });

  it("encryptDataKey delegates to tdh2Encrypt with correct args", async () => {
    const { publicClient, walletClient } = mockClients();
    const mockCiphertext = { raw: new Uint8Array([1, 2, 3]), label: new Uint8Array([4, 5]) };
    vi.mocked(tdh2Encrypt).mockResolvedValueOnce(mockCiphertext);

    const uploader = new Uploader({ network: "testnet", publicClient, walletClient });
    const dataKey = new Uint8Array([10, 20, 30]);
    const globalPubKey = new Uint8Array([99]);
    const result = await uploader.encryptDataKey({ dataKey, globalPubKey, label: "test-label" });

    expect(tdh2Encrypt).toHaveBeenCalledOnce();
    const callArgs = vi.mocked(tdh2Encrypt).mock.calls[0][0];
    expect(callArgs.plaintext).toBe(dataKey);
    expect(callArgs.globalPubKey).toBe(globalPubKey);
    expect(callArgs.label).toEqual(new TextEncoder().encode("test-label"));
    expect(result).toBe(mockCiphertext);
  });
});
