# CDR SDK

TypeScript SDK for **Confidential Data Rails (CDR)** on Story L1. Encrypt data
to a threshold DKG public key, store it in on-chain vaults, and recover it
when a quorum of validators provide partial decryptions.


## Install

Each package is published to npm and can be installed independently:

| Package | Install | Description |
|---|---|---|
| [`@piplabs/cdr-sdk`](./packages/sdk) | `npm i @piplabs/cdr-sdk` | Main SDK — `CDRClient`, `Observer`, `Uploader`, `Consumer` |
| [`@piplabs/cdr-contracts`](./packages/contracts) | `npm i @piplabs/cdr-contracts` | Contract ABIs and network addresses |
| [`@piplabs/cdr-crypto`](./packages/crypto) | `npm i @piplabs/cdr-crypto` | TDH2 encryption, ECIES decryption, WASM loader |
| [`@piplabs/cdr-cli`](./apps/cli) | `npm i -g @piplabs/cdr-cli` | Command-line interface |

Most consumers only need `@piplabs/cdr-sdk` — it re-exports everything
relevant from `cdr-crypto` and `cdr-contracts`. Install `viem` as a peer
dependency:

```bash
pnpm add @piplabs/cdr-sdk viem
# Optional storage adapters (only the one you'll use):
pnpm add helia @helia/unixfs multiformats          # for HeliaProvider
pnpm add @storacha/client                           # for StorachaProvider
pnpm add @filoz/synapse-sdk                         # for SynapseProvider
```

## Quick Start

```typescript
import { createPublicClient, createWalletClient, http } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { CDRClient, initWasm } from "@piplabs/cdr-sdk";

await initWasm(); // Required before any encryption

const account = privateKeyToAccount("0xYOUR_PRIVATE_KEY");
const publicClient = createPublicClient({ transport: http("https://aeneid.storyrpc.io") });
const walletClient = createWalletClient({ account, transport: http("https://aeneid.storyrpc.io") });

const client = new CDRClient({
  network: "testnet",
  publicClient,
  walletClient,
  apiUrl: "http://172.192.41.96:1317", // Story-API REST endpoint — see "Networks" below
});

// Upload encrypted data
const globalPubKey = await client.observer.getGlobalPubKey();
const dataKey = crypto.getRandomValues(new Uint8Array(32));

const { uuid } = await client.uploader.uploadCDR({
  dataKey,
  globalPubKey,
  updatable: false,
  writeConditionAddr: "0xYOUR_WRITE_CONDITION",
  readConditionAddr:  "0xYOUR_READ_CONDITION",
  writeConditionData: "0x",
  readConditionData:  "0x",
  accessAuxData:      "0x",
});

// Access and decrypt — auto-generates ephemeral keypair, polls partials,
// combines via TDH2, and decrypts.
const { dataKey: recovered } = await client.consumer.accessCDR({
  uuid,
  accessAuxData: "0x",
  timeoutMs: 120_000,
});
```

## Features

- **Data key vaults**: `uploadCDR` / `accessCDR` — encrypt and store small data (keys, secrets) directly on-chain
- **File encryption**: `uploadFile` / `downloadFile` — AES-encrypt large files, store off-chain (IPFS / Storacha / Filecoin), protect the key on-chain
- **DKG Observer**: query global public key, threshold, participant count, validators, attestations, fees — all over Story-API REST (`apiUrl`)
- **Threshold customization**: `minThresholdRatio` raises the SDK-side threshold above the chain default (e.g. require partials from all validators, not just the chain minimum)
- **Condition helpers**: `conditions.open()`, `conditions.ownerOnly()`, `conditions.tokenGate()`, `conditions.merkle()`, `conditions.custom()`
- **SGX attestation verification**: `verifyAttestation()` with MRENCLAVE / MRSIGNER / SVN checks against on-chain `enclaveTypeData`
- **Storage providers**: `HeliaProvider` (IPFS), `GatewayProvider` (HTTP gateway), `StorachaProvider` (web3.storage), `SynapseProvider` (Filecoin)

## Networks

| Network | `network` param | EVM RPC | Story-API REST (`apiUrl`) |
|---|---|---|---|
| Testnet (Aeneid) | `"testnet"` | `https://aeneid.storyrpc.io` | `http://172.192.41.96:1317` ⚠️ plain HTTP — see note |
| Mainnet | `"mainnet"` | `https://rpc.story.foundation` | _TBD — public REST endpoint pending_ |

⚠️ **About `apiUrl`:** The SDK queries DKG state (active round, global public
key, registered validators, partials) over Story-API REST. Today's Aeneid
endpoint is the validator-5 IP on plain HTTP; a TLS-fronted subdomain on
`aeneid.storyrpc.io` is being requested from infra. For production you can also
point this at your own Story node's `:1317` REST gateway.

See the [User Guide](./USER_GUIDE.md) for full network configuration details.

## File Operations

Encrypt large files and store them off-chain with on-chain key protection:

```typescript
import { HeliaProvider } from "@piplabs/cdr-sdk";
import { createHelia } from "helia";
import { unixfs } from "@helia/unixfs";
import { CID } from "multiformats/cid";

const helia = await createHelia();
const storage = new HeliaProvider({
  helia,
  unixfs: unixfs(helia),
  CID: (s) => CID.parse(s),
});

// Upload
const { uuid, cid } = await client.uploader.uploadFile({
  content: new TextEncoder().encode("Hello, CDR!"),
  storageProvider: storage,
  globalPubKey,
  updatable: false,
  writeConditionAddr: "0x...",
  readConditionAddr:  "0x...",
  writeConditionData: "0x",
  readConditionData:  "0x",
  accessAuxData:      "0x",
});

// Download
const { content } = await client.consumer.downloadFile({
  uuid,
  accessAuxData: "0x",
  storageProvider: storage,
  timeoutMs: 120_000,
});
```

Other storage providers: `GatewayProvider` (IPFS HTTP API), `StorachaProvider`
(web3.storage), `SynapseProvider` (Filecoin).

## Condition Contracts (Aeneid)

Two condition contracts are deployed on Aeneid testnet:

| Contract | Address | Description |
|----------|---------|-------------|
| OwnerWriteCondition | `0x4C9bFC96d7092b590D497A191826C3dA2277c34B` | Only the encoded address can write |
| LicenseReadCondition | `0xC0640AD4CF2CaA9914C8e5C44234359a9102f7a3` | Only Story Protocol license holders can read |

See [Condition Contracts](./docs/CONDITIONS.md) for the interface spec, more examples, and usage details.

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
$EDITOR .env.local
# Required for the full suite:
#   CDR_API_URL           Story-API REST URL (port 1317)
#   CDR_RPC_URL           EVM JSON-RPC URL on the same chain (port 8545)
#   CDR_TEST_PRIVATE_KEY  Funded test-wallet private key (0x-prefixed hex)
# Only `story-api.test.ts` can run with `CDR_API_URL` alone; every other
# test file throws at module-load time if any of the three is missing.
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
CDR_API_URL=<your-story-api-url> pnpm test:integration
```

Path / `-t` filters only work when running from `packages/sdk` directly (`turbo` doesn't forward extra args at the monorepo root).

`.env.local` is gitignored; `.env.local.example` documents the variables. Missing any of `CDR_API_URL` / `CDR_RPC_URL` / `CDR_TEST_PRIVATE_KEY` hard-fails the suite at module-load time with a clear error.

| Endpoint | Aeneid (testnet) |
|---|---|
| Story-API REST | `http://172.192.41.96:1317` |
| EVM RPC | `https://aeneid.storyrpc.io` |

### Running Examples

All examples read `CDR_API_URL` + `CDR_RPC_URL` from env. Tx-sending
examples (`upload` / `access` / `e2e`) additionally need
`CDR_TEST_PRIVATE_KEY`. Easiest is to export them once, then each
command line only has to spell out what's specific to that script:

```bash
export CDR_API_URL=http://172.192.41.96:1317           # Story-API REST
export CDR_RPC_URL=https://aeneid.storyrpc.io          # EVM JSON-RPC
export CDR_TEST_PRIVATE_KEY=0xYOUR_KEY                 # required for upload/access/e2e

# Query DKG state (no wallet needed)
pnpm --filter @piplabs/cdr-examples query

# Upload encrypted data
WRITE_CONDITION=0x... READ_CONDITION=0x... \
  pnpm --filter @piplabs/cdr-examples upload

# Access and decrypt a vault (replace with a uuid the wallet can read)
VAULT_UUID=1 \
  pnpm --filter @piplabs/cdr-examples access

# Full end-to-end demo (upload + access in one script)
WRITE_CONDITION=0x... READ_CONDITION=0x... \
  pnpm --filter @piplabs/cdr-examples e2e
```

## Documentation

- **[User Guide](./USER_GUIDE.md)** — Network configuration, API reference, examples, and error handling
- **[Architecture](./docs/ARCHITECTURE.md)** — How CDR works end-to-end: DKG, threshold encryption, on-chain flow
- **[Condition Contracts](./docs/CONDITIONS.md)** — Write and read access control: interface spec, deployed contracts, debugging
- **[Changelog](./CHANGELOG.md)** — Release history

## License

See [LICENSE](./LICENSE) for details.
