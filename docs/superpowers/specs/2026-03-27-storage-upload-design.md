# Storage Upload Design Spec

## Overview

Add SDK support for uploading files to decentralized storage (IPFS via Helia, Filecoin via Synapse, Storacha via w3up) and writing their CIDs to CDR vaults. Files are encrypted with an ephemeral AES-256-GCM key before upload so that only vault readers can decrypt the content. The CID and encryption key are stored in the vault as a compact JSON payload.

## Motivation

CDR vaults have an on-chain size limit (`maxEncryptedDataSize()` on the CDR contract). This feature allows large file uploads by storing the encrypted file off-chain and only keeping a small reference (CID + key) in the vault.

## File Encryption (`packages/crypto`)

New file: `packages/crypto/src/file-encryption.ts`

Two exported functions:

### `encryptFile(plaintext: Uint8Array): { ciphertext: Uint8Array; key: Uint8Array }`

- Generates a random 32-byte AES-256-GCM key via `randomBytes(32)`
- Generates a random 12-byte IV via `randomBytes(12)`
- Encrypts plaintext with AES-256-GCM
- Returns `ciphertext` as `IV (12 bytes) || GCM ciphertext+tag` and the 32-byte `key`
- Uses `@noble/ciphers/aes` (`gcm`) and `@noble/hashes/utils` (`randomBytes`) — both already dependencies

### `decryptFile(params: { ciphertext: Uint8Array; key: Uint8Array }): Uint8Array`

- Splits ciphertext into IV (first 12 bytes) and GCM ciphertext+tag (remainder)
- Decrypts with AES-256-GCM using the provided key
- Returns the original plaintext

Both functions are re-exported from `packages/crypto/src/index.ts`.

## StorageProvider Interface (`packages/sdk`)

New file: `packages/sdk/src/storage/types.ts`

```ts
export interface StorageProvider {
  upload(data: Uint8Array): Promise<string>;
  download(cid: string): Promise<Uint8Array>;
}
```

Minimal interface — upload bytes and get a CID string, download bytes by CID. Users can implement their own providers.

## Built-in Storage Providers

All in `packages/sdk/src/storage/`. Each wraps an external SDK that is an **optional peer dependency** — users only install what they need.

### `helia.ts` — HeliaProvider

Wraps the Helia SDK (`helia`, `@helia/unixfs`). User passes a Helia node instance.

```ts
export class HeliaProvider implements StorageProvider {
  constructor(helia: HeliaInstance)
  async upload(data: Uint8Array): Promise<string>
  async download(cid: string): Promise<Uint8Array>
}
```

- Upload: adds bytes via UnixFS, returns CID string
- Download: retrieves bytes via UnixFS by CID

### `storacha.ts` — StorachaProvider

Wraps `@storacha/client`. User passes a configured Storacha client.

```ts
export class StorachaProvider implements StorageProvider {
  constructor(client: StorachaClient)
  async upload(data: Uint8Array): Promise<string>
  async download(cid: string): Promise<Uint8Array>
}
```

### `synapse.ts` — SynapseProvider

Wraps `@filoz/synapse-sdk` for Filecoin storage. User passes a Synapse client.

```ts
export class SynapseProvider implements StorageProvider {
  constructor(client: SynapseClient)
  async upload(data: Uint8Array): Promise<string>
  async download(cid: string): Promise<Uint8Array>
}
```

### `gateway.ts` — GatewayProvider

Generic IPFS HTTP gateway provider. User provides API and gateway URLs.

```ts
export class GatewayProvider implements StorageProvider {
  constructor(params: { apiUrl: string; gatewayUrl: string })
  async upload(data: Uint8Array): Promise<string>
  async download(cid: string): Promise<Uint8Array>
}
```

- Upload: POST to IPFS HTTP API (`/api/v0/add`)
- Download: GET from gateway (`{gatewayUrl}/{cid}`)

## Vault Payload Format

When `uploadFile` writes to a vault, the data stored (before TDH2 encryption) is a compact JSON object encoded to UTF-8 bytes:

```json
{"cid":"bafy...","key":"0xabcd..."}
```

- `cid` — CID string from the storage provider
- `key` — hex-encoded 32-byte AES-256-GCM key

This JSON replaces the raw `dataKey` in the existing `uploadCDR` flow. The JSON bytes are TDH2-encrypted with the UUID-derived label and written to the vault's `encryptedData` field.

## Uploader.uploadFile

New method on the existing `Uploader` class.

### Signature

```ts
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
  checkSize?: boolean;            // default: true
  allocateFeeOverride?: bigint;
  writeFeeOverride?: bigint;
}): Promise<{
  uuid: number;
  cid: string;
  ciphertext: TDH2Ciphertext;
  txHashes: { allocate: `0x${string}`; write: `0x${string}` };
}>
```

### Flow

1. **Encrypt file**: `encryptFile(content)` returns `{ ciphertext: encryptedFileBytes, key }`
2. **Upload to storage**: `storageProvider.upload(encryptedFileBytes)` returns `cid`
3. **Build vault payload**: JSON `{"cid":"...","key":"0x..."}` encoded to UTF-8 bytes
4. **Size check** (default on): Read `maxEncryptedDataSize()` from CDR contract. Estimate TDH2 ciphertext size from the vault payload length. If it would exceed the limit, throw `ContentSizeExceededError` before any on-chain transactions.
5. **Allocate vault**: `this.allocate(...)` returns `uuid`
6. **TDH2-encrypt payload**: Encrypt the JSON bytes with UUID-derived label and `globalPubKey`
7. **Write to vault**: `this.write(...)` with the TDH2 ciphertext

The size check happens at step 4, before allocating or writing, so no gas is wasted if the payload is too large.

## Consumer.downloadFile

New method on the existing `Consumer` class.

### Signature

```ts
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
}>
```

### Flow

1. **Access vault**: Call existing `accessCDR()` to decrypt the vault payload (JSON bytes)
2. **Parse payload**: Extract `cid` and `key` from the JSON
3. **Download from storage**: `storageProvider.download(cid)` returns encrypted file bytes
4. **Decrypt file**: `decryptFile({ ciphertext: encryptedBytes, key })` returns original content
5. Return `{ content, cid, txHash }`

## Observer.getMaxEncryptedDataSize

New method on the existing `Observer` class:

```ts
async getMaxEncryptedDataSize(): Promise<bigint>
```

Reads `maxEncryptedDataSize()` from the CDR contract. Used by `Uploader.uploadFile` for the size check and also available to users directly.

## Contract ABI Update

Add `maxEncryptedDataSize` view function to `packages/contracts/src/abis/cdr.ts`:

```ts
{
  type: "function",
  name: "maxEncryptedDataSize",
  inputs: [],
  outputs: [{ name: "", type: "uint256" }],
  stateMutability: "view",
}
```

## New Error Class

`ContentSizeExceededError` in `packages/sdk/src/errors.ts`:

```ts
export class ContentSizeExceededError extends CDRError {
  constructor(public actual: number, public max: bigint) {
    super(`Vault payload size ${actual} bytes exceeds max ${max} bytes`);
  }
}
```

## Exports

### `packages/crypto/src/index.ts`

Add: `export { encryptFile, decryptFile } from "./file-encryption.js"`

### `packages/sdk/src/index.ts`

Add: `export type { StorageProvider } from "./storage/types.js"`
Add: `export { HeliaProvider } from "./storage/helia.js"`
Add: `export { StorachaProvider } from "./storage/storacha.js"`
Add: `export { SynapseProvider } from "./storage/synapse.js"`
Add: `export { GatewayProvider } from "./storage/gateway.js"`

### `packages/sdk/src/storage/index.ts`

Barrel file re-exporting all storage types and providers.

## Dependencies

### `packages/sdk/package.json`

New optional peer dependencies:
- `helia` — for HeliaProvider
- `@helia/unixfs` — for HeliaProvider
- `@storacha/client` — for StorachaProvider
- `@filoz/synapse-sdk` — for SynapseProvider

All marked as `optional: true` in `peerDependenciesMeta`.

### `packages/crypto/package.json`

No new dependencies — `@noble/ciphers` and `@noble/hashes` are already present.

## Testing

### `packages/crypto/__tests__/file-encryption.test.ts`

- Round-trip: encrypt then decrypt returns original plaintext
- Different plaintexts produce different ciphertexts (random key/IV)
- Decryption with wrong key throws
- Empty plaintext works
- Large plaintext works

### `packages/sdk/__tests__/storage/`

- Unit tests for each provider (mocked external SDKs)
- Unit tests for `uploadFile` / `downloadFile` (mocked storage provider + mocked viem clients)
- Test size check: payload exceeding `maxEncryptedDataSize` throws `ContentSizeExceededError`
- Test vault payload JSON serialization/deserialization round-trip

## File Changes Summary

New files:
- `packages/crypto/src/file-encryption.ts`
- `packages/crypto/__tests__/file-encryption.test.ts`
- `packages/sdk/src/storage/types.ts`
- `packages/sdk/src/storage/index.ts`
- `packages/sdk/src/storage/helia.ts`
- `packages/sdk/src/storage/storacha.ts`
- `packages/sdk/src/storage/synapse.ts`
- `packages/sdk/src/storage/gateway.ts`
- `packages/sdk/__tests__/storage/` (test files)

Modified files:
- `packages/crypto/src/index.ts` — add file encryption exports
- `packages/contracts/src/abis/cdr.ts` — add `maxEncryptedDataSize` ABI entry
- `packages/sdk/src/uploader.ts` — add `uploadFile` method
- `packages/sdk/src/consumer.ts` — add `downloadFile` method
- `packages/sdk/src/observer.ts` — add `getMaxEncryptedDataSize` method
- `packages/sdk/src/errors.ts` — add `ContentSizeExceededError`
- `packages/sdk/src/index.ts` — add storage exports
- `packages/sdk/package.json` — add optional peer dependencies
