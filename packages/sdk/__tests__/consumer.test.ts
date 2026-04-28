import { describe, it, expect, vi, beforeEach } from "vitest";
import { encodeAbiParameters, keccak256, toBytes, padHex } from "viem";

// Mock @piplabs/cdr-crypto before importing Consumer so the WASM loader is never executed.
vi.mock("@piplabs/cdr-crypto", () => ({
  decryptPartial: vi.fn(),
  tdh2Combine: vi.fn(),
  verifyPartialSignature: vi.fn(),
}));

// Mock the cosmos ABCI query so the hybrid path is exercised without a live RPC.
// queryDKGParams must be in the factory too: Observer.getLookbackBlocks()
// invokes it to derive the EVM event-scan window. If it is absent, the import
// resolves to undefined at runtime, the catch in getLookbackBlocks silently
// swallows the error, and every test transparently falls back to
// Observer.DEFAULT_LOOKBACK_BLOCKS instead of exercising the dynamic formula.
vi.mock("../src/cosmos/abci-query.js", () => ({
  queryCDRPartials: vi.fn(),
  queryLatestActiveDKGNetwork: vi.fn(),
  queryVerifiedRegistrations: vi.fn(),
  queryDKGParams: vi.fn(),
}));

import { Consumer } from "../src/consumer.js";
import { Observer } from "../src/observer.js";
import { verifyPartialSignature } from "@piplabs/cdr-crypto";
import { queryLatestActiveDKGNetwork, queryDKGParams } from "../src/cosmos/abci-query.js";

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
    const KEY_A = ("0x" + "aa".repeat(64)) as `0x${string}`;
    const KEY_B = ("0x" + "bb".repeat(64)) as `0x${string}`;
    const mockVerify = vi.mocked(verifyPartialSignature);
    mockVerify.mockReset();
    // Deterministically accept only KEY_B; accept/reject follows the key, not call
    // order, so the one-shot refresh on verification failure (for validator A)
    // sees the same stable map and still rejects.
    mockVerify.mockImplementation((args: any) => {
      const kB = toBytes(KEY_B);
      return args.commPubKey.length === kB.length && [...args.commPubKey].every((b, i) => b === kB[i]);
    });

    publicClient.getBlockNumber.mockResolvedValueOnce(100n).mockResolvedValue(101n);

    const dkgLogs = [
      makeRegisteredLog({
        validatorAddr: "0x0000000000000000000000000000000000000001",
        enclaveCommKey: KEY_A,
        round: 1,
      }),
      makeRegisteredLog({
        validatorAddr: "0x0000000000000000000000000000000000000002",
        enclaveCommKey: KEY_B,
        round: 1,
      }),
    ];
    let cdrPoll = 0;
    publicClient.getLogs.mockImplementation(async (params: any) => {
      if (params.address === "0xcccccc0000000000000000000000000000000004") return dkgLogs;
      return cdrPoll++ === 0
        ? [
            makePartialDecryptionLog({ validator: "0x0000000000000000000000000000000000000001", round: 1, pid: 1, uuid: 1 }),
            makePartialDecryptionLog({ validator: "0x0000000000000000000000000000000000000002", round: 1, pid: 2, uuid: 1 }),
          ]
        : [];
    });

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
    const KEY_A = ("0x" + "aa".repeat(64)) as `0x${string}`;
    const KEY_B = ("0x" + "bb".repeat(64)) as `0x${string}`;
    const mockVerify = vi.mocked(verifyPartialSignature);
    mockVerify.mockReset();
    mockVerify.mockImplementation((args: any) => {
      const kB = toBytes(KEY_B);
      return args.commPubKey.length === kB.length && [...args.commPubKey].every((b, i) => b === kB[i]);
    });

    publicClient.getBlockNumber.mockResolvedValueOnce(100n).mockResolvedValue(101n);

    const dkgLogs = [
      makeRegisteredLog({
        validatorAddr: "0x0000000000000000000000000000000000000001",
        enclaveCommKey: KEY_A,
        round: 1,
      }),
      makeRegisteredLog({
        validatorAddr: "0x0000000000000000000000000000000000000002",
        enclaveCommKey: KEY_B,
        round: 1,
      }),
    ];
    let cdrPoll = 0;
    publicClient.getLogs.mockImplementation(async (params: any) => {
      if (params.address === "0xcccccc0000000000000000000000000000000004") return dkgLogs;
      return cdrPoll++ === 0
        ? [
            makePartialDecryptionLog({ validator: "0x0000000000000000000000000000000000000001", round: 1, pid: 1, uuid: 1 }),
            makePartialDecryptionLog({ validator: "0x0000000000000000000000000000000000000002", round: 1, pid: 2, uuid: 1 }),
          ]
        : [];
    });

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

  describe("commPubKey map caching and chunked scan", () => {
    // Reset the ABCI mock between tests so state from one hybrid-mode test
    // (e.g. mockRejectedValue) doesn't leak into the next and hang it.
    // Default behavior: reject so non-hybrid tests don't accidentally hit a
    // live mock — they should continue working via the ABCI-failure fallback.
    beforeEach(() => {
      vi.mocked(queryLatestActiveDKGNetwork).mockReset();
      vi.mocked(queryLatestActiveDKGNetwork).mockRejectedValue(
        new Error("ABCI not mocked for this test — fallback expected"),
      );
    });

    const DKG_ADDR = "0xcccccc0000000000000000000000000000000004";
    const CDR_ADDR = "0xcccccc0000000000000000000000000000000005";
    const VALIDATOR_A = "0x0000000000000000000000000000000000000001" as `0x${string}`;
    const VALIDATOR_B = "0x0000000000000000000000000000000000000002" as `0x${string}`;
    const KEY_A = ("0x" + "aa".repeat(64)) as `0x${string}`;
    const KEY_B = ("0x" + "bb".repeat(64)) as `0x${string}`;
    const KEY_A_ROUND6 = ("0x" + "a6".repeat(64)) as `0x${string}`;

    function makeObserverWithComet(publicClient: any, cometRpcUrl: string): Observer {
      // Observer constructor requires cometRpcUrl only when dkgSource === "cosmos-abci".
      // We pass "evm-events" here so the Observer itself stays on EVM but still carries
      // a non-empty cometRpcUrl that the Consumer's hybrid path can pick up.
      return new Observer({
        network: "testnet",
        publicClient: publicClient as any,
        dkgSource: "evm-events",
        cometRpcUrl,
      });
    }

    /** Count how many times publicClient.getLogs was called against the DKG contract. */
    function dkgScanCount(publicClient: any): number {
      return publicClient.getLogs.mock.calls.filter(
        (c: any[]) => c[0].address === DKG_ADDR,
      ).length;
    }

    it("prefetchRegistry warms the cache so subsequent collectPartials does not scan DKG again", async () => {
      const { publicClient, walletClient } = mockClients();
      vi.mocked(verifyPartialSignature).mockReturnValue(true);
      publicClient.getBlockNumber.mockResolvedValue(100n);

      publicClient.getLogs.mockImplementation(async (params: any) => {
        if (params.address === DKG_ADDR) {
          return [makeRegisteredLog({ validatorAddr: VALIDATOR_A, enclaveCommKey: KEY_A, round: 1 })];
        }
        return [makePartialDecryptionLog({ validator: VALIDATOR_A, round: 1, pid: 1, uuid: 60 })];
      });

      const consumer = new Consumer({ network: "testnet", publicClient, walletClient });

      await consumer.prefetchRegistry();
      expect(dkgScanCount(publicClient)).toBe(1);

      await consumer.collectPartials({
        uuid: 60,
        minPartials: 1,
        fromBlock: 90n,
        timeoutMs: 5_000,
        pollIntervalMs: 10,
      });
      // Still 1 — prefetch primed the cache, collectPartials reused it.
      expect(dkgScanCount(publicClient)).toBe(1);
    });

    it("prefetchRegistry is idempotent — concurrent calls share one scan", async () => {
      const { publicClient, walletClient } = mockClients();
      publicClient.getBlockNumber.mockResolvedValue(100n);

      let dkgCallCount = 0;
      publicClient.getLogs.mockImplementation(async () => {
        dkgCallCount++;
        await new Promise((r) => setTimeout(r, 30));
        return [makeRegisteredLog({ validatorAddr: VALIDATOR_A, enclaveCommKey: KEY_A, round: 1 })];
      });

      const consumer = new Consumer({ network: "testnet", publicClient, walletClient });
      await Promise.all([
        consumer.prefetchRegistry(),
        consumer.prefetchRegistry(),
        consumer.prefetchRegistry(),
      ]);

      expect(dkgCallCount).toBe(1);
    });

    it("hybrid mode: queries ABCI for active round and filters Registered events to that round", async () => {
      const { publicClient, walletClient } = mockClients();
      vi.mocked(verifyPartialSignature).mockReturnValue(true);
      vi.mocked(queryLatestActiveDKGNetwork).mockClear();
      publicClient.getBlockNumber.mockResolvedValue(1_000_000n);

      // ABCI says active round is 6.
      vi.mocked(queryLatestActiveDKGNetwork).mockResolvedValue({
        round: 6,
        globalPublicKey: new Uint8Array(),
        threshold: 3,
      } as any);

      const dkgRegistered = [
        // Round 5 registrations (should be filtered out in hybrid mode).
        makeRegisteredLog({ validatorAddr: VALIDATOR_A, enclaveCommKey: KEY_A, round: 5 }),
        makeRegisteredLog({ validatorAddr: VALIDATOR_B, enclaveCommKey: KEY_B, round: 5 }),
        // Round 6 registrations (active — these should be kept).
        makeRegisteredLog({ validatorAddr: VALIDATOR_A, enclaveCommKey: KEY_A_ROUND6, round: 6 }),
      ];
      publicClient.getLogs.mockImplementation(async (params: any) => {
        if (params.address === DKG_ADDR) return dkgRegistered;
        // Partial signed under round 6 (matches active) — verify path runs through the map.
        return [makePartialDecryptionLog({ validator: VALIDATOR_A, round: 6, pid: 1, uuid: 100 })];
      });

      const observer = makeObserverWithComet(publicClient, "http://172.192.41.96:26657");
      const consumer = new Consumer({ network: "testnet", publicClient, walletClient, observer });

      const partials = await consumer.collectPartials({
        uuid: 100,
        minPartials: 1,
        fromBlock: 990_000n,
        timeoutMs: 2_000,
        pollIntervalMs: 10,
      });

      // ABCI was consulted exactly once per cache build.
      expect(queryLatestActiveDKGNetwork).toHaveBeenCalledTimes(1);
      expect(queryLatestActiveDKGNetwork).toHaveBeenCalledWith("http://172.192.41.96:26657");
      // Partial from round 6 was accepted (signature mock returns true).
      expect(partials).toHaveLength(1);
      // verifyPartialSignature was called with the ROUND 6 key only.
      const verifyCall = vi.mocked(verifyPartialSignature).mock.calls.find(
        (c: any[]) => c[0].round === 6,
      );
      expect(verifyCall).toBeDefined();
      // The commPubKey passed in must equal the round-6 key, not the round-5 one.
      const passedKey = verifyCall![0].commPubKey;
      const round6Bytes = toBytes(KEY_A_ROUND6);
      expect(passedKey.length).toBe(round6Bytes.length);
      expect([...passedKey]).toEqual([...round6Bytes]);
    });

    it("hybrid mode: when ABCI query fails, falls back to keeping all rounds (graceful degradation)", async () => {
      const { publicClient, walletClient } = mockClients();
      vi.mocked(verifyPartialSignature).mockReturnValue(true);
      publicClient.getBlockNumber.mockResolvedValue(1_000_000n);

      // ABCI rejects — hybrid path should swallow the error and scan without filtering.
      vi.mocked(queryLatestActiveDKGNetwork).mockRejectedValue(new Error("ABCI unavailable"));

      publicClient.getLogs.mockImplementation(async (params: any) => {
        if (params.address === DKG_ADDR) {
          return [
            makeRegisteredLog({ validatorAddr: VALIDATOR_A, enclaveCommKey: KEY_A, round: 5 }),
            makeRegisteredLog({ validatorAddr: VALIDATOR_A, enclaveCommKey: KEY_A_ROUND6, round: 6 }),
          ];
        }
        return [makePartialDecryptionLog({ validator: VALIDATOR_A, round: 5, pid: 1, uuid: 101 })];
      });

      const observer = makeObserverWithComet(publicClient, "http://bad-host:26657");
      const consumer = new Consumer({ network: "testnet", publicClient, walletClient, observer });

      const partials = await consumer.collectPartials({
        uuid: 101,
        minPartials: 1,
        fromBlock: 990_000n,
        timeoutMs: 2_000,
        pollIntervalMs: 10,
      });

      // Even though ABCI failed, the partial (round 5) still verifies because we kept
      // both rounds' keys — the verify loop finds the round-5 match.
      expect(partials).toHaveLength(1);
    });

    // TODO(Step 2 — REST migration): the "default CometBFT URL warning" tests
    // were removed when Observer dropped getDKGParams/getLookbackBlocks. The
    // plaintext-HTTP warning lived in Observer.getDKGParams; both are gone in
    // the REST cut-over. Reinstate equivalent warnings (or assert their
    // absence) once Step 2 fully replaces consumer's cosmos-abci paths.

    it("does not warn when the caller supplies an explicit cometRpcUrl", async () => {
      const { publicClient, walletClient } = mockClients();
      vi.mocked(verifyPartialSignature).mockReturnValue(true);
      vi.mocked(queryLatestActiveDKGNetwork).mockResolvedValue({
        round: 1, globalPublicKey: new Uint8Array(), threshold: 3,
      } as any);
      publicClient.getBlockNumber.mockResolvedValue(100n);
      publicClient.getLogs.mockImplementation(async (params: any) => {
        if (params.address === DKG_ADDR) {
          return [makeRegisteredLog({ validatorAddr: VALIDATOR_A, enclaveCommKey: KEY_A, round: 1 })];
        }
        return [makePartialDecryptionLog({ validator: VALIDATOR_A, round: 1, pid: 1, uuid: 71 })];
      });

      const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
      try {
        const observer = makeObserverWithComet(publicClient, "https://my-own-cometbft.example:26657");
        const consumer = new Consumer({ network: "testnet", publicClient, walletClient, observer });
        await consumer.collectPartials({ uuid: 71, minPartials: 1, fromBlock: 90n, timeoutMs: 5_000, pollIntervalMs: 10 });

        const defaultWarnings = warnSpy.mock.calls.filter(
          (c) => typeof c[0] === "string" && c[0].includes("default CometBFT RPC URL"),
        );
        expect(defaultWarnings).toHaveLength(0);
      } finally {
        warnSpy.mockRestore();
      }
    });

    it("hybrid mode default: no observer → SDK still consults the default CometBFT URL", async () => {
      const { publicClient, walletClient } = mockClients();
      vi.mocked(verifyPartialSignature).mockReturnValue(true);
      vi.mocked(queryLatestActiveDKGNetwork).mockClear();
      // Default ABCI URL is reachable and reports active round = 6.
      vi.mocked(queryLatestActiveDKGNetwork).mockResolvedValue({
        round: 6,
        globalPublicKey: new Uint8Array(),
        threshold: 3,
      } as any);
      publicClient.getBlockNumber.mockResolvedValue(1_000_000n);

      publicClient.getLogs.mockImplementation(async (params: any) => {
        if (params.address === DKG_ADDR) {
          return [
            makeRegisteredLog({ validatorAddr: VALIDATOR_A, enclaveCommKey: KEY_A, round: 5 }),
            makeRegisteredLog({ validatorAddr: VALIDATOR_A, enclaveCommKey: KEY_A_ROUND6, round: 6 }),
          ];
        }
        return [makePartialDecryptionLog({ validator: VALIDATOR_A, round: 6, pid: 1, uuid: 102 })];
      });

      // No observer passed — SDK should fall back to the hardcoded default URL.
      const consumer = new Consumer({ network: "testnet", publicClient, walletClient });

      const partials = await consumer.collectPartials({
        uuid: 102,
        minPartials: 1,
        fromBlock: 990_000n,
        timeoutMs: 2_000,
        pollIntervalMs: 10,
      });

      // ABCI was consulted once using the SDK's default URL (not user-supplied).
      expect(queryLatestActiveDKGNetwork).toHaveBeenCalledTimes(1);
      expect(queryLatestActiveDKGNetwork).toHaveBeenCalledWith(
        "http://172.192.41.96:26657",
      );
      expect(partials).toHaveLength(1);
    });

    it("reuses the cached commPubKey map across back-to-back collectPartials calls", async () => {
      const { publicClient, walletClient } = mockClients();
      vi.mocked(verifyPartialSignature).mockReturnValue(true);

      // Chain head stays at 100 so DKG scan is a single chunk.
      publicClient.getBlockNumber.mockResolvedValue(100n);

      // DKG scan response (call 1, shared by both collectPartials invocations)
      const dkgRegistered = [
        makeRegisteredLog({ validatorAddr: VALIDATOR_A, enclaveCommKey: KEY_A, round: 1 }),
      ];
      // Each collectPartials call: 1 DKG scan (only on first) + CDR polls
      publicClient.getLogs.mockImplementation(async (params: any) => {
        if (params.address === DKG_ADDR) return dkgRegistered;
        // CDR: return one matching partial per uuid
        const uuidFromCall = (publicClient.getLogs as any).mock.calls.length;
        return [
          makePartialDecryptionLog({
            validator: VALIDATOR_A,
            round: 1,
            pid: 1,
            uuid: uuidFromCall < 3 ? 10 : 11,
          }),
        ];
      });

      const consumer = new Consumer({ network: "testnet", publicClient, walletClient });

      await consumer.collectPartials({
        uuid: 10,
        minPartials: 1,
        fromBlock: 90n,
        timeoutMs: 5_000,
        pollIntervalMs: 10,
      });
      expect(dkgScanCount(publicClient)).toBe(1);

      await consumer.collectPartials({
        uuid: 11,
        minPartials: 1,
        fromBlock: 90n,
        timeoutMs: 5_000,
        pollIntervalMs: 10,
      });
      // Still 1 — cache hit on second call.
      expect(dkgScanCount(publicClient)).toBe(1);
    });

    it("refreshes the cache once when a partial from an unknown validator appears", async () => {
      const { publicClient, walletClient } = mockClients();
      vi.mocked(verifyPartialSignature).mockReturnValue(true);
      publicClient.getBlockNumber.mockResolvedValue(100n);

      let dkgCallCount = 0;
      publicClient.getLogs.mockImplementation(async (params: any) => {
        if (params.address === DKG_ADDR) {
          dkgCallCount++;
          // First scan: only validator A. Second scan (refresh): also validator B.
          return dkgCallCount === 1
            ? [makeRegisteredLog({ validatorAddr: VALIDATOR_A, enclaveCommKey: KEY_A, round: 1 })]
            : [
                makeRegisteredLog({ validatorAddr: VALIDATOR_A, enclaveCommKey: KEY_A, round: 1 }),
                makeRegisteredLog({ validatorAddr: VALIDATOR_B, enclaveCommKey: KEY_B, round: 1 }),
              ];
        }
        // CDR scan: partial from validator B (unknown on first DKG scan).
        return [makePartialDecryptionLog({ validator: VALIDATOR_B, round: 1, pid: 1, uuid: 7 })];
      });

      const consumer = new Consumer({ network: "testnet", publicClient, walletClient });
      const partials = await consumer.collectPartials({
        uuid: 7,
        minPartials: 1,
        fromBlock: 90n,
        timeoutMs: 5_000,
        pollIntervalMs: 10,
      });

      // Refresh happened exactly once.
      expect(dkgCallCount).toBe(2);
      // Validator B's partial was accepted after refresh.
      expect(partials).toHaveLength(1);
      expect(partials[0].validator.toLowerCase()).toBe(VALIDATOR_B.toLowerCase());
    });

    it("refreshes once when a DKG rotation leaves every cached key stale", async () => {
      // Scenario: cache built under round 5 (KEY_A), then rotation → active round 6
      // (KEY_A_ROUND6). Partial comes in signed under round 6. The pre-fix code only
      // refreshed when a validator was absent from the map, so stale-but-present keys
      // silently dropped every partial. With the fix, verification failure against
      // cached keys triggers a one-shot refresh, after which the round-6 key matches.
      const { publicClient, walletClient } = mockClients();
      publicClient.getBlockNumber.mockResolvedValue(100n);

      // ABCI reports round 5 on first build, round 6 on refresh.
      vi.mocked(queryLatestActiveDKGNetwork)
        .mockResolvedValueOnce({ round: 5, globalPublicKey: new Uint8Array(), threshold: 3 } as any)
        .mockResolvedValue({ round: 6, globalPublicKey: new Uint8Array(), threshold: 3 } as any);

      let dkgScanNo = 0;
      publicClient.getLogs.mockImplementation(async (params: any) => {
        if (params.address === DKG_ADDR) {
          dkgScanNo++;
          // First scan: only the round-5 registration is returned (hybrid filter keeps it).
          // Second scan (refresh): chain now shows both rounds; hybrid filter keeps only round-6.
          return dkgScanNo === 1
            ? [makeRegisteredLog({ validatorAddr: VALIDATOR_A, enclaveCommKey: KEY_A, round: 5 })]
            : [
                makeRegisteredLog({ validatorAddr: VALIDATOR_A, enclaveCommKey: KEY_A, round: 5 }),
                makeRegisteredLog({ validatorAddr: VALIDATOR_A, enclaveCommKey: KEY_A_ROUND6, round: 6 }),
              ];
        }
        return [makePartialDecryptionLog({ validator: VALIDATOR_A, round: 6, pid: 1, uuid: 60 })];
      });

      // verifyPartialSignature returns true only for the round-6 key; false for anything else.
      vi.mocked(verifyPartialSignature).mockImplementation((args: any) => {
        const round6 = toBytes(KEY_A_ROUND6);
        return args.commPubKey.length === round6.length &&
          [...args.commPubKey].every((b, i) => b === round6[i]);
      });

      const observer = makeObserverWithComet(publicClient, "http://abci-mock:26657");
      const consumer = new Consumer({ network: "testnet", publicClient, walletClient, observer });

      const partials = await consumer.collectPartials({
        uuid: 60,
        minPartials: 1,
        fromBlock: 90n,
        timeoutMs: 5_000,
        pollIntervalMs: 10,
      });

      // Refresh happened exactly once; partial accepted after refresh.
      expect(dkgScanNo).toBe(2);
      expect(partials).toHaveLength(1);
    });

    it("does not re-refresh for the same validator on repeated verification failure", async () => {
      // Three partials from the same validator, all fail signature. The first failure
      // triggers a refresh; the next two must reuse the refreshed cache without
      // kicking off another full-history scan (refreshedFor deduplication).
      const { publicClient, walletClient } = mockClients();
      publicClient.getBlockNumber.mockResolvedValue(100n);
      vi.mocked(verifyPartialSignature).mockReturnValue(false);

      let dkgScanNo = 0;
      const onInvalidPartial = vi.fn();
      publicClient.getLogs.mockImplementation(async (params: any) => {
        if (params.address === DKG_ADDR) {
          dkgScanNo++;
          return [makeRegisteredLog({ validatorAddr: VALIDATOR_A, enclaveCommKey: KEY_A, round: 1 })];
        }
        return [
          makePartialDecryptionLog({ validator: VALIDATOR_A, round: 1, pid: 1, uuid: 61 }),
          makePartialDecryptionLog({ validator: VALIDATOR_A, round: 1, pid: 2, uuid: 61 }),
          makePartialDecryptionLog({ validator: VALIDATOR_A, round: 1, pid: 3, uuid: 61 }),
        ];
      });

      const consumer = new Consumer({ network: "testnet", publicClient, walletClient });
      await expect(
        consumer.collectPartials({
          uuid: 61,
          minPartials: 1,
          fromBlock: 90n,
          timeoutMs: 300,
          pollIntervalMs: 50,
          onInvalidPartial,
        }),
      ).rejects.toThrow();

      // Initial build + 1 refresh (triggered by first failed verify). Not 4.
      expect(dkgScanNo).toBe(2);
      expect(onInvalidPartial.mock.calls.length).toBeGreaterThanOrEqual(3);
    });

    it("does not re-refresh for the same unknown validator within one call", async () => {
      const { publicClient, walletClient } = mockClients();
      vi.mocked(verifyPartialSignature).mockReturnValue(true);
      publicClient.getBlockNumber.mockResolvedValue(100n);

      let dkgCallCount = 0;
      const onInvalidPartial = vi.fn();

      publicClient.getLogs.mockImplementation(async (params: any) => {
        if (params.address === DKG_ADDR) {
          dkgCallCount++;
          // Validator B never appears — refresh cannot add it.
          return [makeRegisteredLog({ validatorAddr: VALIDATOR_A, enclaveCommKey: KEY_A, round: 1 })];
        }
        // Three partials from the same unknown validator B.
        return [
          makePartialDecryptionLog({ validator: VALIDATOR_B, round: 1, pid: 1, uuid: 8 }),
          makePartialDecryptionLog({ validator: VALIDATOR_B, round: 1, pid: 2, uuid: 8 }),
          makePartialDecryptionLog({ validator: VALIDATOR_B, round: 1, pid: 3, uuid: 8 }),
        ];
      });

      const consumer = new Consumer({ network: "testnet", publicClient, walletClient });
      await expect(
        consumer.collectPartials({
          uuid: 8,
          minPartials: 1,
          fromBlock: 90n,
          timeoutMs: 300,
          pollIntervalMs: 50,
          onInvalidPartial,
        }),
      ).rejects.toThrow();

      // Exactly one refresh attempted (initial + 1), not three.
      expect(dkgCallCount).toBe(2);
      // All three partials reported as unknown validator.
      expect(onInvalidPartial.mock.calls.length).toBeGreaterThanOrEqual(3);
    });

    it("scans DKG history in contiguous non-overlapping chunks covering [latestBlock - lookback, latestBlock]", async () => {
      // The lookback now comes from Observer.getLookbackBlocks(), which
      // computes 2×(reg+deal+fin) + active from on-chain DKG params and
      // falls back to Observer.DEFAULT_LOOKBACK_BLOCKS (302_400n) when the
      // params query fails. The mocked queryDKGParams throws here, so the
      // fallback value applies.
      const LOOKBACK = 302_400n;
      // Any value > LOOKBACK exercises the main path (no clamp-to-0).
      const LATEST = 17_300_000n;
      const EXPECTED_START = LATEST - LOOKBACK;

      const { publicClient, walletClient } = mockClients();
      vi.mocked(verifyPartialSignature).mockReturnValue(true);
      publicClient.getBlockNumber.mockResolvedValue(LATEST);

      const chunks: { from: bigint; to: bigint }[] = [];
      publicClient.getLogs.mockImplementation(async (params: any) => {
        if (params.address === DKG_ADDR) {
          chunks.push({ from: params.fromBlock, to: params.toBlock });
          return [];
        }
        return [makePartialDecryptionLog({ validator: VALIDATOR_A, round: 1, pid: 1, uuid: 9 })];
      });

      const consumer = new Consumer({ network: "testnet", publicClient, walletClient });
      // Force cache build by invoking the flow; collectPartials will throw since
      // validator A isn't registered, but we only care about chunk coverage.
      await expect(
        consumer.collectPartials({
          uuid: 9,
          minPartials: 1,
          fromBlock: LATEST,
          timeoutMs: 200,
          pollIntervalMs: 50,
        }),
      ).rejects.toThrow();

      // LOOKBACK < DKG_LOGS_BLOCK_CHUNK (500_000n) → single chunk per scan.
      // Initial build (1) + one-shot refresh on unknown validator (1) = 2 calls.
      expect(chunks.length).toBe(2);

      // Both calls must cover exactly [LATEST - LOOKBACK, LATEST].
      for (const c of chunks) {
        expect(c.from).toBe(EXPECTED_START);
        expect(c.to).toBe(LATEST);
      }
    });

    it("deduplicates concurrent cache builds — only one scan runs", async () => {
      const { publicClient, walletClient } = mockClients();
      vi.mocked(verifyPartialSignature).mockReturnValue(true);
      publicClient.getBlockNumber.mockResolvedValue(100n);

      let dkgCallCount = 0;
      publicClient.getLogs.mockImplementation(async (params: any) => {
        if (params.address === DKG_ADDR) {
          dkgCallCount++;
          // Simulate a slow scan so a concurrent caller arrives during the in-flight build.
          await new Promise((r) => setTimeout(r, 50));
          return [makeRegisteredLog({ validatorAddr: VALIDATOR_A, enclaveCommKey: KEY_A, round: 1 })];
        }
        return [makePartialDecryptionLog({ validator: VALIDATOR_A, round: 1, pid: 1, uuid: 20 })];
      });

      const consumer = new Consumer({ network: "testnet", publicClient, walletClient });
      // Fire two collectPartials concurrently — both should observe one build.
      await Promise.all([
        consumer.collectPartials({ uuid: 20, minPartials: 1, fromBlock: 90n, timeoutMs: 5_000, pollIntervalMs: 10 }),
        consumer.collectPartials({ uuid: 20, minPartials: 1, fromBlock: 90n, timeoutMs: 5_000, pollIntervalMs: 10 }),
      ]);

      expect(dkgCallCount).toBe(1);
    });

    it("retries a transient CDR-poll getLogs failure and still collects partials", async () => {
      // Regression for PERF-05 flake: the partial-polling getLogs call used to
      // bypass the retry wrapper, so a single transient "invalid block range
      // params" from the public RPC would propagate all the way up as an
      // accessCDR failure. With the wrapper, one bad attempt is absorbed and
      // the poll loop keeps going.
      const { publicClient, walletClient } = mockClients();
      vi.mocked(verifyPartialSignature).mockReturnValue(true);
      publicClient.getBlockNumber.mockResolvedValue(100n);

      let cdrAttempt = 0;
      publicClient.getLogs.mockImplementation(async (params: any) => {
        if (params.address === DKG_ADDR) {
          return [makeRegisteredLog({ validatorAddr: VALIDATOR_A, enclaveCommKey: KEY_A, round: 1 })];
        }
        // CDR scan: first attempt fails with the exact error observed in e2e.
        cdrAttempt++;
        if (cdrAttempt === 1) {
          throw new Error("invalid block range params");
        }
        return [makePartialDecryptionLog({ validator: VALIDATOR_A, round: 1, pid: 1, uuid: 80 })];
      });

      const consumer = new Consumer({ network: "testnet", publicClient, walletClient });
      const partials = await consumer.collectPartials({
        uuid: 80,
        minPartials: 1,
        fromBlock: 90n,
        timeoutMs: 5_000,
        pollIntervalMs: 10,
      });

      // 1 transient failure + 1 successful retry.
      expect(cdrAttempt).toBe(2);
      expect(partials).toHaveLength(1);
    });

    it("retries a failing chunk with exponential backoff and succeeds on second attempt", async () => {
      const { publicClient, walletClient } = mockClients();
      vi.mocked(verifyPartialSignature).mockReturnValue(true);
      publicClient.getBlockNumber.mockResolvedValue(100n);

      let dkgAttempt = 0;
      publicClient.getLogs.mockImplementation(async (params: any) => {
        if (params.address === DKG_ADDR) {
          dkgAttempt++;
          if (dkgAttempt === 1) {
            throw new Error("invalid block range params");
          }
          return [makeRegisteredLog({ validatorAddr: VALIDATOR_A, enclaveCommKey: KEY_A, round: 1 })];
        }
        return [makePartialDecryptionLog({ validator: VALIDATOR_A, round: 1, pid: 1, uuid: 30 })];
      });

      const consumer = new Consumer({ network: "testnet", publicClient, walletClient });
      const partials = await consumer.collectPartials({
        uuid: 30,
        minPartials: 1,
        fromBlock: 90n,
        timeoutMs: 5_000,
        pollIntervalMs: 10,
      });

      expect(dkgAttempt).toBe(2);
      expect(partials).toHaveLength(1);
    });

    it("propagates the error after exhausting getLogs retries", async () => {
      const { publicClient, walletClient } = mockClients();
      publicClient.getBlockNumber.mockResolvedValue(100n);

      publicClient.getLogs.mockRejectedValue(new Error("persistent RPC failure"));

      const consumer = new Consumer({ network: "testnet", publicClient, walletClient });
      await expect(
        consumer.collectPartials({
          uuid: 40,
          minPartials: 1,
          fromBlock: 90n,
          timeoutMs: 5_000,
          pollIntervalMs: 10,
        }),
      ).rejects.toThrow("persistent RPC failure");

      // 3 attempts (MAX_ATTEMPTS) for the first chunk, then give up.
      expect(publicClient.getLogs.mock.calls.length).toBe(3);
    });

    it("clears the cached promise on build failure so the next call retries from scratch", async () => {
      const { publicClient, walletClient } = mockClients();
      vi.mocked(verifyPartialSignature).mockReturnValue(true);
      publicClient.getBlockNumber.mockResolvedValue(100n);

      let callCount = 0;
      publicClient.getLogs.mockImplementation(async (params: any) => {
        if (params.address === DKG_ADDR) {
          callCount++;
          // First build: fail every retry. Second build: succeed immediately.
          if (callCount <= 3) throw new Error("transient failure");
          return [makeRegisteredLog({ validatorAddr: VALIDATOR_A, enclaveCommKey: KEY_A, round: 1 })];
        }
        return [makePartialDecryptionLog({ validator: VALIDATOR_A, round: 1, pid: 1, uuid: 50 })];
      });

      const consumer = new Consumer({ network: "testnet", publicClient, walletClient });

      await expect(
        consumer.collectPartials({
          uuid: 50,
          minPartials: 1,
          fromBlock: 90n,
          timeoutMs: 5_000,
          pollIntervalMs: 10,
        }),
      ).rejects.toThrow();

      // Second call must trigger a fresh build (not return the cached rejection).
      const partials = await consumer.collectPartials({
        uuid: 50,
        minPartials: 1,
        fromBlock: 90n,
        timeoutMs: 5_000,
        pollIntervalMs: 10,
      });
      expect(partials).toHaveLength(1);
      // First build attempted 3 retries; second build succeeded on attempt 1. Total DKG calls = 4.
      expect(callCount).toBe(4);
    });

    // TODO(Step 2 — REST migration): the dynamic-lookback test exercised
    // queryDKGParams + Observer.getLookbackBlocks. Both were removed in the
    // REST cut-over (consumer now uses a static 302_400n fallback until
    // Step 2 rewrites its EVM-event scan). Reinstate when Step 2 lands.

    it("dedups concurrent force-refresh requests into a single rescan", async () => {
      // Two collectPartials calls both hit a verification failure for the
      // same validator at the same time. Without the buildInFlight guard,
      // both would call getCommPubKeyMap(true) and fan out into two parallel
      // full-history scans. With the guard, the second caller joins the
      // first refresh's in-flight promise.
      const { publicClient, walletClient } = mockClients();
      publicClient.getBlockNumber.mockResolvedValue(100n);
      // First verify call fails (forces refresh on both concurrent paths);
      // post-refresh verifies all succeed.
      let verifyCount = 0;
      vi.mocked(verifyPartialSignature).mockImplementation(() => {
        verifyCount++;
        return verifyCount > 2; // first 2 calls (one per concurrent caller) fail
      });

      let dkgScanCount = 0;
      publicClient.getLogs.mockImplementation(async (params: any) => {
        if (params.address === DKG_ADDR) {
          dkgScanCount++;
          // Slow scan so concurrent callers definitely overlap.
          await new Promise((r) => setTimeout(r, 80));
          return [makeRegisteredLog({ validatorAddr: VALIDATOR_A, enclaveCommKey: KEY_A, round: 1 })];
        }
        return [makePartialDecryptionLog({ validator: VALIDATOR_A, round: 1, pid: 1, uuid: 201 })];
      });

      const consumer = new Consumer({ network: "testnet", publicClient, walletClient });
      // Pre-warm cache so both concurrent callers go straight to verify (then both fail-then-refresh in parallel).
      await consumer.prefetchRegistry();
      const dkgScansAfterPrewarm = dkgScanCount;

      await Promise.all([
        consumer.collectPartials({ uuid: 201, minPartials: 1, fromBlock: 90n, timeoutMs: 5_000, pollIntervalMs: 10 }),
        consumer.collectPartials({ uuid: 201, minPartials: 1, fromBlock: 90n, timeoutMs: 5_000, pollIntervalMs: 10 }),
      ]);

      // Exactly one refresh scan in addition to the prefetch.
      expect(dkgScanCount - dkgScansAfterPrewarm).toBe(1);
    });

    // TODO(Step 2 — REST migration): "default-CometBFT-URL warning across
    // refresh" test removed alongside the Observer.getDKGParams warning path.
    // Reinstate (or replace with a story-api equivalent) when Step 2 lands.
  });
});
