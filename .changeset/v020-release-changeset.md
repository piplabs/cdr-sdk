---
"@piplabs/cdr-cli": minor
"@piplabs/cdr-contracts": minor
"@piplabs/cdr-crypto": minor
"@piplabs/cdr-sdk": minor
---

**BREAKING**: SDK now uses the Story-API REST endpoint in place of the CometBFT `abci_query` path (#73). Callers configured for ABCI must switch to the REST transport — see `packages/sdk/src/story-api/transport.ts`.

Other notable changes since 0.1.2:

- fix(sdk): consumer no longer selects a `/dkg/cdr_partials` bucket that does not match the current vault ciphertext (#74, #75)
- fix(sdk): consumer uses the partial bucket's round threshold instead of the active round's threshold (#76)
- fix(sdk): `accessCDR` short-circuits on `EmptyVaultError` before sending the paid read tx (#78)
- fix(sdk): `accessCDR` pins the in-flight ciphertext to avoid races on updatable vaults (#79)
- fix(sdk): cross-user partial collision in evm-events mode (`aes/gcm: invalid ghash tag`) (#72)
- fix(cli): CLI rejects malformed UUIDs and invalid timeouts instead of silently accepting them (#80)
- ci(integration): pull_request paths filter widened to cover the workflow's actual dependency surface (#77)
