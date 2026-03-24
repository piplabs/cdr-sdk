# Changelog

All notable changes to this project will be documented in this file.

Format based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/). This project uses [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.1.0] - 2025-01-XX

Initial release.

### Added

- `CDRClient` with `observer`, `uploader`, and `consumer` sub-clients
- `Observer` for read-only queries: vault info, DKG state, fee queries
- `Uploader` with `uploadCDR()` high-level method (allocate + encrypt + write)
- `Consumer` with `accessCDR()` high-level method (read + collect partials + decrypt)
- `@piplabs/cdr-contracts` package with CDR and DKG ABIs and addresses
- `@piplabs/cdr-crypto` package with TDH2 (WASM) and ECIES implementations
- Testnet and mainnet network support
- CLI tool (`@piplabs/cdr-cli`) for command-line vault operations
- Example scripts for upload, access, query, and end-to-end flows
