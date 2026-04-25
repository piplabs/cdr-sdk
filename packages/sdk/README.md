# @piplabs/cdr-sdk

TypeScript SDK for **Confidential Data Rails (CDR)** on Story L1. Encrypt data to a threshold DKG public key, store it in on-chain vaults, and recover it when a quorum of validators provide partial decryptions.

This is the main entry point. It re-exports everything you need from `@piplabs/cdr-contracts` (ABIs + addresses) and `@piplabs/cdr-crypto` (TDH2 / ECIES primitives).

## Install

```sh
npm install @piplabs/cdr-sdk viem
```

Optional storage providers (peer dependencies, install only what you use):

```sh
npm install helia @helia/unixfs multiformats     # IPFS via Helia
npm install @storacha/client                     # Storacha
npm install @filoz/synapse-sdk                   # Filecoin via Synapse
```

## Quick start

```ts
import { CDRClient, initWasm } from "@piplabs/cdr-sdk";
import { createPublicClient, createWalletClient, http } from "viem";
import { privateKeyToAccount } from "viem/accounts";

await initWasm(); // Required before any encryption

const account = privateKeyToAccount(process.env.PRIVATE_KEY as `0x${string}`);
const client = new CDRClient({
  network: "testnet",
  publicClient: createPublicClient({ transport: http("https://aeneid.storyrpc.io") }),
  walletClient: createWalletClient({ account, transport: http("https://aeneid.storyrpc.io") }),
});

const globalPubKey = await client.observer.getGlobalPubKey();
const threshold = await client.observer.getThreshold();
```

See the full [repository README](https://github.com/piplabs/cdr-sdk#readme) for end-to-end upload + read flows, condition contracts, and architecture docs.

## Public API

- `CDRClient` — top-level client with `.observer`, `.uploader`, `.consumer`
- `Uploader` — write encrypted data to a CDR vault
- `Consumer` — request a vault read and combine partial decryptions
- `Observer` — query CDR contract state and DKG round info
- `conditions` — helpers for write/read condition contracts (`open`, `ownerOnly`, `tokenGate`, `merkle`, `custom`)
- Re-exported from `@piplabs/cdr-crypto`: `tdh2Encrypt`, `tdh2Combine`, `verifyPartialSignature`, `encryptFile`, `decryptFile`, `initWasm`, ...
- Re-exported from `@piplabs/cdr-contracts`: `cdrAbi`, `dkgAbi`, `contractAddresses`, `Network`, ...

## License

MIT — see [LICENSE](./LICENSE).
