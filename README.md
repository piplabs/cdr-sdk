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

For unit + integration test setup and the workspace examples runner, see [`docs/DEVELOPMENT.md`](./docs/DEVELOPMENT.md).

## Documentation

- **[User Guide](./USER_GUIDE.md)** — Network configuration, API reference, examples, and error handling
- **[Architecture](./docs/ARCHITECTURE.md)** — How CDR works end-to-end: DKG, threshold encryption, on-chain flow
- **[Condition Contracts](./docs/CONDITIONS.md)** — Write and read access control: interface spec, deployed contracts, debugging
- **[Development](./docs/DEVELOPMENT.md)** — Workspace setup, running unit + integration tests, executing example scripts
- **[Releasing](./docs/RELEASING.md)** — Maintainer guide: manual version-input release workflow, npm publish gates, post-release verification

## License

See [LICENSE](./LICENSE) for details.
