# Development

Workspace setup, tests, and example scripts for `cdr-sdk` contributors.

## Prerequisites

- [pnpm](https://pnpm.io/) v9+
- Node.js 18+

## Setup

```bash
pnpm install
pnpm build
pnpm test
```

## Unit Tests

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

## Integration Tests

Integration tests in `packages/sdk/__integration__/` exercise the Story-API REST client (`packages/sdk/src/story-api/`) against a live endpoint. They are excluded from the default `pnpm test` and run via a separate command.

Setup (one-time, after cloning):

```bash
cp .env.local.example .env.local
$EDITOR .env.local
# Required for the full suite:
#   CDR_API_URL           Story-API REST URL (port 1317)
#   CDR_RPC_URL           EVM JSON-RPC URL on the same chain (port 8545)
#   CDR_TEST_PRIVATE_KEY  Funded test-wallet private key (0x-prefixed hex)
# Only `story-api.test.ts` can run with `CDR_API_URL` alone; every other
# test file throws at module-load time if any of the three is missing.
```

Run:

```bash
# all integration tests (from monorepo root or packages/sdk)
pnpm test:integration

# only one test file — substring match against test paths (from packages/sdk)
cd packages/sdk
pnpm test:integration story-api

# only one test case within a file (from packages/sdk)
pnpm test:integration story-api -t "queryCDRPartials"

# temporarily override the endpoint without editing .env.local
CDR_API_URL=<your-story-api-url> pnpm test:integration
```

Path / `-t` filters only work when running from `packages/sdk` directly (`turbo` doesn't forward extra args at the monorepo root).

`.env.local` is gitignored; `.env.local.example` documents the variables. Missing any of `CDR_API_URL` / `CDR_RPC_URL` / `CDR_TEST_PRIVATE_KEY` hard-fails the suite at module-load time with a clear error.

| Endpoint | Aeneid (testnet) |
|---|---|
| Story-API REST | `http://172.192.41.96:1317` |
| EVM RPC | `https://aeneid.storyrpc.io` |

## Running Examples

All examples read `CDR_API_URL` + `CDR_RPC_URL` from env. Tx-sending
examples (`upload` / `access` / `e2e`) additionally need
`CDR_TEST_PRIVATE_KEY`. Easiest is to export them once, then each
command line only has to spell out what's specific to that script:

```bash
export CDR_API_URL=http://172.192.41.96:1317           # Story-API REST
export CDR_RPC_URL=https://aeneid.storyrpc.io          # EVM JSON-RPC
export CDR_TEST_PRIVATE_KEY=0xYOUR_KEY                 # required for upload/access/e2e

# Query DKG state (no wallet needed)
pnpm --filter @piplabs/cdr-examples query

# Upload encrypted data
WRITE_CONDITION=0x... READ_CONDITION=0x... \
  pnpm --filter @piplabs/cdr-examples upload

# Access and decrypt a vault (replace with a uuid the wallet can read)
VAULT_UUID=1 \
  pnpm --filter @piplabs/cdr-examples access

# Full end-to-end demo (upload + access in one script)
WRITE_CONDITION=0x... READ_CONDITION=0x... \
  pnpm --filter @piplabs/cdr-examples e2e
```
