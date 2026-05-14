---
"@piplabs/cdr-sdk": patch
"@piplabs/cdr-cli": patch
---

Hotfix re-publish: 0.2.0 of `@piplabs/cdr-sdk` and `@piplabs/cdr-cli` were
inadvertently published via `npm publish` (instead of `pnpm publish`), which
does not understand pnpm's `workspace:*` protocol. As a result the literal
string `"workspace:*"` leaked into the published `package.json` dependencies
and `npm install @piplabs/cdr-sdk@0.2.0` fails with
`EUNSUPPORTEDPROTOCOL`.

0.2.1 republishes both packages through the standard `pnpm changeset
publish` path (release.yml), which correctly substitutes `workspace:*`
with the resolved sibling version at publish time:

- `@piplabs/cdr-sdk@0.2.1` depends on `@piplabs/cdr-contracts@0.2.0` and `@piplabs/cdr-crypto@0.2.0` (both already on npm, unchanged).
- `@piplabs/cdr-cli@0.2.1` depends on `@piplabs/cdr-sdk@0.2.1`.

The broken 0.2.0 versions will be `npm deprecate`'d after this release lands.
