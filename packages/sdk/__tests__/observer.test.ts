import { describe, it, expect, vi } from "vitest";
import { encodeAbiParameters, keccak256, toBytes, padHex, toHex } from "viem";
import { Observer } from "../src/observer.js";

function mockPublicClient(overrides: Record<string, any> = {}) {
  return {
    readContract: vi.fn(),
    getLogs: vi.fn(),
    getBlockNumber: vi.fn().mockResolvedValue(1000n),
    ...overrides,
  } as any;
}

function makeFinalizedLog(
  globalPubKey: `0x${string}`,
  validator: `0x${string}` = "0x0000000000000000000000000000000000000001",
  round: number = 1,
) {
  const topic0 = keccak256(
    toBytes("Finalized(uint32,address,bytes32,bytes32,bytes32,bytes,bytes[],bytes,bytes)"),
  );
  const topic1 = padHex(validator, { size: 32 });

  const data = encodeAbiParameters(
    [
      { name: "round", type: "uint32" },
      { name: "enclaveType", type: "bytes32" },
      { name: "codeCommitment", type: "bytes32" },
      { name: "participantsRoot", type: "bytes32" },
      { name: "globalPubKey", type: "bytes" },
      { name: "publicCoeffs", type: "bytes[]" },
      { name: "pubKeyShare", type: "bytes" },
      { name: "signature", type: "bytes" },
    ],
    [
      round,
      "0x0000000000000000000000000000000000000000000000000000000000000000",
      "0x0000000000000000000000000000000000000000000000000000000000000000",
      "0x0000000000000000000000000000000000000000000000000000000000000000",
      globalPubKey,
      [],
      "0x",
      "0x",
    ],
  );

  return {
    address: "0xcccccc0000000000000000000000000000000004" as `0x${string}`,
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

describe("Observer", () => {
  it("getVault reads vault from CDR contract", async () => {
    const client = mockPublicClient();
    client.readContract.mockResolvedValueOnce({
      updatable: false,
      writeConditionAddr: "0x1111111111111111111111111111111111111111",
      readConditionAddr: "0x2222222222222222222222222222222222222222",
      writeConditionData: "0x",
      readConditionData: "0x",
      encryptedData: "0xabcdef",
    });

    const observer = new Observer({ network: "testnet", publicClient: client });
    const vault = await observer.getVault(1);

    expect(client.readContract).toHaveBeenCalledOnce();
    expect(vault.encryptedData).toBe("0xabcdef");
  });

  it("getOperationalThreshold reads from DKG contract", async () => {
    const client = mockPublicClient();
    client.readContract.mockResolvedValueOnce(3n);

    const observer = new Observer({ network: "testnet", publicClient: client });
    const threshold = await observer.getOperationalThreshold();

    expect(threshold).toBe(3n);
  });

  it("getGlobalPubKey returns globalPubKey from active round", async () => {
    const client = mockPublicClient();
    const expectedPubKey = "0xdeadbeefcafebabe";
    client.getLogs.mockResolvedValueOnce([
      makeFinalizedLog(expectedPubKey as `0x${string}`),
    ]);
    // getActiveRound calls readContract for minReqFinalizedParticipants
    client.readContract.mockResolvedValueOnce(1n);

    const observer = new Observer({ network: "testnet", publicClient: client });
    const pubKey = await observer.getGlobalPubKey();

    expect(toHex(pubKey)).toBe(expectedPubKey);
  });

  it("getGlobalPubKey throws when no Finalized event found", async () => {
    const client = mockPublicClient();
    // First call: lookback window search returns empty
    // Second call: fallback from block 0 also returns empty
    client.getLogs.mockResolvedValue([]);

    const observer = new Observer({ network: "testnet", publicClient: client });

    await expect(observer.getGlobalPubKey()).rejects.toThrow(
      "No Finalized event found",
    );
  });

  it("getGlobalPubKey uses the most recent Finalized event from active round", async () => {
    const client = mockPublicClient();
    const oldPubKey = "0xaaaa";
    const newPubKey = "0xbbbb";
    // Two different validators in the same round — both counted
    client.getLogs.mockResolvedValueOnce([
      makeFinalizedLog(oldPubKey as `0x${string}`, "0x0000000000000000000000000000000000000001"),
      makeFinalizedLog(newPubKey as `0x${string}`, "0x0000000000000000000000000000000000000002"),
    ]);
    // getActiveRound: minReqFinalizedParticipants = 1 (2 unique validators >= 1 → active)
    client.readContract.mockResolvedValueOnce(1n);

    const observer = new Observer({ network: "testnet", publicClient: client });
    const pubKey = await observer.getGlobalPubKey();

    expect(toHex(pubKey)).toBe(newPubKey);
  });

  it("getRegisteredValidators returns map of validator address to commPubKey", async () => {
    const client = mockPublicClient();
    const commKey = ("0x" + "aa".repeat(64)) as `0x${string}`; // 64 bytes
    client.getLogs.mockResolvedValueOnce([
      makeRegisteredLog({
        validatorAddr: "0x0000000000000000000000000000000000000001",
        enclaveCommKey: commKey,
        round: 1,
      }),
    ]);

    const observer = new Observer({ network: "testnet", publicClient: client });
    const validators = await observer.getRegisteredValidators();

    expect(validators.size).toBe(1);
    const key = validators.get("0x0000000000000000000000000000000000000001");
    expect(key).toBeDefined();
    expect(key!.length).toBe(64);
  });

  it("getRegisteredValidators filters by round when provided", async () => {
    const client = mockPublicClient();
    client.getLogs.mockResolvedValueOnce([
      makeRegisteredLog({
        validatorAddr: "0x0000000000000000000000000000000000000001",
        enclaveCommKey: ("0x" + "aa".repeat(64)) as `0x${string}`,
        round: 1,
      }),
      makeRegisteredLog({
        validatorAddr: "0x0000000000000000000000000000000000000002",
        enclaveCommKey: ("0x" + "bb".repeat(64)) as `0x${string}`,
        round: 2,
      }),
    ]);

    const observer = new Observer({ network: "testnet", publicClient: client });
    const validators = await observer.getRegisteredValidators({ round: 2 });

    expect(validators.size).toBe(1);
    expect(validators.has("0x0000000000000000000000000000000000000002")).toBe(true);
  });

  it("getRegisteredValidators returns empty map when no Registered events", async () => {
    const client = mockPublicClient();
    client.getLogs.mockResolvedValueOnce([]);

    const observer = new Observer({ network: "testnet", publicClient: client });
    const validators = await observer.getRegisteredValidators();

    expect(validators.size).toBe(0);
  });

  // --- Multi-round tests for getActiveRound (Issue #36) ---

  it("getGlobalPubKey skips failed round and uses active round", async () => {
    const client = mockPublicClient();
    const activeKey = "0xaaaa";
    const failedKey = "0xbbbb";
    // Round 1: 3 validators (meets threshold) — active round
    // Round 2: 1 validator (below threshold) — failed round
    client.getLogs.mockResolvedValueOnce([
      makeFinalizedLog(activeKey as `0x${string}`, "0x0000000000000000000000000000000000000001", 1),
      makeFinalizedLog(activeKey as `0x${string}`, "0x0000000000000000000000000000000000000002", 1),
      makeFinalizedLog(activeKey as `0x${string}`, "0x0000000000000000000000000000000000000003", 1),
      makeFinalizedLog(failedKey as `0x${string}`, "0x0000000000000000000000000000000000000001", 2),
    ]);
    // getActiveRound calls readContract for minReqFinalizedParticipants = 3
    client.readContract.mockResolvedValueOnce(3n);

    const observer = new Observer({ network: "testnet", publicClient: client });
    const pubKey = await observer.getGlobalPubKey();

    // Should return round 1's key (active), not round 2's (failed)
    expect(toHex(pubKey)).toBe(activeKey);
  });

  it("getParticipantCount returns count from active round, not failed round", async () => {
    const client = mockPublicClient();
    // Round 1: 3 validators — active
    // Round 2: 2 validators — failed (minReq=3)
    client.getLogs.mockResolvedValueOnce([
      makeFinalizedLog("0xaa" as `0x${string}`, "0x0000000000000000000000000000000000000001", 1),
      makeFinalizedLog("0xaa" as `0x${string}`, "0x0000000000000000000000000000000000000002", 1),
      makeFinalizedLog("0xaa" as `0x${string}`, "0x0000000000000000000000000000000000000003", 1),
      makeFinalizedLog("0xbb" as `0x${string}`, "0x0000000000000000000000000000000000000001", 2),
      makeFinalizedLog("0xbb" as `0x${string}`, "0x0000000000000000000000000000000000000002", 2),
    ]);
    // minReqFinalizedParticipants = 3
    client.readContract.mockResolvedValueOnce(3n);

    const observer = new Observer({ network: "testnet", publicClient: client });
    const count = await observer.getParticipantCount();

    // Should return 3 (round 1), not 2 (round 2)
    expect(count).toBe(3);
  });

  it("getActiveRound deduplicates by validatorAddr", async () => {
    const client = mockPublicClient();
    // Round 1: same validator emits twice (duplicate/reorg)
    client.getLogs.mockResolvedValueOnce([
      makeFinalizedLog("0xcc" as `0x${string}`, "0x0000000000000000000000000000000000000001", 1),
      makeFinalizedLog("0xcc" as `0x${string}`, "0x0000000000000000000000000000000000000001", 1), // duplicate
      makeFinalizedLog("0xcc" as `0x${string}`, "0x0000000000000000000000000000000000000002", 1),
    ]);
    // minReqFinalizedParticipants = 3 — only 2 unique validators, should NOT meet threshold
    client.readContract.mockResolvedValueOnce(3n);

    const observer = new Observer({ network: "testnet", publicClient: client });
    const count = await observer.getParticipantCount();

    // Should be 2 (deduplicated), not 3 (raw count)
    expect(count).toBe(2);
  });

  // --- Cosmos REST API mode (dkgSource: "cosmos-api") ---

  describe("cosmos-api mode", () => {
    function mockFetch(responses: Record<string, unknown>) {
      return vi.fn(async (url: string) => {
        for (const [path, body] of Object.entries(responses)) {
          if (url.includes(path)) {
            return {
              ok: true,
              status: 200,
              statusText: "OK",
              json: async () => body,
              text: async () => JSON.stringify(body),
            } as Response;
          }
        }
        return {
          ok: false,
          status: 404,
          statusText: "Not Found",
          text: async () => "not found",
        } as Response;
      });
    }

    it("getGlobalPubKey fetches from /api/dkg/latest_active", async () => {
      const client = mockPublicClient();
      const originalFetch = globalThis.fetch;
      globalThis.fetch = mockFetch({
        latest_active: {
          network: {
            round: 7,
            total: 3,
            threshold: 2,
            globalPublicKeyHex: "0x" + "ab".repeat(32),
          },
        },
      }) as unknown as typeof fetch;

      try {
        const observer = new Observer({
          network: "testnet",
          publicClient: client,
          dkgSource: "cosmos-api",
          apiBase: "http://localhost:3000/api/dkg",
        });
        const pubKey = await observer.getGlobalPubKey();
        // 2-byte curve prefix + 32-byte point
        expect(pubKey.length).toBe(34);
        expect(client.getLogs).not.toHaveBeenCalled();
      } finally {
        globalThis.fetch = originalFetch;
      }
    });

    it("getParticipantCount and getThreshold read from cosmos API", async () => {
      const client = mockPublicClient();
      const originalFetch = globalThis.fetch;
      globalThis.fetch = mockFetch({
        latest_active: {
          network: {
            round: 7,
            total: 5,
            threshold: 3,
            globalPublicKeyHex: "0x" + "cc".repeat(32),
          },
        },
      }) as unknown as typeof fetch;

      try {
        const observer = new Observer({
          network: "testnet",
          publicClient: client,
          dkgSource: "cosmos-api",
          apiBase: "http://localhost:3000/api/dkg",
        });
        expect(await observer.getParticipantCount()).toBe(5);
        expect(await observer.getThreshold()).toBe(3);
        expect(client.getLogs).not.toHaveBeenCalled();
      } finally {
        globalThis.fetch = originalFetch;
      }
    });

    it("minThresholdRatio override applies in cosmos-api mode", async () => {
      const client = mockPublicClient();
      const originalFetch = globalThis.fetch;
      globalThis.fetch = mockFetch({
        latest_active: {
          network: {
            round: 1,
            total: 6,
            threshold: 2, // API says 2, but ceil(6 * 0.67) = 5 takes precedence
            globalPublicKeyHex: "0x" + "dd".repeat(32),
          },
        },
      }) as unknown as typeof fetch;

      try {
        const observer = new Observer({
          network: "testnet",
          publicClient: client,
          dkgSource: "cosmos-api",
          minThresholdRatio: 0.67,
        });
        expect(await observer.getThreshold()).toBe(5);
      } finally {
        globalThis.fetch = originalFetch;
      }
    });

    it("getRegisteredValidators fetches from verified_registrations", async () => {
      const client = mockPublicClient();
      const originalFetch = globalThis.fetch;
      globalThis.fetch = mockFetch({
        latest_active: {
          network: {
            round: 4,
            total: 1,
            threshold: 1,
            globalPublicKeyHex: "0x" + "ee".repeat(32),
          },
        },
        verified_registrations: {
          registrations: [
            {
              round: 4,
              validatorAddr: "0xAAAAaaaaaaaaaAAAAaaaaaaAaaAaAaAaAAaAAaaA",
              index: 0,
              commPubKeyHex: "0x" + "11".repeat(64),
              pubKeyShareHex: "0x",
              status: 1,
              codeCommitmentHex: "0x",
            },
          ],
        },
      }) as unknown as typeof fetch;

      try {
        const observer = new Observer({
          network: "testnet",
          publicClient: client,
          dkgSource: "cosmos-api",
        });
        const validators = await observer.getRegisteredValidators();
        expect(validators.size).toBe(1);
        const key = validators.get("0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa");
        expect(key?.length).toBe(64);
        expect(client.getLogs).not.toHaveBeenCalled();
      } finally {
        globalThis.fetch = originalFetch;
      }
    });
  });
});
