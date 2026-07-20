# CDR SDK User Guide

The **CDR (Confidential Data Rails) SDK** provides a TypeScript interface for encrypting, storing, and recovering confidential data on Story L1 using threshold cryptography. Data is encrypted to a Distributed Key Generation (DKG) global public key and can only be decrypted when a threshold of validators provide partial decryptions.

## Table of Contents

- [Installation](#installation)
- [Quick Start](#quick-start)
- [Network Configuration](#network-configuration)
- [Core Concepts](#core-concepts)
- [API Reference](#api-reference)
  - [CDRClient](#cdrclient)
  - [Observer (Read-Only)](#observer-read-only)
  - [Uploader (Write)](#uploader-write)
  - [Consumer (Read/Decrypt)](#consumer-readdecrypt)
  - [License Helper](#license-helper)
- [Examples](#examples)
  - [Query DKG State](#query-dkg-state)
  - [Upload Encrypted Data](#upload-encrypted-data)
  - [Access and Decrypt Data](#access-and-decrypt-data)
- [Error Handling](#error-handling)
- [CLI](#cli)

---

## Installation

```bash
npm install @piplabs/cdr-sdk viem
```

`viem` (v2.21+) is a required peer dependency.

---

## Quick Start

```typescript
import { createPublicClient, createWalletClient, http, toHex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { CDRClient, initWasm } from "@piplabs/cdr-sdk";

// 1. Initialize the WASM module (required once, before any crypto operations)
await initWasm();

// 2. Set up viem clients
const account = privateKeyToAccount("0xYOUR_PRIVATE_KEY");
const publicClient = createPublicClient({ transport: http("https://aeneid.storyrpc.io") });
const walletClient = createWalletClient({ account, transport: http("https://aeneid.storyrpc.io") });
const apiUrl = "http://172.192.41.96:1317"; // Story-API REST endpoint

// 3. Create a CDR client
const client = new CDRClient({ network: "testnet", publicClient, walletClient, apiUrl });

// 4. Upload encrypted data
const globalPubKey = await client.observer.getGlobalPubKey();
const dataKey = crypto.getRandomValues(new Uint8Array(32));

const { uuid, txHashes } = await client.uploader.uploadCDR({
  dataKey,
  globalPubKey,
  updatable: false,
  writeConditionAddr: "0xYOUR_WRITE_CONDITION_CONTRACT",
  readConditionAddr: "0xYOUR_READ_CONDITION_CONTRACT",
  writeConditionData: "0x",
  readConditionData: "0x",
  accessAuxData: "0x",
});

console.log("Vault UUID:", uuid);
```

---

## Network Configuration

The SDK supports multiple Story L1 networks. You select a network when creating the `CDRClient`, and optionally override the RPC URL via the viem transport.

### Supported Networks

| Network    | `network` param | Default RPC URL                     | Description                          |
|------------|-----------------|-------------------------------------|--------------------------------------|
| Testnet    | `"testnet"`     | `https://aeneid.storyrpc.io`        | Aeneid testnet (chain ID 1315)       |
| Mainnet    | `"mainnet"`     | `https://rpc.story.foundation`      | Production network                   |

### Contract Addresses

Both networks use the same pre-deployed system contract addresses:

| Contract | Address                                        |
|----------|------------------------------------------------|
| DKG      | `0xcccccc0000000000000000000000000000000004`    |
| CDR      | `0xcccccc0000000000000000000000000000000005`    |

### Connecting to Different Networks

**Testnet (default for development):**

```typescript
const publicClient = createPublicClient({
  transport: http("https://aeneid.storyrpc.io"),
});
const client = new CDRClient({
  network: "testnet",
  publicClient,
  apiUrl: "http://172.192.41.96:1317",
});
```

**Mainnet:**

```typescript
const publicClient = createPublicClient({
  transport: http("https://rpc.story.foundation"),
});
const client = new CDRClient({
  network: "mainnet",
  publicClient,
  apiUrl: "https://your-mainnet-story-api.example.com",
});
```

**Custom RPC URL (devnets, local nodes, or third-party providers):**

You can point the SDK to any Story-compatible EVM RPC endpoint by changing the `http()` transport URL. `apiUrl` must point to the matching Story-API REST endpoint. This is useful for:

- **Devnets / private testnets** run by your team
- **Local development nodes** (e.g., `http://localhost:8545`)
- **Third-party RPC providers** with higher rate limits

```typescript
// Connect to a devnet
const publicClient = createPublicClient({
  transport: http("https://your-devnet-rpc.example.com"),
});
const walletClient = createWalletClient({
  account,
  transport: http("https://your-devnet-rpc.example.com"),
});
const apiUrl = "https://your-devnet-story-api.example.com";

// Use "testnet" or "mainnet" depending on which contract addresses your devnet uses.
// If the devnet mirrors testnet contracts, use "testnet".
const client = new CDRClient({ network: "testnet", publicClient, walletClient, apiUrl });
```

> **Note:** The `network` parameter determines which contract addresses the SDK uses. When pointing to a custom RPC, choose the `network` value that matches the contract deployment on that chain. Both `"testnet"` and `"mainnet"` currently use the same contract addresses, but this may change in the future.

### Using Environment Variables

A common pattern is to configure the network via environment variables:

```typescript
const RPC_URL = process.env.RPC_URL ?? "https://aeneid.storyrpc.io";
const API_URL = process.env.API_URL ?? "http://172.192.41.96:1317";
const NETWORK = (process.env.NETWORK ?? "testnet") as "testnet" | "mainnet";

const publicClient = createPublicClient({ transport: http(RPC_URL) });
const client = new CDRClient({ network: NETWORK, publicClient, apiUrl: API_URL });
```

```bash
# Testnet (default)
RPC_URL=https://aeneid.storyrpc.io API_URL=http://172.192.41.96:1317 NETWORK=testnet node app.js

# Mainnet
RPC_URL=https://rpc.story.foundation API_URL=https://your-mainnet-story-api.example.com NETWORK=mainnet node app.js

# Custom devnet
RPC_URL=http://localhost:8545 API_URL=http://localhost:1317 NETWORK=testnet node app.js
```

---

## Core Concepts

### Vaults

A **vault** is an on-chain container for encrypted data. Each vault has:

- A **UUID** (assigned on allocation)
- **Write/read condition contracts** that enforce access control
- **Encrypted data** (TDH2 ciphertext)
- An **updatable** flag controlling whether the vault contents can be rewritten

### Threshold Encryption (TDH2)

Data is encrypted to the DKG **global public key** — no single party holds the corresponding private key. To decrypt, a **threshold** number of validators must each provide a partial decryption. The SDK handles:

1. Encrypting your data key to the global public key
2. Submitting a read request on-chain
3. Collecting encrypted partial decryptions from validators
4. ECIES-decrypting each partial and TDH2-combining them to recover the data key

### Client Modes

- **Read-only** (no `walletClient`): Can query DKG state, vault info, and fees via `client.observer`
- **Read-write** (with `walletClient`): Can also upload (`client.uploader`) and access (`client.consumer`) vault data

---

## API Reference

### CDRClient

The main entry point. Provides access to `observer`, `uploader`, and `consumer` sub-clients.

```typescript
const client = new CDRClient({
  network: "testnet" | "mainnet",
  publicClient: CDRPublicClient,  // viem, wagmi, or custom structural public client
  walletClient?: CDRWalletClient, // optional; required for upload/access operations
  apiUrl: string,                 // Story-API REST endpoint
  logger?: CDRLogger,             // optional structured logger
});

client.observer   // Always available — read-only queries
client.uploader   // Requires walletClient — throws WalletClientRequiredError otherwise
client.consumer   // Requires walletClient — throws WalletClientRequiredError otherwise
```

### Observer (Read-Only)

Query on-chain state without a wallet.

| Method | Returns | Description |
|--------|---------|-------------|
| `getVault(uuid)` | `Vault` | Get vault details by UUID |
| `getAllocateFee()` | `bigint` | Current vault allocation fee (wei) |
| `getWriteFee()` | `bigint` | Current write fee (wei) |
| `getReadFee()` | `bigint` | Current read fee (wei) |
| `getGlobalPubKey()` | `Uint8Array` | DKG global public key (with Ed25519 curve prefix) |
| `getOperationalThreshold()` | `bigint` | Raw operational threshold (parts per 1000) |
| `getParticipantCount()` | `number` | Number of DKG participants in latest round |
| `getThreshold()` | `number` | Active round partial-decryption threshold |

### Uploader (Write)

Encrypt and store data in CDR vaults. Requires a `walletClient`.

#### `uploadCDR(params)` — High-Level (Recommended)

Allocates a vault, encrypts the data key, and writes the ciphertext in one call.

```typescript
const { uuid, ciphertext, txHashes } = await client.uploader.uploadCDR({
  dataKey: Uint8Array,                    // 32-byte key to encrypt
  globalPubKey: Uint8Array,               // from observer.getGlobalPubKey()
  updatable: boolean,                     // can vault data be rewritten?
  writeConditionAddr: `0x${string}`,      // access control contract for writes
  readConditionAddr: `0x${string}`,       // access control contract for reads
  writeConditionData: `0x${string}`,      // calldata for write condition check
  readConditionData: `0x${string}`,       // calldata for read condition check
  accessAuxData: `0x${string}`,           // auxiliary data passed to condition check
  allocateFeeOverride?: bigint,           // optional: override auto-queried fee
  writeFeeOverride?: bigint,              // optional: override auto-queried fee
});
```

#### Low-Level Methods

| Method | Description |
|--------|-------------|
| `encryptDataKey({ dataKey, globalPubKey, label })` | TDH2-encrypt a data key |
| `allocate({ updatable, writeConditionAddr, readConditionAddr, ... })` | Create a vault on-chain, returns `{ txHash, uuid }` |
| `write({ uuid, accessAuxData, encryptedData })` | Write encrypted data to an existing vault |

### Consumer (Read/Decrypt)

Access and decrypt vault data. Requires a `walletClient`.

#### `accessCDR(params)` — High-Level (Recommended)

Reads, collects partial decryptions, and decrypts in one call.

```typescript
import { secp256k1 } from "@noble/curves/secp256k1";

const privKeyBytes = Buffer.from(PRIVATE_KEY.slice(2), "hex");
const requesterPubKey = toHex(secp256k1.getPublicKey(privKeyBytes, false));

const { dataKey, txHash } = await client.consumer.accessCDR({
  uuid: number,                           // vault UUID
  accessAuxData: `0x${string}`,           // auxiliary data for condition check
  requesterPubKey: `0x${string}`,         // your uncompressed secp256k1 public key
  recipientPrivKey: Uint8Array,           // your private key bytes (for ECIES decryption)
  globalPubKey?: Uint8Array,              // optional; auto-queried if omitted
  timeoutMs?: number,                     // partial collection timeout (default: 180000)
  pollIntervalMs?: number,                // fixed poll rate; disables adaptive backoff
  minIntervalMs?: number,                 // adaptive backoff floor (default: 2000)
  maxIntervalMs?: number,                 // optional backoff ceiling (default: uncapped)
  feeOverride?: bigint,                   // optional: override auto-queried read fee
});
```

#### Low-Level Methods

| Method | Description |
|--------|-------------|
| `read({ uuid, accessAuxData, requesterPubKey, feeOverride? })` | Submit a read request on-chain |
| `collectPartials({ uuid, requesterPubKey, timeoutMs?, pollIntervalMs?, minIntervalMs?, maxIntervalMs?, attestationConfig? })` | Poll Story-API for partial decryptions (adaptive backoff by default; `pollIntervalMs` forces a fixed rate) |
| `decryptDataKey({ ciphertext, partials, recipientPrivKey, globalPubKey, label })` | Decrypt and combine partials |

Partial collection polls with **adaptive exponential backoff**: waits start at
2s and grow ×1.5 per poll, bounded only by `timeoutMs` (each wait is clamped
to the remaining budget) — partials mostly arrive shortly after the read tx,
so polling thins out over time, and collection returns as soon as enough
partials are seen. Set `maxIntervalMs` to cap the curve, or `pollIntervalMs`
for a fixed rate (mutually exclusive with the min/max options).

### License Helper

Mints Story Protocol license tokens for reading `LicenseReadCondition`-gated vaults, handling the WIP fee automatically (predict fee → wrap native DATA → approve RoyaltyModule → mint). Requires a `walletClient`.

```typescript
const { licenseTokenIds, feePaid, wrappedWei, txHashes } =
  await client.license.mintLicenseToken({
    licensorIpId: `0x${string}`,   // the licensor IP asset (IP ID)
    licenseTermsId: bigint | number,
    amount?: bigint | number,      // default 1
    receiver?: `0x${string}`,      // default: your wallet address
    autoWrap?: boolean,            // default true — wrap missing WIP from native
    autoApprove?: boolean,         // default true — approve RoyaltyModule (maxUint256)
  });
```

Fee preparation is idempotent — wrap/approve steps are skipped (and absent from `txHashes`) when the balance or a standing allowance already covers the fee. Only WIP-denominated license terms are supported; other currencies throw `UnsupportedLicenseCurrencyError`. Also available without a `CDRClient` as the standalone `mintLicenseToken({ publicClient, walletClient, ... })` export.

---

## Examples

### Query DKG State

Read-only — no wallet or WASM needed.

```typescript
import { createPublicClient, http } from "viem";
import { CDRClient } from "@piplabs/cdr-sdk";

const publicClient = createPublicClient({ transport: http("https://aeneid.storyrpc.io") });
const client = new CDRClient({
  network: "testnet",
  publicClient,
  apiUrl: "http://172.192.41.96:1317",
});

const threshold = await client.observer.getOperationalThreshold();
console.log("Operational threshold:", threshold);

const [allocateFee, writeFee, readFee] = await Promise.all([
  client.observer.getAllocateFee(),
  client.observer.getWriteFee(),
  client.observer.getReadFee(),
]);
console.log(`Fees — allocate: ${allocateFee}, write: ${writeFee}, read: ${readFee}`);

// Query a specific vault
const vault = await client.observer.getVault(1);
console.log("Vault:", vault);
```

### Upload Encrypted Data

```typescript
import { createPublicClient, createWalletClient, http, toHex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { CDRClient, initWasm } from "@piplabs/cdr-sdk";

await initWasm();

const account = privateKeyToAccount("0xYOUR_PRIVATE_KEY");
const publicClient = createPublicClient({ transport: http("https://aeneid.storyrpc.io") });
const walletClient = createWalletClient({ account, transport: http("https://aeneid.storyrpc.io") });
const client = new CDRClient({
  network: "testnet",
  publicClient,
  walletClient,
  apiUrl: "http://172.192.41.96:1317",
});

// Fetch DKG global public key
const globalPubKey = await client.observer.getGlobalPubKey();

// Generate a random 32-byte data key to encrypt
const dataKey = crypto.getRandomValues(new Uint8Array(32));
console.log("Data key:", toHex(dataKey));

// Upload: allocate vault + encrypt + write (all in one call)
const { uuid, txHashes } = await client.uploader.uploadCDR({
  dataKey,
  globalPubKey,
  updatable: false,
  writeConditionAddr: "0xYOUR_WRITE_CONDITION",
  readConditionAddr: "0xYOUR_READ_CONDITION",
  writeConditionData: "0x",
  readConditionData: "0x",
  accessAuxData: "0x",
});

console.log("Vault UUID:", uuid);
console.log("Allocate tx:", txHashes.allocate);
console.log("Write tx:", txHashes.write);
```

### Access and Decrypt Data

```typescript
import { createPublicClient, createWalletClient, http, toHex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { secp256k1 } from "@noble/curves/secp256k1";
import { CDRClient, initWasm } from "@piplabs/cdr-sdk";

await initWasm();

const PRIVATE_KEY = "0xYOUR_PRIVATE_KEY";
const account = privateKeyToAccount(PRIVATE_KEY as `0x${string}`);
const publicClient = createPublicClient({ transport: http("https://aeneid.storyrpc.io") });
const walletClient = createWalletClient({ account, transport: http("https://aeneid.storyrpc.io") });
const client = new CDRClient({
  network: "testnet",
  publicClient,
  walletClient,
  apiUrl: "http://172.192.41.96:1317",
});

// Optionally prefetch DKG parameters
const globalPubKey = await client.observer.getGlobalPubKey();

// Derive secp256k1 public key for ECIES
const privKeyBytes = Buffer.from(PRIVATE_KEY.slice(2), "hex");
const requesterPubKey = toHex(secp256k1.getPublicKey(privKeyBytes, false));

// Access: read + collect partials + decrypt (all in one call)
const { dataKey, txHash } = await client.consumer.accessCDR({
  uuid: 1,  // your vault UUID
  accessAuxData: "0x",
  requesterPubKey: requesterPubKey as `0x${string}`,
  recipientPrivKey: privKeyBytes,
  globalPubKey,
});

console.log("Recovered data key:", toHex(dataKey));
```

---

## Error Handling

The SDK throws typed errors you can catch and handle:

| Error Class | Code | When |
|-------------|------|------|
| `WalletClientRequiredError` | `WALLET_CLIENT_REQUIRED` | Accessing `uploader` or `consumer` without a `walletClient` |
| `PartialCollectionTimeoutError` | `PARTIAL_COLLECTION_TIMEOUT` | `collectPartials` or `accessCDR` times out waiting for validator responses |
| `ContractRevertError` | `CONTRACT_REVERT` | On-chain transaction reverted |
| `InsufficientBalanceError` | `INSUFFICIENT_BALANCE` | Wallet balance is below the read fee before `read()` submits a tx |
| `InvalidPartialError` | `INVALID_PARTIAL` | A partial is rejected and reported through `onInvalidPartial` |
| `InvalidHexError` | `INVALID_HEX` | Story-API hex decoding receives malformed input |
| `AttestationQuoteError` | `ATTESTATION_QUOTE` | SGX quote bytes are too short or use an unsupported quote version |
| `VaultAllocatedEventNotFoundError` | `VAULT_ALLOCATED_EVENT_NOT_FOUND` | Allocation receipt does not contain the expected event |

All errors extend `CDRError`, which has a `code` property for programmatic handling:

```typescript
import { CDRError, PartialCollectionTimeoutError } from "@piplabs/cdr-sdk";

try {
  const { dataKey } = await client.consumer.accessCDR({ ... });
} catch (err) {
  if (err instanceof PartialCollectionTimeoutError) {
    console.error("Not enough validators responded in time. Try increasing timeoutMs.");
  } else if (err instanceof CDRError) {
    console.error(`CDR error [${err.code}]: ${err.message}`);
  }
}
```

---

## CLI

The SDK ships with a CLI tool for quick interactions. From the repository:

```bash
cd apps/cli
pnpm dev -- --help
```

### Global Options

```
--network <network>      Network: mainnet or testnet (default: testnet)
--rpc-url <url>          Override RPC endpoint
--private-key <hex>      Wallet private key (or CDR_PRIVATE_KEY env var)
--json                   Output in JSON format
```

### Commands

```bash
# Query vault details
pnpm dev -- status vault <uuid> --network testnet

# Query fees
pnpm dev -- status fees --network mainnet --rpc-url https://rpc.story.foundation

# Allocate a new vault
pnpm dev -- allocate --private-key 0x...

# Write encrypted data to vault
pnpm dev -- write --private-key 0x... --uuid 1

# Request vault read
pnpm dev -- read --private-key 0x... --uuid 1

# Encrypt a data key
pnpm dev -- encrypt

# Decrypt partial decryptions
pnpm dev -- decrypt
```

### Running Examples

From the repository root:

```bash
# Query DKG state (no wallet needed)
pnpm --filter @piplabs/cdr-examples query

# Upload encrypted data
CDR_PRIVATE_KEY=0x... WRITE_CONDITION=0x... READ_CONDITION=0x... pnpm --filter @piplabs/cdr-examples upload

# Access and decrypt vault data
CDR_PRIVATE_KEY=0x... VAULT_UUID=1 pnpm --filter @piplabs/cdr-examples access

# Full end-to-end demo
CDR_PRIVATE_KEY=0x... WRITE_CONDITION=0x... READ_CONDITION=0x... pnpm --filter @piplabs/cdr-examples e2e
```
