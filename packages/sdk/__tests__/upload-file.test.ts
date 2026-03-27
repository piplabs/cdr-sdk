import { describe, it, expect, vi, beforeEach } from "vitest";
import { encodeAbiParameters, keccak256, toBytes, toHex } from "viem";

vi.mock("@piplabs/cdr-crypto", () => ({
  tdh2Encrypt: vi.fn(),
  encryptFile: vi.fn(),
}));

import { Uploader } from "../src/uploader.js";
import { tdh2Encrypt, encryptFile } from "@piplabs/cdr-crypto";
import { ContentSizeExceededError } from "../src/errors.js";
import type { StorageProvider } from "../src/storage/types.js";

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
  } as any;
  const walletClient = {
    writeContract: vi.fn(),
    account: { address: "0xaaaa" },
  } as any;
  return { publicClient, walletClient };
}

function mockStorageProvider(): StorageProvider {
  return {
    upload: vi.fn().mockResolvedValue("bafybeigdyrzt5sfp7udm7hu76uh7y26nf3efuylqabf3oclgtqy55fbzdi"),
    download: vi.fn(),
  };
}

const baseParams = {
  updatable: false,
  writeConditionAddr: "0x1111111111111111111111111111111111111111" as `0x${string}`,
  readConditionAddr: "0x2222222222222222222222222222222222222222" as `0x${string}`,
  writeConditionData: "0x" as `0x${string}`,
  readConditionData: "0x" as `0x${string}`,
  accessAuxData: "0x" as `0x${string}`,
  globalPubKey: new Uint8Array(34).fill(0x04),
};

describe("Uploader.uploadFile", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("encrypts content, uploads to storage, and writes CID+key to vault", async () => {
    const { publicClient, walletClient } = mockClients();
    const storageProvider = mockStorageProvider();

    const fakeKey = new Uint8Array(32).fill(0xaa);
    const fakeCiphertext = new Uint8Array([1, 2, 3]);
    vi.mocked(encryptFile).mockReturnValue({ ciphertext: fakeCiphertext, key: fakeKey });

    const mockTdh2Ct = { raw: new Uint8Array([10, 20, 30]), label: new Uint8Array([4, 5]) };
    vi.mocked(tdh2Encrypt).mockResolvedValue(mockTdh2Ct);

    // maxEncryptedDataSize check (default on)
    publicClient.readContract.mockResolvedValueOnce(10000n);
    // allocateFee
    publicClient.readContract.mockResolvedValueOnce(1000n);
    walletClient.writeContract.mockResolvedValueOnce("0xalloctx" as `0x${string}`);
    publicClient.waitForTransactionReceipt.mockResolvedValueOnce({
      logs: [makeVaultAllocatedLog(42)],
    });
    // writeFee
    publicClient.readContract.mockResolvedValueOnce(200n);
    walletClient.writeContract.mockResolvedValueOnce("0xwritetx" as `0x${string}`);
    publicClient.waitForTransactionReceipt.mockResolvedValueOnce({});

    const uploader = new Uploader({ network: "testnet", publicClient, walletClient });
    const content = new TextEncoder().encode("hello world");

    const result = await uploader.uploadFile({
      ...baseParams,
      content,
      storageProvider,
    });

    // encryptFile was called with content
    expect(encryptFile).toHaveBeenCalledWith(content);

    // storage provider received the encrypted file bytes
    expect(storageProvider.upload).toHaveBeenCalledWith(fakeCiphertext);

    // tdh2Encrypt received JSON payload containing CID and key
    const tdh2Call = vi.mocked(tdh2Encrypt).mock.calls[0][0];
    const payloadJson = JSON.parse(new TextDecoder().decode(tdh2Call.plaintext));
    expect(payloadJson.cid).toBe("bafybeigdyrzt5sfp7udm7hu76uh7y26nf3efuylqabf3oclgtqy55fbzdi");
    expect(payloadJson.key).toBe(toHex(fakeKey));

    expect(result.uuid).toBe(42);
    expect(result.cid).toBe("bafybeigdyrzt5sfp7udm7hu76uh7y26nf3efuylqabf3oclgtqy55fbzdi");
    expect(result.txHashes.allocate).toBe("0xalloctx");
    expect(result.txHashes.write).toBe("0xwritetx");
  });

  it("throws ContentSizeExceededError when payload exceeds max (checkSize defaults to true)", async () => {
    const { publicClient, walletClient } = mockClients();
    const storageProvider = mockStorageProvider();

    const fakeKey = new Uint8Array(32).fill(0xaa);
    vi.mocked(encryptFile).mockReturnValue({ ciphertext: new Uint8Array([1]), key: fakeKey });

    // maxEncryptedDataSize = 10 bytes (tiny, will be exceeded by JSON payload)
    publicClient.readContract.mockResolvedValueOnce(10n);

    const uploader = new Uploader({ network: "testnet", publicClient, walletClient });

    await expect(
      uploader.uploadFile({
        ...baseParams,
        content: new Uint8Array([1, 2, 3]),
        storageProvider,
      }),
    ).rejects.toThrow(ContentSizeExceededError);

    // No allocate or write calls should have been made
    expect(walletClient.writeContract).not.toHaveBeenCalled();
  });

  it("skips size check when checkSize is false", async () => {
    const { publicClient, walletClient } = mockClients();
    const storageProvider = mockStorageProvider();

    const fakeKey = new Uint8Array(32).fill(0xaa);
    vi.mocked(encryptFile).mockReturnValue({ ciphertext: new Uint8Array([1]), key: fakeKey });

    const mockTdh2Ct = { raw: new Uint8Array([10]), label: new Uint8Array([4]) };
    vi.mocked(tdh2Encrypt).mockResolvedValue(mockTdh2Ct);

    // allocateFee (no maxEncryptedDataSize call since checkSize=false)
    publicClient.readContract.mockResolvedValueOnce(1000n);
    walletClient.writeContract.mockResolvedValueOnce("0xalloctx" as `0x${string}`);
    publicClient.waitForTransactionReceipt.mockResolvedValueOnce({
      logs: [makeVaultAllocatedLog(1)],
    });
    // writeFee
    publicClient.readContract.mockResolvedValueOnce(200n);
    walletClient.writeContract.mockResolvedValueOnce("0xwritetx" as `0x${string}`);
    publicClient.waitForTransactionReceipt.mockResolvedValueOnce({});

    const uploader = new Uploader({ network: "testnet", publicClient, walletClient });

    await uploader.uploadFile({
      ...baseParams,
      content: new Uint8Array([1, 2, 3]),
      storageProvider,
      checkSize: false,
    });

    // maxEncryptedDataSize should NOT have been called
    const readContractCalls = publicClient.readContract.mock.calls;
    const maxSizeCalls = readContractCalls.filter(
      (c: any) => c[0].functionName === "maxEncryptedDataSize",
    );
    expect(maxSizeCalls.length).toBe(0);
  });
});
