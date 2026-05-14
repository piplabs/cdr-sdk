---
"@piplabs/cdr-contracts": patch
"@piplabs/cdr-crypto": patch
"@piplabs/cdr-sdk": patch
"@piplabs/cdr-cli": patch
---

Hotfix re-publish: 0.2.0 of `@piplabs/cdr-sdk` and `@piplabs/cdr-cli` was inadvertently published via `npm publish` (instead of `pnpm publish`), which does not understand pnpm's `workspace:*` protocol. As a result the literal string `"workspace:*"` leaked into those published `package.json` dependencies and `npm install @piplabs/cdr-sdk@0.2.0` fails with `EUNSUPPORTEDPROTOCOL`.

0.2.1 republishes all four packages through the standard `pnpm changeset publish` path (release.yml), which correctly substitutes `workspace:*` with the resolved sibling version at publish time. `@piplabs/cdr-contracts` and `@piplabs/cdr-crypto` are version-aligned to 0.2.1 even though their 0.2.0 tarballs were valid — keeping all four packages at the same version simplifies the release story and avoids consumer confusion about mismatched dist-tags.

The broken 0.2.0 versions of `@piplabs/cdr-sdk` and `@piplabs/cdr-cli` will be `npm deprecate`'d after this release lands.
