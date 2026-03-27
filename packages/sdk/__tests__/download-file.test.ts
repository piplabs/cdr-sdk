import { describe, it, expect, vi, beforeEach } from "vitest";
import { toHex } from "viem";

vi.mock("@piplabs/cdr-crypto", () => ({
  decryptPartial: vi.fn(),
  tdh2Combine: vi.fn(),
  verifyPartialSignature: vi.fn(),
  decryptFile: vi.fn(),
}));

import { Consumer } from "../src/consumer.js";
import { decryptFile } from "@piplabs/cdr-crypto";
import type { StorageProvider } from "../src/storage/types.js";

function mockClients() {
  const publicClient = {
    readContract: vi.fn(),
    waitForTransactionReceipt: vi.fn(),
    getBlockNumber: vi.fn(),
    getLogs: vi.fn(),
  } as any;
  const walletClient = {
    writeContract: vi.fn(),
    account: { address: "0xaaaa" },
  } as any;
  return { publicClient, walletClient };
}

function mockStorageProvider(): StorageProvider {
  return {
    upload: vi.fn(),
    download: vi.fn(),
  };
}

describe("Consumer.downloadFile", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("decrypts vault payload, downloads from storage, and decrypts file", async () => {
    const { publicClient, walletClient } = mockClients();
    const storageProvider = mockStorageProvider();

    const fileKey = new Uint8Array(32).fill(0xbb);
    const cidStr = "bafybeigdyrzt5sfp7udm7hu76uh7y26nf3efuylqabf3oclgtqy55fbzdi";
    const vaultPayload = new TextEncoder().encode(
      JSON.stringify({ cid: cidStr, key: toHex(fileKey) }),
    );

    const consumer = new Consumer({ network: "testnet", publicClient, walletClient });

    // Mock accessCDR to return the vault payload as the "dataKey"
    const accessCDRSpy = vi.spyOn(consumer, "accessCDR").mockResolvedValue({
      dataKey: vaultPayload,
      txHash: "0xreadtx" as `0x${string}`,
    });

    // Mock storage download returning encrypted file bytes
    const encryptedFileBytes = new Uint8Array([10, 20, 30, 40]);
    vi.mocked(storageProvider.download).mockResolvedValue(encryptedFileBytes);

    // Mock decryptFile returning original content
    const originalContent = new TextEncoder().encode("hello world");
    vi.mocked(decryptFile).mockReturnValue(originalContent);

    const result = await consumer.downloadFile({
      uuid: 42,
      accessAuxData: "0x",
      requesterPubKey: "0xpubkey",
      recipientPrivKey: new Uint8Array(32),
      globalPubKey: new Uint8Array(34),
      threshold: 2,
      storageProvider,
    });

    // accessCDR was called
    expect(accessCDRSpy).toHaveBeenCalledOnce();

    // storage provider downloaded from the correct CID
    expect(storageProvider.download).toHaveBeenCalledWith(cidStr);

    // decryptFile was called with encrypted bytes and the key from vault
    expect(decryptFile).toHaveBeenCalledWith({
      ciphertext: encryptedFileBytes,
      key: expect.any(Uint8Array),
    });
    const decryptCall = vi.mocked(decryptFile).mock.calls[0][0];
    expect(toHex(decryptCall.key)).toBe(toHex(fileKey));

    expect(result.content).toEqual(originalContent);
    expect(result.cid).toBe(cidStr);
    expect(result.txHash).toBe("0xreadtx");
  });
});
