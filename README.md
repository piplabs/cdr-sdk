# CDR SDK

TypeScript SDK for **Confidential Data Recovery (CDR)** on Story L1. Encrypt data to a threshold DKG public key, store it in on-chain vaults, and recover it when a quorum of validators provide partial decryptions.

## Installation

```bash
npm install @piplabs/cdr-sdk viem
```

## Quick Start

```typescript
import { createPublicClient, createWalletClient, http } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { CDRClient, initWasm } from "@piplabs/cdr-sdk";

await initWasm();

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

console.log("Vault UUID:", uuid);
```

## Networks

| Network  | `network` param | RPC URL                          |
|----------|-----------------|----------------------------------|
| Testnet  | `"testnet"`     | `https://aeneid.storyrpc.io`    |
| Mainnet  | `"mainnet"`     | `https://rpc.story.foundation`   |

Point to any Story-compatible RPC (devnets, local nodes) by changing the `http()` transport URL:

```typescript
const publicClient = createPublicClient({ transport: http("http://localhost:8545") });
const client = new CDRClient({ network: "testnet", publicClient });
```

See the [User Guide](./USER_GUIDE.md) for full network configuration details.

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
- **[Condition Contracts](./docs/CONDITIONS.md)** — Write and read access control: interface spec, example contracts, debugging
- **[Changelog](./CHANGELOG.md)** — Release history

## License

See [LICENSE](./LICENSE) for details.
