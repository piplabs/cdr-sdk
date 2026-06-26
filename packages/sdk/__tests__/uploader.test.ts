import { describe, it, expect, vi, beforeEach } from "vitest";
import { encodeAbiParameters, keccak256, toBytes } from "viem";

// Mock @piplabs/cdr-crypto before importing Uploader so the WASM loader is never executed.
vi.mock("@piplabs/cdr-crypto", () => ({
  tdh2Encrypt: vi.fn(),
  getWasm: vi.fn().mockReturnValue(null),
}));

import { Uploader } from "../src/uploader.js";
import { tdh2Encrypt } from "@piplabs/cdr-crypto";
import {
  ContentSizeExceededError,
  InvalidConditionContractError,
  InvalidParamsError,
} from "../src/errors.js";
import type { Observer } from "../src/observer.js";
import { cdrAbi } from "@piplabs/cdr-contracts";
import { makeWalletMock, decodeWriteCalls } from "./_write-contract-mock.js";

const SENTINEL_CONDITION_FUNCTION = "__cdrSentinelProbeNoImpl__";
const ERROR_STRING_DEMO_REVERT_RAW =
  "0x08c379a0" +
  "0000000000000000000000000000000000000000000000000000000000000020" +
  "0000000000000000000000000000000000000000000000000000000000000004" +
  "64656d6f00000000000000000000000000000000000000000000000000000000";

/**
 * Minimal Observer stub for Uploader unit tests. Uploader consults Observer
 * for `maxEncryptedDataSize` (the size-validation gate in `write`) and for
 * `getGlobalPubKey` (the auto-query fallback when callers omit globalPubKey).
 */
function fakeObserver(opts: { maxSize?: bigint; globalPubKey?: Uint8Array } = {}): Observer {
  return {
    getMaxEncryptedDataSize: vi.fn().mockResolvedValue(opts.maxSize ?? 10_000n),
    getGlobalPubKey: vi.fn().mockResolvedValue(opts.globalPubKey ?? new Uint8Array([0xaa, 0xbb])),
  } as unknown as Observer;
}

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
    // Default validation path: real selector returns, sentinel selector misses.
    simulateContract: vi
      .fn()
      .mockImplementation(({ functionName }: { functionName: string }) =>
        functionName === SENTINEL_CONDITION_FUNCTION
          ? Promise.reject({
              cause: { name: "ContractFunctionRevertedError", raw: "0x" },
            })
          : Promise.resolve({ result: true, request: {} }),
      ),
  } as any;
  const walletClient = makeWalletMock() as any;
  return { publicClient, walletClient };
}

describe("Uploader", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("allocate sends tx with correct fee and returns uuid from event", async () => {
    const { publicClient, walletClient } = mockClients();
    publicClient.readContract.mockResolvedValueOnce(1000n);
    walletClient.sendRawTransaction.mockResolvedValueOnce("0xtxhash" as `0x${string}`);
    publicClient.waitForTransactionReceipt.mockResolvedValueOnce({
      logs: [makeVaultAllocatedLog(42)],
    });

    const uploader = new Uploader({
      network: "testnet",
      publicClient,
      walletClient,
      observer: fakeObserver(),
    });

    const result = await uploader.allocate({
      updatable: false,
      writeConditionAddr: "0x1111111111111111111111111111111111111111",
      readConditionAddr: "0x2222222222222222222222222222222222222222",
      writeConditionData: "0x",
      readConditionData: "0x",
    });

    expect(walletClient.sendRawTransaction).toHaveBeenCalledOnce();
    const [call] = decodeWriteCalls(walletClient, cdrAbi);
    expect(call.value).toBe(1000n);
    expect(call.functionName).toBe("allocate");
    expect(result.uuid).toBe(42);
    expect(result.txHash).toBe("0xtxhash");
  });

  it("allocate uses feeOverride when provided and skips readContract", async () => {
    const { publicClient, walletClient } = mockClients();
    walletClient.sendRawTransaction.mockResolvedValueOnce("0xtxhash2" as `0x${string}`);
    publicClient.waitForTransactionReceipt.mockResolvedValueOnce({
      logs: [makeVaultAllocatedLog(7)],
    });

    const uploader = new Uploader({
      network: "testnet",
      publicClient,
      walletClient,
      observer: fakeObserver(),
    });

    const result = await uploader.allocate({
      updatable: false,
      writeConditionAddr: "0x1111111111111111111111111111111111111111",
      readConditionAddr: "0x2222222222222222222222222222222222222222",
      writeConditionData: "0x",
      readConditionData: "0x",
      feeOverride: 500n,
    });

    const [call] = decodeWriteCalls(walletClient, cdrAbi);
    expect(call.value).toBe(500n);
    expect(publicClient.readContract).not.toHaveBeenCalled();
    expect(result.uuid).toBe(7);
  });

  it("allocate rejects when condition contract does not implement the check function", async () => {
    const { publicClient, walletClient } = mockClients();
    publicClient.simulateContract.mockRejectedValue({
      cause: { name: "ContractFunctionRevertedError", raw: "0x" },
    });

    const uploader = new Uploader({
      network: "testnet",
      publicClient,
      walletClient,
      observer: fakeObserver(),
    });

    await expect(
      uploader.allocate({
        updatable: false,
        writeConditionAddr: "0x1111111111111111111111111111111111111111",
        readConditionAddr: "0x2222222222222222222222222222222222222222",
        writeConditionData: "0x",
        readConditionData: "0x",
      }),
    ).rejects.toThrow(InvalidConditionContractError);

    expect(walletClient.sendRawTransaction).not.toHaveBeenCalled();
  });

  it("allocate rejects condition revert whose cause has no raw field (#95)", async () => {
    const { publicClient, walletClient } = mockClients();
    publicClient.simulateContract.mockRejectedValue({
      cause: { name: "ContractFunctionRevertedError" }, // no `raw`
    });

    const uploader = new Uploader({
      network: "testnet",
      publicClient,
      walletClient,
      observer: fakeObserver(),
    });

    await expect(
      uploader.allocate({
        updatable: false,
        writeConditionAddr: "0x1111111111111111111111111111111111111111",
        readConditionAddr: "0x2222222222222222222222222222222222222222",
        writeConditionData: "0x",
        readConditionData: "0x",
      }),
    ).rejects.toMatchObject({
      code: "INVALID_CONDITION_CONTRACT",
      reason: "selector-miss",
    });
    expect(walletClient.sendRawTransaction).not.toHaveBeenCalled();
  });

  it("allocate rejects when condition call surfaces ContractFunctionZeroDataError (EOA / no code)", async () => {
    const { publicClient, walletClient } = mockClients();
    publicClient.simulateContract.mockRejectedValue({
      cause: { name: "ContractFunctionZeroDataError" },
    });

    const uploader = new Uploader({
      network: "testnet",
      publicClient,
      walletClient,
      observer: fakeObserver(),
    });

    await expect(
      uploader.allocate({
        updatable: false,
        writeConditionAddr: "0x1111111111111111111111111111111111111111",
        readConditionAddr: "0x2222222222222222222222222222222222222222",
        writeConditionData: "0x",
        readConditionData: "0x",
      }),
    ).rejects.toMatchObject({
      code: "INVALID_CONDITION_CONTRACT",
      reason: "selector-miss",
    });
    expect(walletClient.sendRawTransaction).not.toHaveBeenCalled();
  });

  it("allocate accepts when condition function body reverts with non-empty data", async () => {
    const { publicClient, walletClient } = mockClients();
    const realRevert = {
      cause: {
        name: "ContractFunctionRevertedError",
        raw: ERROR_STRING_DEMO_REVERT_RAW,
      },
    };
    const sentinelRevert = {
      cause: { name: "ContractFunctionRevertedError", raw: "0x" },
    };
    publicClient.simulateContract.mockImplementation(
      ({ functionName }: { functionName: string }) =>
        Promise.reject(
          functionName === SENTINEL_CONDITION_FUNCTION
            ? sentinelRevert
            : realRevert,
        ),
    );
    publicClient.readContract.mockResolvedValueOnce(1000n);
    walletClient.sendRawTransaction.mockResolvedValueOnce("0xtxhash" as `0x${string}`);
    publicClient.waitForTransactionReceipt.mockResolvedValueOnce({
      logs: [makeVaultAllocatedLog(99)],
    });

    const uploader = new Uploader({
      network: "testnet",
      publicClient,
      walletClient,
      observer: fakeObserver(),
    });

    const result = await uploader.allocate({
      updatable: false,
      writeConditionAddr: "0x1111111111111111111111111111111111111111",
      readConditionAddr: "0x2222222222222222222222222222222222222222",
      writeConditionData: "0x",
      readConditionData: "0x",
    });

    expect(result.uuid).toBe(99);
  });

  it("allocate rejects when contract has a payload-reverting fallback (ambiguous)", async () => {
    const { publicClient, walletClient } = mockClients();
    const payloadRevert = {
      cause: {
        name: "ContractFunctionRevertedError",
        raw: ERROR_STRING_DEMO_REVERT_RAW,
      },
    };
    publicClient.simulateContract.mockRejectedValue(payloadRevert);

    const uploader = new Uploader({
      network: "testnet",
      publicClient,
      walletClient,
      observer: fakeObserver(),
    });

    await expect(
      uploader.allocate({
        updatable: false,
        writeConditionAddr: "0x1111111111111111111111111111111111111111",
        readConditionAddr: "0x2222222222222222222222222222222222222222",
        writeConditionData: "0x",
        readConditionData: "0x",
      }),
    ).rejects.toMatchObject({
      code: "INVALID_CONDITION_CONTRACT",
      reason: "ambiguous-fallback",
    });

    expect(walletClient.sendRawTransaction).not.toHaveBeenCalled();
  });

  it("allocate rejects when sentinel probe returns OK (swallow-all fallback)", async () => {
    const { publicClient, walletClient } = mockClients();
    const realRevert = {
      cause: {
        name: "ContractFunctionRevertedError",
        raw: "0x08c379a0",
      },
    };
    publicClient.simulateContract.mockImplementation(
      ({ functionName }: { functionName: string }) =>
        functionName === SENTINEL_CONDITION_FUNCTION
          ? Promise.resolve({ result: true, request: {} })
          : Promise.reject(realRevert),
    );

    const uploader = new Uploader({
      network: "testnet",
      publicClient,
      walletClient,
      observer: fakeObserver(),
    });

    await expect(
      uploader.allocate({
        updatable: false,
        writeConditionAddr: "0x1111111111111111111111111111111111111111",
        readConditionAddr: "0x2222222222222222222222222222222222222222",
        writeConditionData: "0x",
        readConditionData: "0x",
      }),
    ).rejects.toMatchObject({
      code: "INVALID_CONDITION_CONTRACT",
      reason: "ambiguous-fallback",
    });
    expect(walletClient.sendRawTransaction).not.toHaveBeenCalled();
  });

  it("allocate rejects when the real selector itself returns OK via a swallow-all fallback", async () => {
    const { publicClient, walletClient } = mockClients();
    publicClient.simulateContract.mockResolvedValue({ result: true, request: {} });

    const uploader = new Uploader({
      network: "testnet",
      publicClient,
      walletClient,
      observer: fakeObserver(),
    });

    await expect(
      uploader.allocate({
        updatable: false,
        writeConditionAddr: "0x1111111111111111111111111111111111111111",
        readConditionAddr: "0x2222222222222222222222222222222222222222",
        writeConditionData: "0x",
        readConditionData: "0x",
      }),
    ).rejects.toMatchObject({
      code: "INVALID_CONDITION_CONTRACT",
      reason: "ambiguous-fallback",
    });
    expect(walletClient.sendRawTransaction).not.toHaveBeenCalled();
  });

  it("allocate surfaces a transport error from the sentinel probe instead of masking it as ambiguous", async () => {
    const { publicClient, walletClient } = mockClients();
    publicClient.simulateContract.mockImplementation(
      ({ functionName }: { functionName: string }) =>
        functionName === SENTINEL_CONDITION_FUNCTION
          ? Promise.reject(new Error("HTTP request failed"))
          : Promise.resolve({ result: true, request: {} }),
    );

    const uploader = new Uploader({
      network: "testnet",
      publicClient,
      walletClient,
      observer: fakeObserver(),
    });

    await expect(
      uploader.allocate({
        updatable: false,
        writeConditionAddr: "0x1111111111111111111111111111111111111111",
        readConditionAddr: "0x2222222222222222222222222222222222222222",
        writeConditionData: "0x",
        readConditionData: "0x",
      }),
    ).rejects.toThrow("HTTP request failed");
    expect(walletClient.sendRawTransaction).not.toHaveBeenCalled();
  });

  it("allocate surfaces a transport error from the real probe instead of masking it as invalid", async () => {
    const { publicClient, walletClient } = mockClients();
    publicClient.simulateContract.mockRejectedValue(new Error("RPC timeout"));

    const uploader = new Uploader({
      network: "testnet",
      publicClient,
      walletClient,
      observer: fakeObserver(),
    });

    await expect(
      uploader.allocate({
        updatable: false,
        writeConditionAddr: "0x1111111111111111111111111111111111111111",
        readConditionAddr: "0x2222222222222222222222222222222222222222",
        writeConditionData: "0x",
        readConditionData: "0x",
      }),
    ).rejects.toThrow("RPC timeout");
    expect(walletClient.sendRawTransaction).not.toHaveBeenCalled();
  });

  it("allocate preflight probes condition contracts with the 4-arg signature", async () => {
    const { publicClient, walletClient } = mockClients();
    publicClient.readContract.mockResolvedValueOnce(1000n);
    walletClient.sendRawTransaction.mockResolvedValueOnce("0xtxhash" as `0x${string}`);
    publicClient.waitForTransactionReceipt.mockResolvedValueOnce({
      logs: [makeVaultAllocatedLog(1)],
    });

    const uploader = new Uploader({
      network: "testnet",
      publicClient,
      walletClient,
      observer: fakeObserver(),
    });

    await uploader.allocate({
      updatable: false,
      writeConditionAddr: "0x1111111111111111111111111111111111111111",
      readConditionAddr: "0x2222222222222222222222222222222222222222",
      writeConditionData: "0x",
      readConditionData: "0x",
    });

    const calls = publicClient.simulateContract.mock.calls.map((c: any[]) => c[0]);
    const realCalls = calls.filter(
      (c: any) => c.functionName !== SENTINEL_CONDITION_FUNCTION,
    );
    const sentinelCalls = calls.filter(
      (c: any) => c.functionName === SENTINEL_CONDITION_FUNCTION,
    );
    expect(realCalls).toHaveLength(2);
    expect(realCalls.map((c: any) => c.functionName).sort()).toEqual([
      "checkReadCondition",
      "checkWriteCondition",
    ]);
    for (const { abi, args } of realCalls) {
      expect(abi[0].inputs).toEqual([
        { name: "uuid", type: "uint32" },
        { name: "accessAuxData", type: "bytes" },
        { name: "conditionData", type: "bytes" },
        { name: "caller", type: "address" },
      ]);
      expect(args).toHaveLength(4);
    }
    expect(sentinelCalls).toHaveLength(2);
  });

  it("requires simulateContract for condition validation", async () => {
    const { publicClient, walletClient } = mockClients();
    delete publicClient.simulateContract;

    const uploader = new Uploader({
      network: "testnet",
      publicClient,
      walletClient,
      observer: fakeObserver(),
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
    ).rejects.toThrow(InvalidParamsError);

    expect(walletClient.sendRawTransaction).not.toHaveBeenCalled();
  });

  it("write sends tx with correct fee", async () => {
    const { publicClient, walletClient } = mockClients();
    publicClient.readContract.mockResolvedValueOnce(200n);
    walletClient.sendRawTransaction.mockResolvedValueOnce("0xwritetx" as `0x${string}`);

    const uploader = new Uploader({
      network: "testnet",
      publicClient,
      walletClient,
      observer: fakeObserver(),
    });

    const result = await uploader.write({
      uuid: 1,
      accessAuxData: "0x",
      encryptedData: "0xdeadbeef",
    });

    expect(walletClient.sendRawTransaction).toHaveBeenCalledOnce();
    const [call] = decodeWriteCalls(walletClient, cdrAbi);
    expect(call.value).toBe(200n);
    expect(call.functionName).toBe("write");
    expect(result.txHash).toBe("0xwritetx");
  });

  it("write uses feeOverride when provided and skips readContract", async () => {
    const { publicClient, walletClient } = mockClients();
    walletClient.sendRawTransaction.mockResolvedValueOnce("0xwritetx2" as `0x${string}`);

    const uploader = new Uploader({
      network: "testnet",
      publicClient,
      walletClient,
      observer: fakeObserver(),
    });

    await uploader.write({
      uuid: 5,
      accessAuxData: "0x",
      encryptedData: "0xcafe",
      feeOverride: 99n,
    });

    const [call] = decodeWriteCalls(walletClient, cdrAbi);
    expect(call.value).toBe(99n);
    expect(publicClient.readContract).not.toHaveBeenCalled();
  });

  it("parseVaultAllocatedUuid throws when no VaultAllocated event in logs", async () => {
    const { publicClient, walletClient } = mockClients();
    walletClient.sendRawTransaction.mockResolvedValueOnce("0xtxhash" as `0x${string}`);
    publicClient.waitForTransactionReceipt.mockResolvedValueOnce({ logs: [] });

    const uploader = new Uploader({
      network: "testnet",
      publicClient,
      walletClient,
      observer: fakeObserver(),
    });

    await expect(
      uploader.allocate({
        updatable: false,
        writeConditionAddr: "0x1111111111111111111111111111111111111111",
        readConditionAddr: "0x2222222222222222222222222222222222222222",
        writeConditionData: "0x",
        readConditionData: "0x",
        feeOverride: 0n,
        skipConditionValidation: true,
      }),
    ).rejects.toThrow("VaultAllocated event not found in transaction logs");
  });

  it("encryptDataKey delegates to tdh2Encrypt with correct args (explicit globalPubKey)", async () => {
    const { publicClient, walletClient } = mockClients();
    const mockCiphertext = { raw: new Uint8Array([1, 2, 3]), label: new Uint8Array([4, 5]) };
    vi.mocked(tdh2Encrypt).mockResolvedValueOnce(mockCiphertext);

    const observer = fakeObserver();
    const uploader = new Uploader({
      network: "testnet",
      publicClient,
      walletClient,
      observer,
    });
    const dataKey = new Uint8Array([10, 20, 30]);
    const globalPubKey = new Uint8Array([99]);
    const label = new TextEncoder().encode("test-label");
    const result = await uploader.encryptDataKey({ dataKey, globalPubKey, label });

    expect(tdh2Encrypt).toHaveBeenCalledOnce();
    const callArgs = vi.mocked(tdh2Encrypt).mock.calls[0][0];
    expect(callArgs.plaintext).toBe(dataKey);
    expect(callArgs.globalPubKey).toBe(globalPubKey);
    expect(callArgs.label).toEqual(label);
    expect(result).toBe(mockCiphertext);

    // Explicit caller bypass: Observer is NOT consulted.
    expect(observer.getGlobalPubKey).not.toHaveBeenCalled();
  });

  it("encryptDataKey auto-queries Observer.getGlobalPubKey when globalPubKey is omitted", async () => {
    const { publicClient, walletClient } = mockClients();
    const mockCiphertext = { raw: new Uint8Array([7, 8, 9]), label: new Uint8Array([10]) };
    vi.mocked(tdh2Encrypt).mockResolvedValueOnce(mockCiphertext);

    const fetchedKey = new Uint8Array([0xde, 0xad, 0xbe, 0xef]);
    const observer = fakeObserver({ globalPubKey: fetchedKey });
    const uploader = new Uploader({
      network: "testnet",
      publicClient,
      walletClient,
      observer,
    });
    const dataKey = new Uint8Array([1, 2]);
    const label = new TextEncoder().encode("auto-fallback");
    const result = await uploader.encryptDataKey({ dataKey, label });

    expect(observer.getGlobalPubKey).toHaveBeenCalledOnce();
    const callArgs = vi.mocked(tdh2Encrypt).mock.calls[0][0];
    expect(callArgs.globalPubKey).toBe(fetchedKey);
    expect(result).toBe(mockCiphertext);
  });

  it("write throws ContentSizeExceededError when encryptedData exceeds maxEncryptedDataSize", async () => {
    const { publicClient, walletClient } = mockClients();
    // 5-byte limit; the input below is 8 bytes.
    const observer = fakeObserver({ maxSize: 5n });

    const uploader = new Uploader({
      network: "testnet",
      publicClient,
      walletClient,
      observer,
    });

    await expect(
      uploader.write({
        uuid: 1,
        accessAuxData: "0x",
        encryptedData: "0xdeadbeefcafe1234",
        feeOverride: 0n, // skip the readContract for writeFee
      }),
    ).rejects.toThrow(ContentSizeExceededError);

    // No tx ever submitted — fail-fast before writeContract.
    expect(walletClient.sendRawTransaction).not.toHaveBeenCalled();
    expect(observer.getMaxEncryptedDataSize).toHaveBeenCalledOnce();
  });

  it("uploadCDR with skipConditionValidation does not call simulateContract and completes", async () => {
    const { publicClient, walletClient } = mockClients();
    // allocateFee
    publicClient.readContract.mockResolvedValueOnce(1000n);
    walletClient.sendRawTransaction.mockResolvedValueOnce("0xalloctx" as `0x${string}`);
    publicClient.waitForTransactionReceipt.mockResolvedValueOnce({
      logs: [makeVaultAllocatedLog(99)],
    });
    // writeFee
    publicClient.readContract.mockResolvedValueOnce(200n);
    walletClient.sendRawTransaction.mockResolvedValueOnce("0xwritetx" as `0x${string}`);
    publicClient.waitForTransactionReceipt.mockResolvedValueOnce({});

    vi.mocked(tdh2Encrypt).mockResolvedValueOnce({
      raw: new Uint8Array([1, 2, 3]),
      label: new Uint8Array([4, 5]),
    });

    const uploader = new Uploader({
      network: "testnet",
      publicClient,
      walletClient,
      observer: fakeObserver(),
    });

    // EOA addresses — would fail interface validation if it ran.
    const result = await uploader.uploadCDR({
      dataKey: new Uint8Array([0x11]),
      globalPubKey: new Uint8Array([0xaa]),
      updatable: false,
      writeConditionAddr: "0xeeee000000000000000000000000000000000001",
      readConditionAddr: "0xeeee000000000000000000000000000000000002",
      writeConditionData: "0x",
      readConditionData: "0x",
      accessAuxData: "0x",
      skipConditionValidation: true,
    });

    expect(publicClient.simulateContract).not.toHaveBeenCalled();
    expect(result.uuid).toBe(99);
    expect(result.txHashes.allocate).toBe("0xalloctx");
    expect(result.txHashes.write).toBe("0xwritetx");
  });

  it("uploadCDR without skipConditionValidation rejects EOA condition addresses with InvalidConditionContractError", async () => {
    const { publicClient, walletClient } = mockClients();
    // EOA / non-contract address → viem ContractFunctionZeroDataError, which the
    // preflight maps to InvalidConditionContractError (reason "selector-miss").
    publicClient.simulateContract.mockReset();
    publicClient.simulateContract.mockRejectedValue({
      cause: { name: "ContractFunctionZeroDataError" },
    });

    const uploader = new Uploader({
      network: "testnet",
      publicClient,
      walletClient,
      observer: fakeObserver(),
    });

    await expect(
      uploader.uploadCDR({
        dataKey: new Uint8Array([0x11]),
        globalPubKey: new Uint8Array([0xaa]),
        updatable: false,
        writeConditionAddr: "0xeeee000000000000000000000000000000000001",
        readConditionAddr: "0xeeee000000000000000000000000000000000002",
        writeConditionData: "0x",
        readConditionData: "0x",
        accessAuxData: "0x",
      }),
    ).rejects.toThrow(InvalidConditionContractError);

    expect(walletClient.sendRawTransaction).not.toHaveBeenCalled();
  });

  it("write passes when encryptedData is within maxEncryptedDataSize", async () => {
    const { publicClient, walletClient } = mockClients();
    const observer = fakeObserver({ maxSize: 100n });
    walletClient.sendRawTransaction.mockResolvedValueOnce("0xtxh" as `0x${string}`);

    const uploader = new Uploader({
      network: "testnet",
      publicClient,
      walletClient,
      observer,
    });

    await uploader.write({
      uuid: 1,
      accessAuxData: "0x",
      encryptedData: "0xdeadbeef", // 4 bytes
      feeOverride: 0n,
    });

    expect(walletClient.sendRawTransaction).toHaveBeenCalledOnce();
  });
});
