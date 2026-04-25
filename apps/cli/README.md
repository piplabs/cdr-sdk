# @piplabs/cdr-cli

Command-line interface for the [CDR (Confidential Data Rails) protocol](https://github.com/piplabs/cdr-sdk) on Story L1. Wraps the `@piplabs/cdr-sdk` runtime in a `cdr-cli` binary you can pipe shell scripts into.

## Install

```sh
npm install -g @piplabs/cdr-cli
# or, project-local
npm install --save-dev @piplabs/cdr-cli
```

## Global options

Available on every subcommand:

| Flag | Description | Default |
|---|---|---|
| `--network <name>` | `mainnet` or `testnet` | `testnet` |
| `--rpc-url <url>` | Override the chain RPC URL | (network default) |
| `--private-key <hex>` | Wallet private key. May also be set via `CDR_PRIVATE_KEY` environment variable. | — |
| `--json` | Output structured JSON instead of human-readable text | off |

## Subcommands

| Command | Purpose |
|---|---|
| `cdr-cli status vault <uuid>` | Print vault details for a given UUID |
| `cdr-cli status fees` | Print current `allocateFee`, `writeFee`, `readFee` |
| `cdr-cli allocate --write-condition <addr> --read-condition <addr> [--updatable] [--write-condition-data <hex>] [--read-condition-data <hex>] [--fee <wei>]` | Allocate a new CDR vault |
| `cdr-cli write --uuid <n> --encrypted-data <hex> [--access-aux-data <hex>] [--fee <wei>]` | Write encrypted data to a vault |
| `cdr-cli read --uuid <n> --requester-pub-key <hex> [--access-aux-data <hex>] [--fee <wei>]` | Request a vault read (emits the `VaultRead` event for validators to act on) |
| `cdr-cli encrypt --data-key <hex> --global-pub-key <hex> --uuid <n>` | TDH2-encrypt a data key against the DKG global public key, scoped to a vault label |
| `cdr-cli decrypt-partial --encrypted-partial <hex> --ephemeral-pub-key <hex> --recipient-priv-key <hex>` | ECIES-decrypt one validator's partial decryption returned for a `read` request |

Run `cdr-cli <subcommand> --help` for the live flag set.

## Quick example

```sh
# 1. See current fees
cdr-cli --network testnet status fees

# 2. Allocate a vault (open-access conditions for demo only)
cdr-cli --network testnet --private-key 0x... allocate \
  --write-condition 0x... --read-condition 0x...

# 3. Encrypt a 32-byte data key against the DKG global pubkey
cdr-cli encrypt --data-key 0x...32-bytes... --global-pub-key 0x... --uuid 42

# 4. Write the resulting ciphertext into the vault
cdr-cli --network testnet --private-key 0x... write \
  --uuid 42 --encrypted-data 0x...

# 5. Request a read; collect partials off-chain
cdr-cli --network testnet --private-key 0x... read \
  --uuid 42 --requester-pub-key 0x...
```

For the full upload/read flow including `collectPartials` and `tdh2Combine`, use the SDK directly — the CLI exposes the contract-facing primitives but does not orchestrate validator-partial collection.

## License

MIT — see [LICENSE](./LICENSE).
