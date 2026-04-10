# Changelog

All notable changes to this project will be documented in this file.

Format based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/). This project uses [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.1.1] - 2026-04-10

Initial release.

### Added

- `CDRClient` with `observer`, `uploader`, and `consumer` sub-clients
- `Observer` for read-only queries: vault info, DKG state, fee queries, validator registrations, attestations
- `Uploader` with `uploadCDR()` (allocate + encrypt + write) and `uploadFile()` (AES-encrypt file + store off-chain + protect key on-chain)
- `Consumer` with `accessCDR()` (read + collect partials + decrypt) and `downloadFile()` (access vault + download + decrypt file)
- `createVault` / `readVault` / `createFileVault` / `readFileVault` method aliases for backward compatibility
- Dual DKG query mode: `evm-events` (default, scans EVM logs) and `cosmos-abci` (direct CometBFT abci_query, 6–20x faster) (#43, #45)
- Condition helpers: `conditions.open()`, `ownerOnly()`, `tokenGate()`, `merkle()`, `custom()` (#28)
- SGX attestation verification: `verifyAttestation()` and `parseSgxQuote()` with MRENCLAVE, MRSIGNER, ISV SVN checks (#31)
- Storage providers: `HeliaProvider` (in-process IPFS), `GatewayProvider` (IPFS HTTP API + gateway), `StorachaProvider` (web3.storage), `SynapseProvider` (Filecoin via Synapse SDK)
- Validation RPC: `validationRpcUrls` for cross-node `globalPubKey` verification (throws `RpcConsensusError` on mismatch)
- `@piplabs/cdr-contracts` package with CDR and DKG ABIs and predeploy addresses
- `@piplabs/cdr-crypto` package with TDH2 (WASM), ECIES, file encryption, and signature verification
- Testnet (Aeneid, chain ID 1315) and mainnet (chain ID 1514) network support
- CLI tool (`@piplabs/cdr-cli`) for command-line vault operations
- Example scripts for upload, access, query, and end-to-end flows

### Fixed

- Observer uses `getActiveRound()` instead of latest Finalized event to determine active DKG round (#38)
- HeliaProvider accepts caller-provided CID parser to avoid `multiformats` version mismatch (#41)
- Synapse storage connection handling (#44)
- Validation clients also use `getActiveRound()` to prevent false-positive `RpcConsensusError` (#38)
- Deduplicate validators by address in `getActiveRound()` to prevent double-counting (#38)
