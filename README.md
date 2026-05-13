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

Integration tests in `packages/sdk/__integration__/` exercise the SDK against a live network. Excluded from the default `pnpm test`; run via separate commands.

Setup (one-time, after cloning):

```bash
cp .env.local.example .env.local
$EDITOR .env.local   # fill in CDR_API_URL + CDR_RPC_URL + CDR_TEST_PRIVATE_KEY
```

`.env.local` is gitignored; `.env.local.example` documents the variables. The suites hard-fail at load time if any of the three is unset.

| Endpoint | Aeneid validator5 | DevNet validator2 |
|---|---|---|
| Story-API REST | `http://172.192.41.96:1317` | `http://172.207.250.203:1317` |
| EVM RPC | `https://aeneid.storyrpc.io` | `http://172.207.250.203:8545` |

#### Test files

The suite is structured around two axes — what the test does (functional groups) and what scale it runs at (suite gates).

**Functional groups (no suite gating — always run):**

| File | Coverage |
|---|---|
| `story-api.test.ts` | Story-API REST client wire-level: round, network, partials, registrations |
| `observer.test.ts` | Observer methods over real REST + RPC, including per-round caching |
| `uploader.test.ts` | `encryptDataKey`, `allocate`, `uploadCDR`, write/feeOverride/EOA-condition policies |
| `consumer.test.ts` | `accessCDR`, `collectPartials`, `decryptDataKey`, queryCDRPartials, plus the #75 / #79 regression cases (ACC-04c TOCTOU) |
| `dx-improvements.test.ts` | DX-01..04 — `conditions` helpers, simplified accessCDR, method aliases (DX-03 LicenseReadCondition skipped pending dep) |
| `security.test.ts` | SEC-01..09 — WASM hash, pinned crypto deps, threshold ratio, SGX DCAP Quote v3 parse + verify, label-mismatch on write |
| `perf-micro.test.ts` | PERF-01..05 — single-op latency benchmarks (initWasm, observer queries, upload breakdown, accessCDR, full roundtrip) |
| `errors.test.ts` | ERR-01 / ERR-02 / ERR-05 — error-path gaps not covered by the per-class suites |

**Suite-gated (`describe.skipIf(skipUnlessSuite(...))`) — ephemeral-wallet tests:**

| File | Suite gate | Networks | Wall time (typ.) |
|---|---|---|---|
| `ephemeral-100w-shared.test.ts` | `default`, `all` | DevNet + Aeneid | ~2 min |
| `ephemeral-100w-fresh.test.ts` | `default`, `all` | DevNet + Aeneid | ~5 min |
| `ephemeral-1000w-perf.test.ts` | `1000-wallet-performance`, `all` | DevNet + Aeneid | ~30-50 min |
| `ephemeral-60min-stress.test.ts` | `1H-stress-devnet-only`, `all` | **DevNet only** | 60 min |

Suite gating is steered by the `TEST_SUITE` env var, defaulted to `"default"` by `_suite.ts`. The CI workflow's `test_suite` input maps 1:1 to this env var.

The ephemeral-wallet suites use `_ephemeral-wallets.ts` helpers:
- `generateEphemeralWallets(N)` — fresh in-memory keypairs.
- `fundWallets(funder, wallets, perWalletWei)` — one Multicall3.aggregate3Value tx that batch-funds every wallet (auto-deploys Multicall3 on fresh DevNet, uses the canonical `0xcA11...` address everywhere else).
- `refundWallets(wallets, recipient, rpcUrl)` — per-wallet concurrent sweep with a gas reserve; failures are counted, not thrown.

#### Running locally

```bash
# All non-gated tests + default-suite ephemeral tests (devnet)
pnpm test:integration

# Single file (path substring; run from packages/sdk)
cd packages/sdk
pnpm test:integration consumer

# Single test case
pnpm test:integration consumer -t "ACC-04c"

# Pick a non-default suite (steers describe.skipIf in test files)
TEST_SUITE=1000-wallet-performance pnpm test:integration

# 60-minute stress (DevNet only — uses a separate vitest entry)
pnpm test:stress
```

Path / `-t` filters only work when running from `packages/sdk` directly; turbo doesn't forward extra args at the monorepo root.

#### CI / GitHub Actions

The `Integration` workflow (`.github/workflows/integration.yml`) is the canonical place to run cross-network or expensive suites:

- **PR trigger** — always `network=devnet, test_suite=default`. Runs the four `default`-gated ephemeral tests + every non-gated file.
- **Manual dispatch** — pick `network` (devnet/aeneid) × `test_suite` (default / all / 1000-wallet-performance / 1H-stress-devnet-only). The `1H-stress-devnet-only` suite is hard-rejected at the prepare step when `network != devnet`.

The workflow's summary step renders per-case ✓/✗ tables (parsed from vitest's JSON reporter) and a pre/post chain-state delta (EL block + DKG round) so a long run's effect on the chain is visible at a glance.

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
