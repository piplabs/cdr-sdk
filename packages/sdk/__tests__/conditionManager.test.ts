import { describe, it, expect, vi, beforeEach } from "vitest";
import { conditionAddresses } from "@piplabs/cdr-contracts";
import { ConditionManager } from "../src/conditionManager.js";

function mockClients() {
  const publicClient = {
    readContract: vi.fn(),
  } as any;
  const walletClient = {
    writeContract: vi.fn().mockResolvedValue("0xtxhash" as `0x${string}`),
    account: { address: "0xaaaa" },
    chain: { id: 1 },
  } as any;
  return { publicClient, walletClient };
}

describe("ConditionManager", () => {
  const addresses = conditionAddresses.testnet!;

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("throws when network has no condition addresses", async () => {
    const { publicClient, walletClient } = mockClients();
    const mgr = new ConditionManager({ network: "mainnet", publicClient, walletClient });
    await expect(mgr.registerFixedFee({ uuid: 1, fee: 100n })).rejects.toThrow(
      /not available on network "mainnet"/,
    );
  });

  describe("FixedFee", () => {
    it("registerFixedFee calls writeContract with correct args", async () => {
      const { publicClient, walletClient } = mockClients();
      const mgr = new ConditionManager({ network: "testnet", publicClient, walletClient });

      const txHash = await mgr.registerFixedFee({ uuid: 42, fee: 1000n });

      expect(txHash).toBe("0xtxhash");
      expect(walletClient.writeContract).toHaveBeenCalledWith(
        expect.objectContaining({
          address: addresses.fixedFee,
          functionName: "register",
          args: [42, 1000n],
        }),
      );
    });

    it("payFee calls writeContract with correct args and value", async () => {
      const { publicClient, walletClient } = mockClients();
      const mgr = new ConditionManager({ network: "testnet", publicClient, walletClient });

      const txHash = await mgr.payFee({ uuid: 42, fee: 500n });

      expect(txHash).toBe("0xtxhash");
      expect(walletClient.writeContract).toHaveBeenCalledWith(
        expect.objectContaining({
          address: addresses.fixedFee,
          functionName: "payFee",
          args: [42],
          value: 500n,
        }),
      );
    });

    it("withdrawFees calls writeContract", async () => {
      const { publicClient, walletClient } = mockClients();
      const mgr = new ConditionManager({ network: "testnet", publicClient, walletClient });

      const txHash = await mgr.withdrawFees();

      expect(txHash).toBe("0xtxhash");
      expect(walletClient.writeContract).toHaveBeenCalledWith(
        expect.objectContaining({
          address: addresses.fixedFee,
          functionName: "withdraw",
          args: [],
        }),
      );
    });
  });

  describe("Whitelist", () => {
    it("registerWhitelist calls writeContract with correct args", async () => {
      const { publicClient, walletClient } = mockClients();
      const mgr = new ConditionManager({ network: "testnet", publicClient, walletClient });

      const txHash = await mgr.registerWhitelist({ uuid: 10 });

      expect(txHash).toBe("0xtxhash");
      expect(walletClient.writeContract).toHaveBeenCalledWith(
        expect.objectContaining({
          address: addresses.whitelist,
          functionName: "register",
          args: [10],
        }),
      );
    });

    it("addToWhitelist calls writeContract with correct args", async () => {
      const { publicClient, walletClient } = mockClients();
      const mgr = new ConditionManager({ network: "testnet", publicClient, walletClient });
      const account = "0x1234567890abcdef1234567890abcdef12345678" as `0x${string}`;

      const txHash = await mgr.addToWhitelist({ uuid: 10, account });

      expect(txHash).toBe("0xtxhash");
      expect(walletClient.writeContract).toHaveBeenCalledWith(
        expect.objectContaining({
          address: addresses.whitelist,
          functionName: "addToWhitelist",
          args: [10, account],
        }),
      );
    });

    it("removeFromWhitelist calls writeContract with correct args", async () => {
      const { publicClient, walletClient } = mockClients();
      const mgr = new ConditionManager({ network: "testnet", publicClient, walletClient });
      const account = "0x1234567890abcdef1234567890abcdef12345678" as `0x${string}`;

      const txHash = await mgr.removeFromWhitelist({ uuid: 10, account });

      expect(txHash).toBe("0xtxhash");
      expect(walletClient.writeContract).toHaveBeenCalledWith(
        expect.objectContaining({
          address: addresses.whitelist,
          functionName: "removeFromWhitelist",
          args: [10, account],
        }),
      );
    });
  });

  describe("TimeBased", () => {
    it("registerTimeBased calls writeContract with correct args", async () => {
      const { publicClient, walletClient } = mockClients();
      const mgr = new ConditionManager({ network: "testnet", publicClient, walletClient });

      const txHash = await mgr.registerTimeBased({
        uuid: 5,
        startTime: 1000000n,
        endTime: 2000000n,
      });

      expect(txHash).toBe("0xtxhash");
      expect(walletClient.writeContract).toHaveBeenCalledWith(
        expect.objectContaining({
          address: addresses.timeBased,
          functionName: "register",
          args: [5, 1000000n, 2000000n],
        }),
      );
    });
  });
});
