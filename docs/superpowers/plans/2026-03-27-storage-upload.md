# Storage Upload Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add SDK support for encrypting files with AES-256-GCM, uploading to decentralized storage providers, and storing CID + key references in CDR vaults.

**Architecture:** File encryption functions in `packages/crypto`. StorageProvider interface + 4 built-in providers + `uploadFile`/`downloadFile` methods on existing Uploader/Consumer classes in `packages/sdk`. Contract ABI updated with `maxEncryptedDataSize` for size checks.

**Tech Stack:** `@noble/ciphers` (AES-256-GCM), `helia`/`@helia/unixfs`, `@storacha/client`, `@filoz/synapse-sdk`, vitest

**Spec:** `docs/superpowers/specs/2026-03-27-storage-upload-design.md`

---

## File Map

**New files:**
- `packages/crypto/src/file-encryption.ts` — `encryptFile()` and `decryptFile()` using AES-256-GCM
- `packages/crypto/__tests__/file-encryption.test.ts` — round-trip, wrong-key, empty, large tests
- `packages/sdk/src/storage/types.ts` — `StorageProvider` interface
- `packages/sdk/src/storage/helia.ts` — `HeliaProvider` wrapping Helia SDK
- `packages/sdk/src/storage/storacha.ts` — `StorachaProvider` wrapping @storacha/client
- `packages/sdk/src/storage/synapse.ts` — `SynapseProvider` wrapping @filoz/synapse-sdk
- `packages/sdk/src/storage/gateway.ts` — `GatewayProvider` using IPFS HTTP API
- `packages/sdk/src/storage/index.ts` — barrel export for storage module
- `packages/sdk/__tests__/upload-file.test.ts` — tests for `Uploader.uploadFile`
- `packages/sdk/__tests__/download-file.test.ts` — tests for `Consumer.downloadFile`

**Modified files:**
- `packages/crypto/src/index.ts:7` — add `encryptFile`, `decryptFile` exports
- `packages/contracts/src/abis/cdr.ts:310` — add `maxEncryptedDataSize` ABI entry
- `packages/sdk/src/errors.ts:31` — add `ContentSizeExceededError`
- `packages/sdk/src/observer.ts:130` — add `getMaxEncryptedDataSize()` method
- `packages/sdk/src/uploader.ts:1` — add `uploadFile()` method, new imports
- `packages/sdk/src/consumer.ts:1` — add `downloadFile()` method, new imports
- `packages/sdk/src/index.ts:7` — add storage re-exports
- `packages/sdk/package.json` — add optional peer dependencies

---

### Task 1: File Encryption — encryptFile / decryptFile

**Files:**
- Create: `packages/crypto/src/file-encryption.ts`
- Create: `packages/crypto/__tests__/file-encryption.test.ts`
- Modify: `packages/crypto/src/index.ts:7`

- [ ] **Step 1: Write the failing tests**

Create `packages/crypto/__tests__/file-encryption.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { encryptFile, decryptFile } from "../src/file-encryption.js";

describe("encryptFile / decryptFile", () => {
  it("round-trip: decrypt(encrypt(plaintext)) returns original", () => {
    const plaintext = new TextEncoder().encode("hello world");
    const { ciphertext, key } = encryptFile(plaintext);
    const result = decryptFile({ ciphertext, key });
    expect(result).toEqual(plaintext);
  });

  it("produces different ciphertext each call (random key + IV)", () => {
    const plaintext = new TextEncoder().encode("same input");
    const a = encryptFile(plaintext);
    const b = encryptFile(plaintext);
    expect(a.ciphertext).not.toEqual(b.ciphertext);
    expect(a.key).not.toEqual(b.key);
  });

  it("decryption with wrong key throws", () => {
    const plaintext = new TextEncoder().encode("secret");
    const { ciphertext } = encryptFile(plaintext);
    const wrongKey = new Uint8Array(32).fill(0xff);
    expect(() => decryptFile({ ciphertext, key: wrongKey })).toThrow();
  });

  it("handles empty plaintext", () => {
    const plaintext = new Uint8Array(0);
    const { ciphertext, key } = encryptFile(plaintext);
    const result = decryptFile({ ciphertext, key });
    expect(result).toEqual(plaintext);
  });

  it("handles large plaintext (1 MB)", () => {
    const plaintext = new Uint8Array(1024 * 1024).fill(0xab);
    const { ciphertext, key } = encryptFile(plaintext);
    const result = decryptFile({ ciphertext, key });
    expect(result).toEqual(plaintext);
  });

  it("ciphertext is IV (12) + encrypted data + GCM tag (16)", () => {
    const plaintext = new TextEncoder().encode("test");
    const { ciphertext } = encryptFile(plaintext);
    // 12 (IV) + plaintext.length + 16 (GCM tag)
    expect(ciphertext.length).toBe(12 + plaintext.length + 16);
  });

  it("key is 32 bytes", () => {
    const { key } = encryptFile(new Uint8Array(10));
    expect(key.length).toBe(32);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd packages/crypto && npx vitest run __tests__/file-encryption.test.ts`
Expected: FAIL — cannot resolve `../src/file-encryption.js`

- [ ] **Step 3: Implement encryptFile and decryptFile**

Create `packages/crypto/src/file-encryption.ts`:

```ts
import { gcm } from "@noble/ciphers/aes";
import { randomBytes } from "@noble/hashes/utils";

const AES_KEY_LENGTH = 32;
const IV_LENGTH = 12;

/** Encrypt file content with a random AES-256-GCM key.
 *  Returns ciphertext (IV || encrypted || GCM tag) and the 32-byte key. */
export function encryptFile(plaintext: Uint8Array): {
  ciphertext: Uint8Array;
  key: Uint8Array;
} {
  const key = randomBytes(AES_KEY_LENGTH);
  const iv = randomBytes(IV_LENGTH);
  const aesGcm = gcm(key, iv);
  const encrypted = aesGcm.encrypt(plaintext);

  const ciphertext = new Uint8Array(IV_LENGTH + encrypted.length);
  ciphertext.set(iv, 0);
  ciphertext.set(encrypted, IV_LENGTH);

  return { ciphertext, key };
}

/** Decrypt file content given the AES-256-GCM key.
 *  Expects ciphertext format: IV (12 bytes) || encrypted || GCM tag. */
export function decryptFile(params: {
  ciphertext: Uint8Array;
  key: Uint8Array;
}): Uint8Array {
  const { ciphertext, key } = params;
  const iv = ciphertext.slice(0, IV_LENGTH);
  const encrypted = ciphertext.slice(IV_LENGTH);
  const aesGcm = gcm(key, iv);
  return aesGcm.decrypt(encrypted);
}
```

- [ ] **Step 4: Export from crypto barrel**

Add to `packages/crypto/src/index.ts` (after line 7):

```ts
export { encryptFile, decryptFile } from "./file-encryption.js";
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `cd packages/crypto && npx vitest run __tests__/file-encryption.test.ts`
Expected: All 7 tests PASS

- [ ] **Step 6: Commit**

```bash
git add packages/crypto/src/file-encryption.ts packages/crypto/__tests__/file-encryption.test.ts packages/crypto/src/index.ts
git commit -m "feat(crypto): add encryptFile and decryptFile for AES-256-GCM file encryption"
```

---

### Task 2: Contract ABI Update — maxEncryptedDataSize

**Files:**
- Modify: `packages/contracts/src/abis/cdr.ts:310`

- [ ] **Step 1: Add maxEncryptedDataSize to CDR ABI**

In `packages/contracts/src/abis/cdr.ts`, add the following entry after the `writeFee` function block (after line 310, before the `EncryptedPartialDecryptionSubmitted` event):

```ts
  {
    "type": "function",
    "name": "maxEncryptedDataSize",
    "inputs": [],
    "outputs": [
      {
        "name": "",
        "type": "uint256",
        "internalType": "uint256"
      }
    ],
    "stateMutability": "view"
  },
```

- [ ] **Step 2: Build contracts package to verify**

Run: `cd packages/contracts && npx tsc --noEmit`
Expected: No errors

- [ ] **Step 3: Commit**

```bash
git add packages/contracts/src/abis/cdr.ts
git commit -m "feat(contracts): add maxEncryptedDataSize to CDR ABI"
```

---

### Task 3: ContentSizeExceededError + Observer.getMaxEncryptedDataSize

**Files:**
- Modify: `packages/sdk/src/errors.ts:31`
- Modify: `packages/sdk/src/observer.ts:130`

- [ ] **Step 1: Add ContentSizeExceededError**

Append to `packages/sdk/src/errors.ts` after line 31:

```ts
export class ContentSizeExceededError extends CDRError {
  actual: number;
  max: bigint;
  constructor(actual: number, max: bigint) {
    super(
      `Vault payload size ${actual} bytes exceeds max ${max} bytes`,
      "CONTENT_SIZE_EXCEEDED",
    );
    this.actual = actual;
    this.max = max;
  }
}
```

- [ ] **Step 2: Add getMaxEncryptedDataSize to Observer**

Add the following method to the `Observer` class in `packages/sdk/src/observer.ts`, after the `getRegisteredValidators` method (before the closing `}`):

```ts
  /** Get the maximum allowed encrypted data size for vault writes */
  async getMaxEncryptedDataSize(): Promise<bigint> {
    return this.publicClient.readContract({
      address: contractAddresses[this.network].cdr,
      abi: cdrAbi,
      functionName: "maxEncryptedDataSize",
    });
  }
```

- [ ] **Step 3: Build SDK to verify types**

Run: `cd packages/sdk && npx tsc --noEmit`
Expected: No errors

- [ ] **Step 4: Commit**

```bash
git add packages/sdk/src/errors.ts packages/sdk/src/observer.ts
git commit -m "feat(sdk): add ContentSizeExceededError and Observer.getMaxEncryptedDataSize"
```

---

### Task 4: StorageProvider Interface + Built-in Providers

**Files:**
- Create: `packages/sdk/src/storage/types.ts`
- Create: `packages/sdk/src/storage/helia.ts`
- Create: `packages/sdk/src/storage/storacha.ts`
- Create: `packages/sdk/src/storage/synapse.ts`
- Create: `packages/sdk/src/storage/gateway.ts`
- Create: `packages/sdk/src/storage/index.ts`
- Modify: `packages/sdk/src/index.ts:7`
- Modify: `packages/sdk/package.json`

- [ ] **Step 1: Create StorageProvider interface**

Create `packages/sdk/src/storage/types.ts`:

```ts
/** Generic storage provider interface for uploading/downloading files by CID. */
export interface StorageProvider {
  /** Upload bytes to storage, returns a CID string. */
  upload(data: Uint8Array): Promise<string>;
  /** Download bytes from storage by CID. */
  download(cid: string): Promise<Uint8Array>;
}
```

- [ ] **Step 2: Create HeliaProvider**

Create `packages/sdk/src/storage/helia.ts`:

```ts
import type { StorageProvider } from "./types.js";

/** IPFS storage provider using the Helia SDK. */
export class HeliaProvider implements StorageProvider {
  private helia: any;
  private fs: any;

  /**
   * @param helia - An initialized Helia node instance
   * @param unixfs - A @helia/unixfs instance created from the Helia node
   */
  constructor(params: { helia: any; unixfs: any }) {
    this.helia = params.helia;
    this.fs = params.unixfs;
  }

  async upload(data: Uint8Array): Promise<string> {
    const cid = await this.fs.addBytes(data);
    return cid.toString();
  }

  async download(cid: string): Promise<Uint8Array> {
    const { CID } = await import("multiformats/cid");
    const parsedCid = CID.parse(cid);
    const chunks: Uint8Array[] = [];
    for await (const chunk of this.fs.cat(parsedCid)) {
      chunks.push(chunk);
    }
    const totalLength = chunks.reduce((sum, c) => sum + c.length, 0);
    const result = new Uint8Array(totalLength);
    let offset = 0;
    for (const chunk of chunks) {
      result.set(chunk, offset);
      offset += chunk.length;
    }
    return result;
  }
}
```

- [ ] **Step 3: Create StorachaProvider**

Create `packages/sdk/src/storage/storacha.ts`:

```ts
import type { StorageProvider } from "./types.js";

/** Storage provider using Storacha (w3up) SDK. */
export class StorachaProvider implements StorageProvider {
  private client: any;

  /**
   * @param client - A configured @storacha/client instance (with space set)
   */
  constructor(client: any) {
    this.client = client;
  }

  async upload(data: Uint8Array): Promise<string> {
    const blob = new Blob([data]);
    const cid = await this.client.uploadFile(blob);
    return cid.toString();
  }

  async download(cid: string): Promise<Uint8Array> {
    const response = await fetch(`https://w3s.link/ipfs/${cid}`);
    if (!response.ok) {
      throw new Error(`Storacha download failed: ${response.status} ${response.statusText}`);
    }
    const buffer = await response.arrayBuffer();
    return new Uint8Array(buffer);
  }
}
```

- [ ] **Step 4: Create SynapseProvider**

Create `packages/sdk/src/storage/synapse.ts`:

```ts
import type { StorageProvider } from "./types.js";

/** Filecoin storage provider using the Synapse SDK. */
export class SynapseProvider implements StorageProvider {
  private client: any;

  /**
   * @param client - A configured @filoz/synapse-sdk client instance
   */
  constructor(client: any) {
    this.client = client;
  }

  async upload(data: Uint8Array): Promise<string> {
    const result = await this.client.upload(data);
    return result.cid.toString();
  }

  async download(cid: string): Promise<Uint8Array> {
    const data = await this.client.download(cid);
    return new Uint8Array(data);
  }
}
```

- [ ] **Step 5: Create GatewayProvider**

Create `packages/sdk/src/storage/gateway.ts`:

```ts
import type { StorageProvider } from "./types.js";

/** Generic IPFS HTTP API + gateway provider. */
export class GatewayProvider implements StorageProvider {
  private apiUrl: string;
  private gatewayUrl: string;

  /**
   * @param params.apiUrl - IPFS HTTP API endpoint (e.g. "http://localhost:5001")
   * @param params.gatewayUrl - IPFS gateway base URL (e.g. "https://gateway.pinata.cloud/ipfs")
   */
  constructor(params: { apiUrl: string; gatewayUrl: string }) {
    this.apiUrl = params.apiUrl.replace(/\/+$/, "");
    this.gatewayUrl = params.gatewayUrl.replace(/\/+$/, "");
  }

  async upload(data: Uint8Array): Promise<string> {
    const formData = new FormData();
    formData.append("file", new Blob([data]));

    const response = await fetch(`${this.apiUrl}/api/v0/add`, {
      method: "POST",
      body: formData,
    });

    if (!response.ok) {
      throw new Error(`IPFS API upload failed: ${response.status} ${response.statusText}`);
    }

    const result = await response.json();
    return result.Hash;
  }

  async download(cid: string): Promise<Uint8Array> {
    const response = await fetch(`${this.gatewayUrl}/${cid}`);
    if (!response.ok) {
      throw new Error(`IPFS gateway download failed: ${response.status} ${response.statusText}`);
    }
    const buffer = await response.arrayBuffer();
    return new Uint8Array(buffer);
  }
}
```

- [ ] **Step 6: Create storage barrel export**

Create `packages/sdk/src/storage/index.ts`:

```ts
export type { StorageProvider } from "./types.js";
export { HeliaProvider } from "./helia.js";
export { StorachaProvider } from "./storacha.js";
export { SynapseProvider } from "./synapse.js";
export { GatewayProvider } from "./gateway.js";
```

- [ ] **Step 7: Add storage exports to SDK barrel**

Add to `packages/sdk/src/index.ts` (after line 7, before the re-export lines):

```ts
export * from "./storage/index.js";
```

- [ ] **Step 8: Add optional peer dependencies**

Update `packages/sdk/package.json` to add peer dependencies and metadata. Add after the existing `peerDependencies` block:

```json
{
  "peerDependencies": {
    "viem": "^2.21",
    "helia": ">=5",
    "@helia/unixfs": ">=4",
    "@storacha/client": ">=1",
    "@filoz/synapse-sdk": ">=0.1",
    "multiformats": ">=13"
  },
  "peerDependenciesMeta": {
    "helia": { "optional": true },
    "@helia/unixfs": { "optional": true },
    "@storacha/client": { "optional": true },
    "@filoz/synapse-sdk": { "optional": true },
    "multiformats": { "optional": true }
  }
}
```

Note: `viem` remains required. All storage-related peers are optional.

- [ ] **Step 9: Build SDK to verify types**

Run: `cd packages/sdk && npx tsc --noEmit`
Expected: No errors

- [ ] **Step 10: Commit**

```bash
git add packages/sdk/src/storage/ packages/sdk/src/index.ts packages/sdk/package.json
git commit -m "feat(sdk): add StorageProvider interface and built-in providers (Helia, Storacha, Synapse, Gateway)"
```

---

### Task 5: Uploader.uploadFile

**Files:**
- Modify: `packages/sdk/src/uploader.ts:1-169`
- Create: `packages/sdk/__tests__/upload-file.test.ts`

- [ ] **Step 1: Write the failing tests**

Create `packages/sdk/__tests__/upload-file.test.ts`:

```ts
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
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd packages/sdk && npx vitest run __tests__/upload-file.test.ts`
Expected: FAIL — `uploadFile` does not exist on Uploader

- [ ] **Step 3: Implement Uploader.uploadFile**

Add imports at the top of `packages/sdk/src/uploader.ts` (modify existing import line 3):

Change line 3 from:
```ts
import { tdh2Encrypt, type TDH2Ciphertext } from "@piplabs/cdr-crypto";
```
to:
```ts
import { tdh2Encrypt, encryptFile, type TDH2Ciphertext } from "@piplabs/cdr-crypto";
```

Add import for errors and storage types after line 4:
```ts
import { ContentSizeExceededError } from "./errors.js";
import type { StorageProvider } from "./storage/types.js";
```

Add the `uploadFile` method to the `Uploader` class, before the `private parseVaultAllocatedUuid` method:

```ts
  /** Encrypt a file, upload to storage, and write CID + key reference to a new vault */
  async uploadFile(params: {
    content: Uint8Array;
    storageProvider: StorageProvider;
    globalPubKey: Uint8Array;
    updatable: boolean;
    writeConditionAddr: `0x${string}`;
    readConditionAddr: `0x${string}`;
    writeConditionData: `0x${string}`;
    readConditionData: `0x${string}`;
    accessAuxData: `0x${string}`;
    checkSize?: boolean;
    allocateFeeOverride?: bigint;
    writeFeeOverride?: bigint;
  }): Promise<{
    uuid: number;
    cid: string;
    ciphertext: TDH2Ciphertext;
    txHashes: { allocate: `0x${string}`; write: `0x${string}` };
  }> {
    const { content, storageProvider, checkSize = true } = params;

    // Step 1: Encrypt file with ephemeral AES key
    const { ciphertext: encryptedFile, key } = encryptFile(content);

    // Step 2: Upload encrypted file to storage
    const cid = await storageProvider.upload(encryptedFile);

    // Step 3: Build vault payload JSON
    const payload = JSON.stringify({ cid, key: toHex(key) });
    const payloadBytes = new TextEncoder().encode(payload);

    // Step 4: Size check (default on)
    if (checkSize) {
      const cdrAddress = contractAddresses[this.network].cdr;
      const maxSize = await this.publicClient.readContract({
        address: cdrAddress,
        abi: cdrAbi,
        functionName: "maxEncryptedDataSize",
      });
      // The TDH2 ciphertext will be larger than the plaintext payload.
      // Check the payload size against the limit as a conservative pre-flight.
      if (BigInt(payloadBytes.length) > maxSize) {
        throw new ContentSizeExceededError(payloadBytes.length, maxSize);
      }
    }

    // Step 5: Allocate vault
    const { txHash: allocateTx, uuid } = await this.allocate({
      updatable: params.updatable,
      writeConditionAddr: params.writeConditionAddr,
      readConditionAddr: params.readConditionAddr,
      writeConditionData: params.writeConditionData,
      readConditionData: params.readConditionData,
      feeOverride: params.allocateFeeOverride,
    });

    // Step 6: TDH2-encrypt the payload with UUID-derived label
    const label = uuidToLabel(uuid);
    const ciphertext = await this.encryptDataKey({
      dataKey: payloadBytes,
      globalPubKey: params.globalPubKey,
      label,
    });

    // Step 7: Write to vault
    const encryptedDataHex = toHex(ciphertext.raw);
    const { txHash: writeTx } = await this.write({
      uuid,
      accessAuxData: params.accessAuxData,
      encryptedData: encryptedDataHex,
      feeOverride: params.writeFeeOverride,
    });

    return {
      uuid,
      cid,
      ciphertext,
      txHashes: { allocate: allocateTx, write: writeTx },
    };
  }
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd packages/sdk && npx vitest run __tests__/upload-file.test.ts`
Expected: All 3 tests PASS

- [ ] **Step 5: Run all existing SDK tests to verify no regressions**

Run: `cd packages/sdk && npx vitest run`
Expected: All tests PASS

- [ ] **Step 6: Commit**

```bash
git add packages/sdk/src/uploader.ts packages/sdk/__tests__/upload-file.test.ts
git commit -m "feat(sdk): add Uploader.uploadFile for storage-backed vault writes"
```

---

### Task 6: Consumer.downloadFile

**Files:**
- Modify: `packages/sdk/src/consumer.ts:1-257`
- Create: `packages/sdk/__tests__/download-file.test.ts`

- [ ] **Step 1: Write the failing tests**

Create `packages/sdk/__tests__/download-file.test.ts`:

```ts
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
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd packages/sdk && npx vitest run __tests__/download-file.test.ts`
Expected: FAIL — `downloadFile` does not exist on Consumer

- [ ] **Step 3: Implement Consumer.downloadFile**

Add imports at the top of `packages/sdk/src/consumer.ts`. Change line 4 from:

```ts
import { decryptPartial as eciesDecrypt, tdh2Combine, verifyPartialSignature, type TDH2Ciphertext, type DecryptedPartial } from "@piplabs/cdr-crypto";
```

to:

```ts
import { decryptPartial as eciesDecrypt, tdh2Combine, verifyPartialSignature, decryptFile, type TDH2Ciphertext, type DecryptedPartial } from "@piplabs/cdr-crypto";
```

Add import for storage types after line 6:

```ts
import type { StorageProvider } from "./storage/types.js";
```

Add the following import for viem's `fromHex` — change line 1 from:

```ts
import { parseEventLogs, toBytes, type PublicClient, type WalletClient } from "viem";
```

to:

```ts
import { parseEventLogs, toBytes, fromHex, type PublicClient, type WalletClient } from "viem";
```

Add the `downloadFile` method to the `Consumer` class, after the `accessCDR` method (before the closing `}`):

```ts
  /** Convenience: access vault, parse CID + key payload, download from storage, and decrypt file */
  async downloadFile(params: {
    uuid: number;
    accessAuxData: `0x${string}`;
    requesterPubKey: `0x${string}`;
    recipientPrivKey: Uint8Array;
    globalPubKey: Uint8Array;
    threshold: number;
    storageProvider: StorageProvider;
    timeoutMs?: number;
    feeOverride?: bigint;
    onInvalidPartial?: (event: PartialDecryptionEvent, error: Error) => void;
  }): Promise<{
    content: Uint8Array;
    cid: string;
    txHash: `0x${string}`;
  }> {
    // Step 1: Access vault to get decrypted payload
    const { dataKey: payloadBytes, txHash } = await this.accessCDR({
      uuid: params.uuid,
      accessAuxData: params.accessAuxData,
      requesterPubKey: params.requesterPubKey,
      recipientPrivKey: params.recipientPrivKey,
      globalPubKey: params.globalPubKey,
      threshold: params.threshold,
      timeoutMs: params.timeoutMs,
      feeOverride: params.feeOverride,
      onInvalidPartial: params.onInvalidPartial,
    });

    // Step 2: Parse JSON payload
    const payloadStr = new TextDecoder().decode(payloadBytes);
    const { cid, key: keyHex } = JSON.parse(payloadStr) as { cid: string; key: `0x${string}` };
    const key = fromHex(keyHex, "bytes");

    // Step 3: Download encrypted file from storage
    const encryptedFile = await params.storageProvider.download(cid);

    // Step 4: Decrypt file
    const content = decryptFile({ ciphertext: encryptedFile, key });

    return { content, cid, txHash };
  }
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd packages/sdk && npx vitest run __tests__/download-file.test.ts`
Expected: All tests PASS

- [ ] **Step 5: Run all SDK tests to verify no regressions**

Run: `cd packages/sdk && npx vitest run`
Expected: All tests PASS

- [ ] **Step 6: Commit**

```bash
git add packages/sdk/src/consumer.ts packages/sdk/__tests__/download-file.test.ts
git commit -m "feat(sdk): add Consumer.downloadFile for storage-backed vault reads"
```

---

### Task 7: Final Build Verification

**Files:** None (verification only)

- [ ] **Step 1: Build all packages**

Run: `npx turbo build`
Expected: All packages build successfully

- [ ] **Step 2: Run all tests**

Run: `npx turbo test`
Expected: All tests PASS across all packages

- [ ] **Step 3: Run lint**

Run: `npx turbo lint`
Expected: No type errors

- [ ] **Step 4: Commit any fixes if needed**

If the build/test/lint steps surfaced issues, fix them and commit:

```bash
git add -A
git commit -m "fix: address build/test issues from storage upload feature"
```
