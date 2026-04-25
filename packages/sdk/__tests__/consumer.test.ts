import { describe, it, expect, vi } from "vitest";
import { encodeAbiParameters, keccak256, toBytes, padHex } from "viem";

// Mock @piplabs/cdr-crypto before importing Consumer so the WASM loader is never executed.
vi.mock("@piplabs/cdr-crypto", () => ({
  decryptPartial: vi.fn(),
  tdh2Combine: vi.fn(),
  verifyPartialSignature: vi.fn(),
}));

import { Consumer } from "../src/consumer.js";
import { verifyPartialSignature } from "@piplabs/cdr-crypto";

function makePartialDecryptionLog(opts: {
  validator: `0x${string}`;
  round: number;
  pid: number;
  uuid: number;
}) {
  const topic0 = keccak256(
    toBytes(
      "EncryptedPartialDecryptionSubmitted(address,uint32,uint32,bytes,bytes,bytes,bytes,bytes,uint32,bytes,uint256)",
    ),
  );

  const topic1 = padHex(opts.validator, { size: 32 });

  const data = encodeAbiParameters(
    [
      { name: "round", type: "uint32" },
      { name: "pid", type: "uint32" },
      { name: "encryptedPartial", type: "bytes" },
      { name: "ephemeralPubKey", type: "bytes" },
      { name: "pubShare", type: "bytes" },
      { name: "requesterPubKey", type: "bytes" },
      { name: "ciphertext", type: "bytes" },
      { name: "uuid", type: "uint32" },
      { name: "signature", type: "bytes" },
      { name: "fee", type: "uint256" },
    ],
    [
      opts.round,
      opts.pid,
      "0xdeadbeef",
      "0xcafe0000",
      "0xbabe0000",
      "0xfeed0000",
      "0xaa",
      opts.uuid,
      "0x5369670000000000",
      0n,
    ],
  );

  return {
    address: "0xcccccc0000000000000000000000000000000005" as `0x${string}`,
    topics: [topic0, topic1] as [`0x${string}`, `0x${string}`],
    data,
    blockHash: "0x0000000000000000000000000000000000000000000000000000000000000000" as `0x${string}`,
    blockNumber: 100n,
    transactionHash: "0x0000000000000000000000000000000000000000000000000000000000000001" as `0x${string}`,
    transactionIndex: 0,
    logIndex: 0,
    removed: false,
  };
}

function mockClients() {
  const publicClient = {
    readContract: vi.fn(),
    writeContract: vi.fn(),
    waitForTransactionReceipt: vi.fn(),
    getLogs: vi.fn(),
    getBlockNumber: vi.fn(),
  } as any;
  const walletClient = {
    writeContract: vi.fn(),
    account: { address: "0xbbbb" },
  } as any;
  return { publicClient, walletClient };
}

function makeRegisteredLog(opts: {
  validatorAddr: `0x${string}`;
  enclaveCommKey: `0x${string}`;
  round: number;
}) {
  const topic0 = keccak256(
    toBytes(
      "Registered(bytes,uint32,address,bytes32,bytes,bytes,bytes32,uint256,bytes32,bytes)",
    ),
  );
  const topic1 = padHex(opts.validatorAddr, { size: 32 });

  const data = encodeAbiParameters(
    [
      { name: "enclaveReport", type: "bytes" },
      { name: "round", type: "uint32" },
      { name: "enclaveType", type: "bytes32" },
      { name: "enclaveCommKey", type: "bytes" },
      { name: "dkgPubKey", type: "bytes" },
      { name: "codeCommitment", type: "bytes32" },
      { name: "startBlockHeight", type: "uint256" },
      { name: "startBlockHash", type: "bytes32" },
      { name: "validationContext", type: "bytes" },
    ],
    [
      "0x",
      opts.round,
      "0x0000000000000000000000000000000000000000000000000000000000000000",
      opts.enclaveCommKey,
      "0x",
      "0x0000000000000000000000000000000000000000000000000000000000000000",
      0n,
      "0x0000000000000000000000000000000000000000000000000000000000000000",
      "0x",
    ],
  );

  return {
    address: "0xcccccc0000000000000000000000000000000004" as `0x${string}`,
    topics: [topic0, topic1] as [`0x${string}`, `0x${string}`],
    data,
    blockHash: "0x0000000000000000000000000000000000000000000000000000000000000000" as `0x${string}`,
    blockNumber: 50n,
    transactionHash: "0x0000000000000000000000000000000000000000000000000000000000000002" as `0x${string}`,
    transactionIndex: 0,
    logIndex: 0,
    removed: false,
  };
}

describe("Consumer", () => {
  it("read sends tx with correct fee and requesterPubKey", async () => {
    const { publicClient, walletClient } = mockClients();
    publicClient.readContract.mockResolvedValueOnce(2000n); // readFee
    walletClient.writeContract.mockResolvedValueOnce("0xtxhash");

    const consumer = new Consumer({
      network: "testnet",
      publicClient,
      walletClient,
    });

    const result = await consumer.read({
      uuid: 1,
      accessAuxData: "0x",
      requesterPubKey: "0xaabbccdd",
    });

    expect(result.txHash).toBe("0xtxhash");
    const callArgs = walletClient.writeContract.mock.calls[0][0];
    expect(callArgs.value).toBe(2000n);
    expect(callArgs.functionName).toBe("read");
  });

  it("read uses feeOverride when provided and skips readContract", async () => {
    const { publicClient, walletClient } = mockClients();
    walletClient.writeContract.mockResolvedValueOnce("0xtxhash2");

    const consumer = new Consumer({
      network: "testnet",
      publicClient,
      walletClient,
    });

    const result = await consumer.read({
      uuid: 2,
      accessAuxData: "0x",
      requesterPubKey: "0xaabbccdd",
      feeOverride: 500n,
    });

    expect(result.txHash).toBe("0xtxhash2");
    const callArgs = walletClient.writeContract.mock.calls[0][0];
    expect(callArgs.value).toBe(500n);
    expect(publicClient.readContract).not.toHaveBeenCalled();
  });

  it("collectPartials polls until minPartials reached", async () => {
    const { publicClient, walletClient } = mockClients();
    vi.mocked(verifyPartialSignature).mockReturnValue(true);

    // Return incrementing block numbers so the condition `currentBlock >= lastScannedBlock`
    // stays true on each poll and getLogs is called every iteration.
    publicClient.getBlockNumber
      .mockResolvedValueOnce(100n)
      .mockResolvedValueOnce(101n)
      .mockResolvedValue(102n);

    // First call: DKG Registered events. Second poll: no CDR logs. Third poll: 3 CDR logs.
    // Default fallback: empty array so any extra calls don't return undefined.
    publicClient.getLogs
      .mockResolvedValueOnce([
        makeRegisteredLog({ validatorAddr: "0x0000000000000000000000000000000000000001", enclaveCommKey: ("0x" + "aa".repeat(64)) as `0x${string}`, round: 1 }),
        makeRegisteredLog({ validatorAddr: "0x0000000000000000000000000000000000000002", enclaveCommKey: ("0x" + "bb".repeat(64)) as `0x${string}`, round: 1 }),
        makeRegisteredLog({ validatorAddr: "0x0000000000000000000000000000000000000003", enclaveCommKey: ("0x" + "cc".repeat(64)) as `0x${string}`, round: 1 }),
      ])
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([
        makePartialDecryptionLog({ validator: "0x0000000000000000000000000000000000000001", round: 1, pid: 1, uuid: 1 }),
        makePartialDecryptionLog({ validator: "0x0000000000000000000000000000000000000002", round: 1, pid: 2, uuid: 1 }),
        makePartialDecryptionLog({ validator: "0x0000000000000000000000000000000000000003", round: 1, pid: 3, uuid: 1 }),
      ])
      .mockResolvedValue([]);

    const consumer = new Consumer({
      network: "testnet",
      publicClient,
      walletClient,
    });

    const partials = await consumer.collectPartials({
      uuid: 1,
      minPartials: 3,
      fromBlock: 90n,
      timeoutMs: 10_000,
      pollIntervalMs: 50,
    });

    expect(partials).toHaveLength(3);
    expect(partials[0].pid).toBe(1);
    expect(partials[1].pid).toBe(2);
    expect(partials[2].pid).toBe(3);
  });

  it("collectPartials deduplicates events from the same validator+pid", async () => {
    const { publicClient, walletClient } = mockClients();
    vi.mocked(verifyPartialSignature).mockReturnValue(true);

    // Incrementing block numbers so getLogs is called every iteration.
    publicClient.getBlockNumber.mockResolvedValueOnce(100n).mockResolvedValue(101n);

    // First call: DKG Registered events. Then CDR logs with duplicates.
    publicClient.getLogs
      .mockResolvedValueOnce([
        makeRegisteredLog({ validatorAddr: "0x0000000000000000000000000000000000000001", enclaveCommKey: ("0x" + "aa".repeat(64)) as `0x${string}`, round: 1 }),
        makeRegisteredLog({ validatorAddr: "0x0000000000000000000000000000000000000002", enclaveCommKey: ("0x" + "bb".repeat(64)) as `0x${string}`, round: 1 }),
      ])
      .mockResolvedValueOnce([
        makePartialDecryptionLog({ validator: "0x0000000000000000000000000000000000000001", round: 1, pid: 1, uuid: 5 }),
        makePartialDecryptionLog({ validator: "0x0000000000000000000000000000000000000001", round: 1, pid: 1, uuid: 5 }),
        makePartialDecryptionLog({ validator: "0x0000000000000000000000000000000000000002", round: 1, pid: 2, uuid: 5 }),
      ])
      .mockResolvedValue([]);

    const consumer = new Consumer({
      network: "testnet",
      publicClient,
      walletClient,
    });

    const partials = await consumer.collectPartials({
      uuid: 5,
      minPartials: 2,
      fromBlock: 90n,
      timeoutMs: 10_000,
      pollIntervalMs: 50,
    });

    expect(partials).toHaveLength(2);
  });

  it("collectPartials ignores events for a different uuid", async () => {
    const { publicClient, walletClient } = mockClients();
    vi.mocked(verifyPartialSignature).mockReturnValue(true);

    // Incrementing block numbers so getLogs is called every iteration.
    publicClient.getBlockNumber
      .mockResolvedValueOnce(100n)
      .mockResolvedValueOnce(101n)
      .mockResolvedValue(102n);

    // First call: DKG Registered events. Then CDR logs with wrong/right uuid.
    publicClient.getLogs
      .mockResolvedValueOnce([
        makeRegisteredLog({ validatorAddr: "0x0000000000000000000000000000000000000001", enclaveCommKey: ("0x" + "aa".repeat(64)) as `0x${string}`, round: 1 }),
      ])
      .mockResolvedValueOnce([
        makePartialDecryptionLog({ validator: "0x0000000000000000000000000000000000000001", round: 1, pid: 1, uuid: 99 }),
      ])
      .mockResolvedValueOnce([
        makePartialDecryptionLog({ validator: "0x0000000000000000000000000000000000000001", round: 1, pid: 1, uuid: 1 }),
      ])
      .mockResolvedValue([]);

    const consumer = new Consumer({
      network: "testnet",
      publicClient,
      walletClient,
    });

    const partials = await consumer.collectPartials({
      uuid: 1,
      minPartials: 1,
      fromBlock: 90n,
      timeoutMs: 10_000,
      pollIntervalMs: 50,
    });

    expect(partials).toHaveLength(1);
    expect(partials[0].uuid).toBe(1);
  });

  it("collectPartials throws PartialCollectionTimeoutError when deadline expires", async () => {
    const { publicClient, walletClient } = mockClients();
    vi.mocked(verifyPartialSignature).mockReturnValue(true);

    // Always return an incrementing block so getLogs is always called, but no logs.
    let block = 100n;
    publicClient.getBlockNumber.mockImplementation(() => Promise.resolve(block++));
    // First call: DKG Registered (empty). Rest: empty CDR logs.
    publicClient.getLogs.mockResolvedValueOnce([]).mockResolvedValue([]);

    const consumer = new Consumer({
      network: "testnet",
      publicClient,
      walletClient,
    });

    await expect(
      consumer.collectPartials({
        uuid: 1,
        minPartials: 3,
        fromBlock: 90n,
        timeoutMs: 100,   // very short timeout
        pollIntervalMs: 10,
      }),
    ).rejects.toThrow("Timed out collecting partials after 100ms: got 0/3");
  });

  it("collectPartials verifies signatures and accepts valid partials", async () => {
    const { publicClient, walletClient } = mockClients();
    const mockVerify = vi.mocked(verifyPartialSignature);
    mockVerify.mockReset();
    mockVerify.mockReturnValue(true);

    publicClient.getBlockNumber.mockResolvedValueOnce(100n).mockResolvedValue(101n);

    publicClient.getLogs
      .mockResolvedValueOnce([
        makeRegisteredLog({
          validatorAddr: "0x0000000000000000000000000000000000000001",
          enclaveCommKey: ("0x" + "aa".repeat(64)) as `0x${string}`,
          round: 1,
        }),
      ])
      .mockResolvedValueOnce([
        makePartialDecryptionLog({ validator: "0x0000000000000000000000000000000000000001", round: 1, pid: 1, uuid: 1 }),
      ])
      .mockResolvedValue([]);

    const consumer = new Consumer({ network: "testnet", publicClient, walletClient });
    const partials = await consumer.collectPartials({
      uuid: 1,
      minPartials: 1,
      fromBlock: 90n,
      timeoutMs: 5_000,
      pollIntervalMs: 50,
    });

    expect(partials).toHaveLength(1);
    expect(mockVerify).toHaveBeenCalledOnce();
  });

  it("collectPartials rejects invalid signatures and invokes callback", async () => {
    const { publicClient, walletClient } = mockClients();
    const mockVerify = vi.mocked(verifyPartialSignature);
    mockVerify.mockReset();
    mockVerify.mockReturnValueOnce(false).mockReturnValue(true);

    publicClient.getBlockNumber.mockResolvedValueOnce(100n).mockResolvedValue(101n);

    publicClient.getLogs
      .mockResolvedValueOnce([
        makeRegisteredLog({
          validatorAddr: "0x0000000000000000000000000000000000000001",
          enclaveCommKey: ("0x" + "aa".repeat(64)) as `0x${string}`,
          round: 1,
        }),
        makeRegisteredLog({
          validatorAddr: "0x0000000000000000000000000000000000000002",
          enclaveCommKey: ("0x" + "bb".repeat(64)) as `0x${string}`,
          round: 1,
        }),
      ])
      .mockResolvedValueOnce([
        makePartialDecryptionLog({ validator: "0x0000000000000000000000000000000000000001", round: 1, pid: 1, uuid: 1 }),
        makePartialDecryptionLog({ validator: "0x0000000000000000000000000000000000000002", round: 1, pid: 2, uuid: 1 }),
      ])
      .mockResolvedValue([]);

    const onInvalidPartial = vi.fn();
    const consumer = new Consumer({ network: "testnet", publicClient, walletClient });
    const partials = await consumer.collectPartials({
      uuid: 1,
      minPartials: 1,
      fromBlock: 90n,
      timeoutMs: 5_000,
      pollIntervalMs: 50,
      onInvalidPartial,
    });

    expect(partials).toHaveLength(1);
    expect(partials[0].pid).toBe(2);
    expect(onInvalidPartial).toHaveBeenCalledOnce();
    expect(onInvalidPartial.mock.calls[0][0].pid).toBe(1);
    expect(onInvalidPartial.mock.calls[0][1]).toBeInstanceOf(Error);
  });

  it("collectPartials skips partials from unknown validators", async () => {
    const { publicClient, walletClient } = mockClients();
    const mockVerify = vi.mocked(verifyPartialSignature);
    mockVerify.mockReset();
    mockVerify.mockReturnValue(true);

    publicClient.getBlockNumber.mockResolvedValueOnce(100n).mockResolvedValue(101n);

    publicClient.getLogs
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([
        makePartialDecryptionLog({ validator: "0x0000000000000000000000000000000000000001", round: 1, pid: 1, uuid: 1 }),
      ])
      .mockResolvedValue([]);

    const onInvalidPartial = vi.fn();
    const consumer = new Consumer({ network: "testnet", publicClient, walletClient });

    await expect(
      consumer.collectPartials({
        uuid: 1,
        minPartials: 1,
        fromBlock: 90n,
        timeoutMs: 200,
        pollIntervalMs: 50,
        onInvalidPartial,
      }),
    ).rejects.toThrow("Timed out");

    expect(onInvalidPartial).toHaveBeenCalledOnce();
    expect(onInvalidPartial.mock.calls[0][1].message).toContain("unknown validator");
  });

  it("collectPartials silently skips invalid partials when no callback provided", async () => {
    const { publicClient, walletClient } = mockClients();
    const mockVerify = vi.mocked(verifyPartialSignature);
    mockVerify.mockReset();
    mockVerify.mockReturnValueOnce(false).mockReturnValue(true);

    publicClient.getBlockNumber.mockResolvedValueOnce(100n).mockResolvedValue(101n);

    publicClient.getLogs
      .mockResolvedValueOnce([
        makeRegisteredLog({
          validatorAddr: "0x0000000000000000000000000000000000000001",
          enclaveCommKey: ("0x" + "aa".repeat(64)) as `0x${string}`,
          round: 1,
        }),
        makeRegisteredLog({
          validatorAddr: "0x0000000000000000000000000000000000000002",
          enclaveCommKey: ("0x" + "bb".repeat(64)) as `0x${string}`,
          round: 1,
        }),
      ])
      .mockResolvedValueOnce([
        makePartialDecryptionLog({ validator: "0x0000000000000000000000000000000000000001", round: 1, pid: 1, uuid: 1 }),
        makePartialDecryptionLog({ validator: "0x0000000000000000000000000000000000000002", round: 1, pid: 2, uuid: 1 }),
      ])
      .mockResolvedValue([]);

    const consumer = new Consumer({ network: "testnet", publicClient, walletClient });
    const partials = await consumer.collectPartials({
      uuid: 1,
      minPartials: 1,
      fromBlock: 90n,
      timeoutMs: 5_000,
      pollIntervalMs: 50,
    });

    expect(partials).toHaveLength(1);
    expect(partials[0].pid).toBe(2);
  });
});
