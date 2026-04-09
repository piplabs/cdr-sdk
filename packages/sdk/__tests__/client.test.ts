import { describe, it, expect, vi } from "vitest";

// Mock @piplabs/cdr-crypto before importing CDRClient so the WASM loader is never executed.
vi.mock("@piplabs/cdr-crypto", () => ({
  tdh2Encrypt: vi.fn(),
  encryptFile: vi.fn(),
  getWasm: vi.fn().mockReturnValue(null),
  decryptPartial: vi.fn(),
  tdh2Combine: vi.fn(),
  verifyPartialSignature: vi.fn(),
  decryptFile: vi.fn(),
  generateEphemeralKeyPair: vi.fn(),
  CURVE_ED25519: 1,
}));

import { CDRClient } from "../src/client.js";
import { WalletClientRequiredError } from "../src/errors.js";

const mockPublicClient = {
  readContract: vi.fn(),
  getLogs: vi.fn(),
  getBlockNumber: vi.fn().mockResolvedValue(1000n),
  waitForTransactionReceipt: vi.fn(),
  getTransactionReceipt: vi.fn(),
  simulateContract: vi.fn(),
} as any;

const mockWalletClient = {
  writeContract: vi.fn(),
  account: { address: "0x1234567890abcdef1234567890abcdef12345678" },
  chain: { id: 1 },
} as any;

describe("CDRClient", () => {
  it("publicClient only: cdr.observer is defined (Observer instance)", () => {
    const cdr = new CDRClient({
      network: "testnet",
      publicClient: mockPublicClient,
    });
    expect(cdr.observer).toBeDefined();
  });

  it("publicClient only: accessing cdr.uploader throws WalletClientRequiredError", () => {
    const cdr = new CDRClient({
      network: "testnet",
      publicClient: mockPublicClient,
    });
    expect(() => cdr.uploader).toThrow(WalletClientRequiredError);
  });

  it("publicClient only: accessing cdr.consumer throws WalletClientRequiredError", () => {
    const cdr = new CDRClient({
      network: "testnet",
      publicClient: mockPublicClient,
    });
    expect(() => cdr.consumer).toThrow(WalletClientRequiredError);
  });

  it("publicClient + walletClient: all three (observer, uploader, consumer) are defined", () => {
    const cdr = new CDRClient({
      network: "testnet",
      publicClient: mockPublicClient,
      walletClient: mockWalletClient,
    });
    expect(cdr.observer).toBeDefined();
    expect(cdr.uploader).toBeDefined();
    expect(cdr.consumer).toBeDefined();
  });

  it("validationRpcUrls passed: construction succeeds without error", () => {
    expect(() => {
      new CDRClient({
        network: "testnet",
        publicClient: mockPublicClient,
        validationRpcUrls: ["http://localhost:8545", "http://localhost:8546"],
      });
    }).not.toThrow();
  });

  it("minThresholdRatio passed: construction succeeds without error", () => {
    expect(() => {
      new CDRClient({
        network: "testnet",
        publicClient: mockPublicClient,
        minThresholdRatio: 0.67,
      });
    }).not.toThrow();
  });
});
