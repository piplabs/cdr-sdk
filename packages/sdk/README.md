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

## Compatibility & known issues

### Requirements

- **Node.js ≥ 20.19** — transitive dependencies (`@noble/ciphers`, `@noble/hashes`) require this. Older Node versions install with `EBADENGINE` warnings; the SDK functions but the warning will be raised in the future. Tracked in [#98](https://github.com/piplabs/cdr-sdk/issues/98).
- **ESM-only** — all `@piplabs/*` packages are `"type": "module"`. CommonJS consumers must use dynamic `import()`; plain `require()` returns `ERR_REQUIRE_ESM`. CJS dual-publish is under discussion in [#97](https://github.com/piplabs/cdr-sdk/issues/97).

### Known issues queued for v0.2.2

- `@piplabs/cdr-cli --version` reports a stale `0.1.2` — the CLI binary itself works correctly. See [#96](https://github.com/piplabs/cdr-sdk/issues/96).
- `engines` field is not yet declared on any package — see [#98](https://github.com/piplabs/cdr-sdk/issues/98).
- ESM-only packaging without an explicit `"exports"` field — see [#97](https://github.com/piplabs/cdr-sdk/issues/97).

None of these affect SDK or CLI functionality. v0.2.1 was validated end-to-end on Aeneid (upload + access round-trip) prior to release.

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
  apiUrl: "http://172.192.41.96:1317", // Story-API REST endpoint — see Networks table in repo README
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
