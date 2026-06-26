# @piplabs/cdr-monitor

Off-chain CDR monitors. Each monitor lives in its own `src/<name>/` directory so
more can be added without entangling them.

| Monitor | Directory | Run |
|---------|-----------|-----|
| Partial-decryption threshold shortfall | `src/partials-threshold/` | `pnpm --filter @piplabs/cdr-monitor partials-threshold` |

---

## partials-threshold

Off-chain watcher that alerts when a CDR (threshold-decryption) request expires
without collecting enough partial decryptions to meet its round threshold.

It does **not** touch the chain: it reads the same data the on-chain keeper does,
purely through public interfaces.

### How it works

Run on a cron (every 5 min). Each tick:

1. **Sweep** — for every request in `read_requests.json` whose deadline has
   passed (`head > block + DECRYPT_TIMEOUT_BLOCKS`), query Story-API
   `/dkg/cdr_partials`:
   - threshold met → drop it, no alert;
   - threshold **not** met → collect for a batched alert, then drop it (so the
     next tick does not re-alert).
2. **Ingest** — `eth_getLogs` for new CDR `VaultRead` events since the last
   scanned block; record each `(uuid, requesterPubKey, ciphertext, block)` plus
   the active `round`/`threshold` (captured once via `/dkg/latest_active`, used
   for the zero-partial case).
3. **Alert** — if any shortfalls, post a **single** batched Slack message, then
   persist state. State is saved only after a successful post, so a failed post
   re-detects and re-alerts next run rather than dropping silently.

No reorg buffer: CometBFT finalizes on commit, so the latest block is final.
Block deadlines use EL block numbers; since Story produces one EL block per CL
block the 200-block interval is identical either way.

`partials` count and `thresholdMet` come from `/dkg/cdr_partials` (the keeper's
accepted set), not raw logs — this is already correct for duplicate submissions
and invalidated-validator rejections.

### Configuration (env)

| Var | Required | Default | Notes |
|-----|----------|---------|-------|
| `CDR_API_URL` | yes | — | Story-API REST base URL (in CI: repo secret, masked in logs) |
| `CDR_RPC_URL` | no | network default | EVM JSON-RPC (aeneid: `https://aeneid.storyrpc.io`); in CI: optional secret |
| `CDR_SLACK_WEBHOOK_URL` | when alerting | — | required only if a shortfall is found |
| `CDR_NETWORK` | no | `aeneid` | network label (`aeneid` \| `mainnet`); selects the default RPC and labels the alert |
| `READ_REQUESTS_PATH` | no | `./read_requests.json` | state file |
| `DECRYPT_TIMEOUT_BLOCKS` | no | `200` | matches keeper `DefaultDecryptTimeout` |
| `RUN_URL` | no | — | adds a "View workflow run" button to the Slack message |

### Run

```bash
pnpm --filter @piplabs/cdr-monitor partials-threshold
```

State (`read_requests.json`) persists across runs; in CI it is carried via
`actions/cache`. In CI the endpoints are supplied as repo secrets
(`CDR_API_URL`, optional `CDR_RPC_URL`) rather than hardcoded, so the internal
Story-API host is not exposed in the workflow file:

```bash
gh secret set CDR_API_URL
gh secret set CDR_RPC_URL   # optional; omit to use the public aeneid RPC
```
