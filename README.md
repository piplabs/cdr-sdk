# CDR SDK

TypeScript SDK for **Confidential Data Rails (CDR)** on Story L1. Encrypt data to a threshold DKG public key, store it in on-chain vaults, and recover it when a quorum of validators provide partial decryptions.


## Quick Start

```typescript
import { createPublicClient, createWalletClient, http } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { CDRClient, initWasm } from "@piplabs/cdr-sdk";

await initWasm(); // Required before any encryption

const account = privateKeyToAccount("0xYOUR_PRIVATE_KEY");
const publicClient = createPublicClient({ transport: http("https://aeneid.storyrpc.io") });
const walletClient = createWalletClient({ account, transport: http("https://aeneid.storyrpc.io") });

const client = new CDRClient({ network: "testnet", publicClient, walletClient });

// Upload encrypted data
const globalPubKey = await client.observer.getGlobalPubKey();
const dataKey = crypto.getRandomValues(new Uint8Array(32));

const { uuid } = await client.uploader.uploadCDR({
  dataKey,
  globalPubKey,
  updatable: false,
  writeConditionAddr: "0xYOUR_WRITE_CONDITION",
  readConditionAddr: "0xYOUR_READ_CONDITION",
  writeConditionData: "0x",
  readConditionData: "0x",
  accessAuxData: "0x",
});

// Access and decrypt
const { dataKey: recovered } = await client.consumer.accessCDR({
  uuid,
  accessAuxData: "0x",
  timeoutMs: 120_000,
});
```

## Features

- **Data key vaults**: `uploadCDR` / `accessCDR` — encrypt and store small data (keys, secrets) directly on-chain
- **File encryption**: `uploadFile` / `downloadFile` — AES-encrypt large files, store off-chain (IPFS/Filecoin), protect the key on-chain
- **DKG Observer**: query global public key, threshold, participant count, validators, attestations, fees
- **Dual DKG query mode**: `evm-events` (default) and `cosmos-abci` (6–20x faster via CometBFT RPC)
- **Condition helpers**: `conditions.open()`, `ownerOnly()`, `tokenGate()`, `merkle()`, `custom()`
- **SGX attestation verification**: `verifyAttestation()` with MRENCLAVE/MRSIGNER/SVN checks
- **Storage providers**: `HeliaProvider` (IPFS), `GatewayProvider`, `StorachaProvider`, `SynapseProvider`
- **Validation RPC**: cross-node `globalPubKey` verification via `validationRpcUrls`

## Networks

| Network  | `network` param | RPC URL                          |
|----------|-----------------|----------------------------------|
| Testnet  | `"testnet"`     | `https://aeneid.storyrpc.io`    |
| Mainnet  | `"mainnet"`     | `https://rpc.story.foundation`   |


See the [User Guide](./USER_GUIDE.md) for full network configuration details.

## DKG Query Modes

The SDK supports two backends for querying DKG state:

| Mode | How | Speed |
|------|-----|-------|
| `evm-events` (default) | Scans DKG contract events via `eth_getLogs` | Baseline |
| `cosmos-abci` | Queries x/dkg keeper via CometBFT `abci_query` | 6–20x faster |

```typescript
// Use cosmos-abci mode for faster queries
const client = new CDRClient({
  network: "testnet",
  publicClient,
  walletClient,
  dkgSource: "cosmos-abci",
  cometRpcUrl: "http://your-node:26657",
});
```

## File Operations

Encrypt large files and store them off-chain with on-chain key protection:

```typescript
import { HeliaProvider } from "@piplabs/cdr-sdk";
import { createHelia } from "helia";
import { unixfs } from "@helia/unixfs";
import { CID } from "multiformats/cid";

const helia = await createHelia();
const storage = new HeliaProvider({
  helia, unixfs: unixfs(helia),
  CID: (s) => CID.parse(s),
});

// Upload
const { uuid, cid } = await client.uploader.uploadFile({
  content: new TextEncoder().encode("Hello, CDR!"),
  storageProvider: storage,
  globalPubKey,
  updatable: false,
  writeConditionAddr: "0x...", readConditionAddr: "0x...",
  writeConditionData: "0x", readConditionData: "0x",
  accessAuxData: "0x",
});

// Download
const { content } = await client.consumer.downloadFile({
  uuid, accessAuxData: "0x",
  storageProvider: storage,
  timeoutMs: 120_000,
});
```

Other storage providers: `GatewayProvider` (IPFS HTTP API), `StorachaProvider` (web3.storage), `SynapseProvider` (Filecoin).

## Condition Contracts (Aeneid)

Two condition contracts are deployed on Aeneid testnet:

| Contract | Address | Description |
|----------|---------|-------------|
| OwnerWriteCondition | `0x4C9bFC96d7092b590D497A191826C3dA2277c34B` | Only the encoded address can write |
| LicenseReadCondition | `0xC0640AD4CF2CaA9914C8e5C44234359a9102f7a3` | Only Story Protocol license holders can read |

See [Condition Contracts](./docs/CONDITIONS.md) for the interface spec, more examples, and usage details.

## Packages

| Package | Description |
|---------|-------------|
| [`@piplabs/cdr-sdk`](./packages/sdk) | Main SDK — `CDRClient`, `Observer`, `Uploader`, `Consumer` |
| [`@piplabs/cdr-contracts`](./packages/contracts) | Contract ABIs and network addresses |
| [`@piplabs/cdr-crypto`](./packages/crypto) | TDH2 encryption, ECIES decryption, WASM loader |
| [`@piplabs/cdr-cli`](./apps/cli) | Command-line interface |
| [`@piplabs/cdr-examples`](./apps/examples) | Example scripts |

## Development

Requires [pnpm](https://pnpm.io/) v9+ and Node.js 18+.

```bash
pnpm install
pnpm build
pnpm test
```

### Unit Tests

`pnpm test` runs all unit tests (excludes `__integration__/`). For filtering:

```bash
# filters require running from packages/sdk (turbo doesn't forward args at the root)
cd packages/sdk

pnpm test story-api                  # file path substring
pnpm test story-api -t "round-trip"  # also by `it` name

pnpm exec vitest                     # watch mode (all)
pnpm exec vitest story-api           # watch + path filter
```

`pnpm test:coverage` produces a coverage report.

### Integration Tests

Integration tests in `packages/sdk/__integration__/` exercise the Story-API REST client (`packages/sdk/src/story-api/`) against a live endpoint. They are excluded from the default `pnpm test` and run via a separate command.

Setup (one-time, after cloning):

```bash
cp .env.local.example .env.local
$EDITOR .env.local   # fill in CDR_API_URL at minimum
```

Run:

```bash
# all integration tests (from monorepo root or packages/sdk)
pnpm test:integration

# only one test file — substring match against test paths (from packages/sdk)
cd packages/sdk
pnpm test:integration story-api

# only one test case within a file (from packages/sdk)
pnpm test:integration story-api -t "queryCDRPartials"

# temporarily override the endpoint without editing .env.local
CDR_API_URL=http://172.207.250.203:1317 pnpm test:integration
```

Path / `-t` filters only work when running from `packages/sdk` directly (`turbo` doesn't forward extra args at the monorepo root).

`.env.local` is gitignored; `.env.local.example` documents the variables. If `CDR_API_URL` is unset the test suite hard-fails with a clear error.

| Endpoint | Aeneid validator5 | DevNet validator2 |
|---|---|---|
| Story-API REST | `http://172.192.41.96:1317` | `http://172.207.250.203:1317` |
| EVM RPC | `http://172.192.41.96:8545` | `http://172.207.250.203:8545` |

### Running Examples

```bash
# Query DKG state (no wallet needed)
pnpm --filter @piplabs/cdr-examples query

# Upload encrypted data
CDR_PRIVATE_KEY=0x... WRITE_CONDITION=0x... READ_CONDITION=0x... \
  pnpm --filter @piplabs/cdr-examples upload

# Access and decrypt vault data
CDR_PRIVATE_KEY=0x... VAULT_UUID=1 \
  pnpm --filter @piplabs/cdr-examples access

# Full end-to-end demo
CDR_PRIVATE_KEY=0x... WRITE_CONDITION=0x... READ_CONDITION=0x... \
  pnpm --filter @piplabs/cdr-examples e2e
```

## Documentation

- **[User Guide](./USER_GUIDE.md)** — Network configuration, API reference, examples, and error handling
- **[Architecture](./docs/ARCHITECTURE.md)** — How CDR works end-to-end: DKG, threshold encryption, on-chain flow
- **[Condition Contracts](./docs/CONDITIONS.md)** — Write and read access control: interface spec, deployed contracts, debugging
- **[Changelog](./CHANGELOG.md)** — Release history

## License

See [LICENSE](./LICENSE) for details.
