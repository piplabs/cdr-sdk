# @piplabs/cdr-crypto

## 0.2.1

### Patch Changes

- [#90](https://github.com/piplabs/cdr-sdk/pull/90) [`ee3a290`](https://github.com/piplabs/cdr-sdk/commit/ee3a29099fbe4b8897e4c8603c4740e4376c2622) Thanks [@lucas2brh](https://github.com/lucas2brh)! - Hotfix re-publish: 0.2.0 of `@piplabs/cdr-sdk` and `@piplabs/cdr-cli` was inadvertently published via `npm publish` (instead of `pnpm publish`), which does not understand pnpm's `workspace:*` protocol. As a result the literal string `"workspace:*"` leaked into those published `package.json` dependencies and `npm install @piplabs/cdr-sdk@0.2.0` fails with `EUNSUPPORTEDPROTOCOL`.

  0.2.1 republishes all four packages through the standard `pnpm changeset publish` path (release.yml), which correctly substitutes `workspace:*` with the resolved sibling version at publish time. `@piplabs/cdr-contracts` and `@piplabs/cdr-crypto` are version-aligned to 0.2.1 even though their 0.2.0 tarballs were valid — keeping all four packages at the same version simplifies the release story and avoids consumer confusion about mismatched dist-tags.

  The broken 0.2.0 versions of `@piplabs/cdr-sdk` and `@piplabs/cdr-cli` will be `npm deprecate`'d after this release lands.

## 0.2.0

### Minor Changes

- [#85](https://github.com/piplabs/cdr-sdk/pull/85) [`35a6df1`](https://github.com/piplabs/cdr-sdk/commit/35a6df13d6fbc15bd13d8acfe17f0ee59de2b884) Thanks [@lucas2brh](https://github.com/lucas2brh)! - **BREAKING**: SDK now uses the Story-API REST endpoint in place of the CometBFT `abci_query` path ([#73](https://github.com/piplabs/cdr-sdk/issues/73)). Callers configured for ABCI must switch to the REST transport — see `packages/sdk/src/story-api/transport.ts`.

  Other notable changes since 0.1.2:

  - fix(sdk): consumer no longer selects a `/dkg/cdr_partials` bucket that does not match the current vault ciphertext ([#74](https://github.com/piplabs/cdr-sdk/issues/74), [#75](https://github.com/piplabs/cdr-sdk/issues/75))
  - fix(sdk): consumer uses the partial bucket's round threshold instead of the active round's threshold ([#76](https://github.com/piplabs/cdr-sdk/issues/76))
  - fix(sdk): `accessCDR` short-circuits on `EmptyVaultError` before sending the paid read tx ([#78](https://github.com/piplabs/cdr-sdk/issues/78))
  - fix(sdk): `accessCDR` pins the in-flight ciphertext to avoid races on updatable vaults ([#79](https://github.com/piplabs/cdr-sdk/issues/79))
  - fix(sdk): cross-user partial collision in evm-events mode (`aes/gcm: invalid ghash tag`) ([#72](https://github.com/piplabs/cdr-sdk/issues/72))
  - fix(cli): CLI rejects malformed UUIDs and invalid timeouts instead of silently accepting them ([#80](https://github.com/piplabs/cdr-sdk/issues/80))
  - ci(integration): pull_request paths filter widened to cover the workflow's actual dependency surface ([#77](https://github.com/piplabs/cdr-sdk/issues/77))

## 0.1.2

### Patch Changes

- [#69](https://github.com/piplabs/cdr-sdk/pull/69) [`3d022d0`](https://github.com/piplabs/cdr-sdk/commit/3d022d0e015cbc050525253f2cb20b75af7a9858) Thanks [@lucas2brh](https://github.com/lucas2brh)! - Initial public release on npm. Includes contracts ABIs and addresses, TDH2/ECIES crypto primitives, the SDK client, and the cdr-cli command-line tool.
