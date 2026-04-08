# End-to-End Scenarios

Complete code examples for common CDR vault patterns. Each scenario shows the full flow from vault creation to data retrieval.

## Prerequisites

All scenarios assume the following setup:

```typescript
import {
  CDRClient,
  conditions,
  type ConditionConfig,
} from "@piplabs/cdr-sdk";
import { createPublicClient, createWalletClient, http } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { storyOdyssey } from "./chains"; // your chain config

const publicClient = createPublicClient({ chain: storyOdyssey, transport: http() });
const walletClient = createWalletClient({
  chain: storyOdyssey,
  transport: http(),
  account: privateKeyToAccount("0x..."),
});

const client = new CDRClient({
  network: "odyssey",
  publicClient,
  walletClient,
});
```

---

## Scenario 1: Owner-Only Vault

Only the vault creator can write and read.

### Create the vault

```typescript
const owner = walletClient.account.address;

const writeCondition = conditions.ownerOnly({
  address: "0x<OwnerConditionContractAddress>",
  owner,
});
const readCondition = conditions.ownerOnly({
  address: "0x<OwnerConditionContractAddress>",
  owner,
});

// Fetch DKG public key for encryption
const globalPubKey = await client.observer.getGlobalPubKey();

const dataKey = new TextEncoder().encode("my secret data");

const result = await client.uploader.uploadCDR({
  dataKey,
  globalPubKey,
  updatable: false,
  writeConditionAddr: writeCondition.address,
  readConditionAddr: readCondition.address,
  writeConditionData: writeCondition.conditionData,
  readConditionData: readCondition.conditionData,
  accessAuxData: "0x",
});

console.log("Vault UUID:", result.uuid);
```

### Read the vault (simplified API)

```typescript
// Ephemeral keypair and DKG params are auto-managed
const { dataKey: recovered } = await client.consumer.accessCDR({
  uuid: result.uuid,
  accessAuxData: "0x",
});

console.log("Recovered:", new TextDecoder().decode(recovered));
```

### Read the vault (explicit keys)

```typescript
import { generateEphemeralKeyPair } from "@piplabs/cdr-crypto";
import { toHex } from "viem";

const globalPubKey = await client.observer.getGlobalPubKey();
const threshold = await client.observer.getThreshold();
const { privateKey, publicKey } = generateEphemeralKeyPair();

try {
  const { dataKey: recovered } = await client.consumer.accessCDR({
    uuid: result.uuid,
    accessAuxData: "0x",
    requesterPubKey: toHex(publicKey),
    recipientPrivKey: privateKey,
    globalPubKey,
    threshold,
  });
  console.log("Recovered:", new TextDecoder().decode(recovered));
} finally {
  privateKey.fill(0); // zero the private key
}
```

---

## Scenario 2: Token-Gated Access

Only holders of a specific ERC-20 token (with a minimum balance) can read the vault.

### Create the vault

```typescript
const writeCondition = conditions.ownerOnly({
  address: "0x<OwnerConditionContractAddress>",
  owner: walletClient.account.address,
});

const readCondition = conditions.tokenGate({
  address: "0x<TokenGateConditionContractAddress>",
  token: "0x<ERC20TokenAddress>",
  minBalance: 100n * 10n ** 18n, // 100 tokens (18 decimals)
});

const globalPubKey = await client.observer.getGlobalPubKey();
const secret = new TextEncoder().encode("token-holders-only content");

const result = await client.uploader.uploadCDR({
  dataKey: secret,
  globalPubKey,
  updatable: false,
  writeConditionAddr: writeCondition.address,
  readConditionAddr: readCondition.address,
  writeConditionData: writeCondition.conditionData,
  readConditionData: readCondition.conditionData,
  accessAuxData: "0x",
});

console.log("Token-gated vault UUID:", result.uuid);
```

### Read as a token holder

```typescript
// The on-chain condition contract checks the caller's token balance.
// If the caller doesn't hold enough tokens, the read() tx reverts.
const { dataKey } = await client.consumer.accessCDR({
  uuid: result.uuid,
  accessAuxData: "0x",
});

console.log("Content:", new TextDecoder().decode(dataKey));
```

---

## Scenario 3: Merkle Allowlist

Only addresses included in a Merkle tree can read the vault. Callers provide a Merkle proof as `accessAuxData`.

### Create the vault

```typescript
import { keccak256, encodePacked } from "viem";

// Build your Merkle tree off-chain (e.g., using @openzeppelin/merkle-tree)
const allowedAddresses = [
  "0xAlice...",
  "0xBob...",
  "0xCarol...",
];
// const tree = StandardMerkleTree.of(allowedAddresses.map(a => [a]), ["address"]);
// const root = tree.root as `0x${string}`;
const root = "0x<MerkleRootHash>" as `0x${string}`;

const writeCondition = conditions.ownerOnly({
  address: "0x<OwnerConditionContractAddress>",
  owner: walletClient.account.address,
});

const readCondition = conditions.merkle({
  address: "0x<MerkleConditionContractAddress>",
  root,
});

const globalPubKey = await client.observer.getGlobalPubKey();
const secret = new TextEncoder().encode("allowlisted content");

const result = await client.uploader.uploadCDR({
  dataKey: secret,
  globalPubKey,
  updatable: false,
  writeConditionAddr: writeCondition.address,
  readConditionAddr: readCondition.address,
  writeConditionData: writeCondition.conditionData,
  readConditionData: readCondition.conditionData,
  accessAuxData: "0x",
});

console.log("Merkle vault UUID:", result.uuid);
```

### Read with a Merkle proof

```typescript
import { encodeAbiParameters } from "viem";

// Generate proof off-chain for the caller's address
// const proof = tree.getProof([walletClient.account.address]);
const proof: `0x${string}`[] = ["0x<proofElement1>", "0x<proofElement2>"];

// Encode the proof as accessAuxData
const accessAuxData = encodeAbiParameters(
  [{ type: "bytes32[]" }],
  [proof],
);

const { dataKey } = await client.consumer.accessCDR({
  uuid: result.uuid,
  accessAuxData,
});

console.log("Content:", new TextDecoder().decode(dataKey));
```

---

## Scenario 4: File Vault with Storage Provider

Encrypt a file, upload to decentralized storage, and store the reference in a CDR vault.

### Upload a file

```typescript
import { PinataStorage } from "./storage/pinata"; // your StorageProvider implementation

const storage = new PinataStorage({ apiKey: "..." });

const fileContent = new Uint8Array(/* file bytes */);
const globalPubKey = await client.observer.getGlobalPubKey();

const writeCondition = conditions.ownerOnly({
  address: "0x<OwnerConditionContractAddress>",
  owner: walletClient.account.address,
});
const readCondition = conditions.open({
  address: "0x<OpenConditionContractAddress>",
});

const result = await client.uploader.uploadFile({
  content: fileContent,
  storageProvider: storage,
  globalPubKey,
  updatable: false,
  writeConditionAddr: writeCondition.address,
  readConditionAddr: readCondition.address,
  writeConditionData: writeCondition.conditionData,
  readConditionData: readCondition.conditionData,
  accessAuxData: "0x",
});

console.log("File vault UUID:", result.uuid);
console.log("Storage CID:", result.cid);
```

### Download and decrypt the file

```typescript
const { content, cid } = await client.consumer.downloadFile({
  uuid: result.uuid,
  accessAuxData: "0x",
  storageProvider: storage,
});

console.log("Downloaded CID:", cid);
console.log("File size:", content.length, "bytes");
```

---

## Method Aliases

The SDK provides intuitive aliases for the main operations:

| Original | Alias | Class |
|---|---|---|
| `uploadCDR()` | `createVault()` | Uploader |
| `uploadFile()` | `createFileVault()` | Uploader |
| `accessCDR()` | `readVault()` | Consumer |
| `downloadFile()` | `readFileVault()` | Consumer |

Both names are functionally identical. Use whichever reads better in your code:

```typescript
// These are equivalent:
await client.uploader.uploadCDR({ ... });
await client.uploader.createVault({ ... });

// These are equivalent:
await client.consumer.accessCDR({ ... });
await client.consumer.readVault({ ... });
```
