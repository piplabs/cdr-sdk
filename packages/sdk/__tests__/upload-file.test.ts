import { describe, it, expect, vi, beforeEach } from "vitest";
import { encodeAbiParameters, keccak256, toBytes, toHex } from "viem";

vi.mock("@piplabs/cdr-crypto", () => ({
  tdh2Encrypt: vi.fn(),
  encryptFile: vi.fn(),
  getWasm: vi.fn().mockReturnValue(null),
}));

import { Uploader } from "../src/uploader.js";
import { tdh2Encrypt, encryptFile } from "@piplabs/cdr-crypto";
import { ContentSizeExceededError } from "../src/errors.js";
import type { StorageProvider } from "../src/storage/types.js";
import type { Observer } from "../src/observer.js";

function fakeObserver(opts: { maxSize?: bigint } = {}): Observer {
  return {
    getMaxEncryptedDataSize: vi.fn().mockResolvedValue(opts.maxSize ?? 10_000n),
  } as unknown as Observer;
}

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
    // Default: simulateContract succeeds, modelling a valid condition
    // contract whose checkRead/Write function returned a bool.
    simulateContract: vi.fn().mockResolvedValue({ result: true, request: {} }),
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

    // allocateFee
    publicClient.readContract.mockResolvedValueOnce(1000n);
    walletClient.writeContract.mockResolvedValueOnce("0xalloctx" as `0x${string}`);
    publicClient.waitForTransactionReceipt.mockResolvedValueOnce({
      logs: [makeVaultAllocatedLog(42)],
    });
    // maxEncryptedDataSize check is now in `write`, served by Observer (mocked).
    // writeFee
    publicClient.readContract.mockResolvedValueOnce(200n);
    walletClient.writeContract.mockResolvedValueOnce("0xwritetx" as `0x${string}`);
    publicClient.waitForTransactionReceipt.mockResolvedValueOnce({});

    const uploader = new Uploader({
      network: "testnet",
      publicClient,
      walletClient,
      observer: fakeObserver(),
    });
    const content = new TextEncoder().encode("hello world");

    const result = await uploader.uploadFile({
      ...baseParams,
      content,
      storageProvider,
    });

    // encryptFile was called with content
    expect(encryptFile).toHaveBeenCalledWith(content);

    // storage provider received the encrypted file bytes
    expect(storageProvider.upload).toHaveBeenCalledWith(fakeCiphertext, { pin: true });

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

  it("throws ContentSizeExceededError when TDH2 ciphertext exceeds maxEncryptedDataSize", async () => {
    const { publicClient, walletClient } = mockClients();
    const storageProvider = mockStorageProvider();

    const fakeKey = new Uint8Array(32).fill(0xaa);
    vi.mocked(encryptFile).mockReturnValue({ ciphertext: new Uint8Array([1]), key: fakeKey });

    // TDH2 ciphertext (200 bytes) is larger than the Observer's maxSize (10 bytes).
    const largeTdh2Ct = { raw: new Uint8Array(200), label: new Uint8Array([4]) };
    vi.mocked(tdh2Encrypt).mockResolvedValue(largeTdh2Ct);

    // allocateFee
    publicClient.readContract.mockResolvedValueOnce(1000n);
    walletClient.writeContract.mockResolvedValueOnce("0xalloctx" as `0x${string}`);
    publicClient.waitForTransactionReceipt.mockResolvedValueOnce({
      logs: [makeVaultAllocatedLog(42)],
    });

    const uploader = new Uploader({
      network: "testnet",
      publicClient,
      walletClient,
      observer: fakeObserver({ maxSize: 10n }),
    });

    await expect(
      uploader.uploadFile({
        ...baseParams,
        content: new Uint8Array([1, 2, 3]),
        storageProvider,
      }),
    ).rejects.toThrow(ContentSizeExceededError);

    // Allocate happened (size check is in `write`, after allocate); write was NOT.
    expect(walletClient.writeContract).toHaveBeenCalledOnce(); // allocate only
  });
});
