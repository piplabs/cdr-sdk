import { describe, it, expect, vi } from "vitest";
import { encodeAbiParameters, keccak256, toBytes, padHex, toHex } from "viem";
import { Observer } from "../src/observer.js";

function mockPublicClient(overrides: Record<string, any> = {}) {
  return {
    readContract: vi.fn(),
    getLogs: vi.fn(),
    ...overrides,
  } as any;
}

function makeFinalizedLog(globalPubKey: `0x${string}`, validator: `0x${string}` = "0x0000000000000000000000000000000000000001") {
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
      1,
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

  it("getGlobalPubKey returns globalPubKey from latest Finalized event", async () => {
    const client = mockPublicClient();
    const expectedPubKey = "0xdeadbeefcafebabe";
    client.getLogs.mockResolvedValueOnce([
      makeFinalizedLog(expectedPubKey as `0x${string}`),
    ]);

    const observer = new Observer({ network: "testnet", publicClient: client });
    const pubKey = await observer.getGlobalPubKey();

    expect(toHex(pubKey)).toBe(expectedPubKey);
  });

  it("getGlobalPubKey throws when no Finalized event found", async () => {
    const client = mockPublicClient();
    client.getLogs.mockResolvedValueOnce([]);

    const observer = new Observer({ network: "testnet", publicClient: client });

    await expect(observer.getGlobalPubKey()).rejects.toThrow(
      "No Finalized event found",
    );
  });

  it("getGlobalPubKey uses the most recent Finalized event", async () => {
    const client = mockPublicClient();
    const oldPubKey = "0xaaaa";
    const newPubKey = "0xbbbb";
    client.getLogs.mockResolvedValueOnce([
      makeFinalizedLog(oldPubKey as `0x${string}`),
      makeFinalizedLog(newPubKey as `0x${string}`),
    ]);

    const observer = new Observer({ network: "testnet", publicClient: client });
    const pubKey = await observer.getGlobalPubKey();

    expect(toHex(pubKey)).toBe(newPubKey);
  });
});
