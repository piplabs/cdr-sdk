# Releasing @piplabs/cdr-sdk

Maintainer-facing guide for cutting a new version of `@piplabs/cdr-contracts`, `@piplabs/cdr-crypto`, `@piplabs/cdr-sdk`, and `@piplabs/cdr-cli` to the npm public registry.

> Releases are **two-phase**: run the `Release` workflow to open a version-bump PR, then squash-merge it to publish. All four packages move in **lockstep** (same version every release). Publishing is gated by a GitHub `npm-publish` environment with a required reviewer, and authenticated via npm **Trusted Publishing (OIDC)** — no long-lived token.

## How a release works

One workflow, [`.github/workflows/release.yml`](../.github/workflows/release.yml), with two triggers. `main`, the git tag, the npm tarballs, and the provenance all end up referencing the **same merged commit** — no SHA divergence even though we squash-merge.

**Phase 1 — `open-pr` job** (trigger: `workflow_dispatch` with a `version` input; **no gate, no external side effects**):
- Validates the input is valid semver and strictly greater than the current npm `latest`.
- Bumps all four `package.json` on a `release/v<version>` branch.
- `pnpm install --frozen-lockfile` + audit (high+ severity prod-dep gate) + `pnpm -r run build` + `pnpm -r publish --dry-run` (packaging pre-flight).
- Opens a **`chore: release v<version>`** PR. Publishes nothing; the bump isn't on `main` yet.

**Phase 2 — `detect` + `publish` jobs** (trigger: `push` to `main`, i.e. the squash-merge of that PR):
- `detect` (no gate, read-only): marks a release only when **both** the version in `main` is ahead of npm `latest` **and** the head commit starts with `chore: release v`. Ordinary merges fail this and `publish` is skipped — no approval prompt.
- `publish` (`environment: npm-publish`, **required reviewer must Approve before any step runs**): `pnpm -r publish` via OIDC + provenance **from the merged commit**, then tags that commit `v<version>` and cuts a GitHub Release (notes = commits since the previous `v*` tag, edit afterwards). It never pushes to the `main` ref — the bump already arrived there via the merged PR.

> **`open-pr` is a pre-flight, not a guarantee.** `open-pr` and `publish` run on separate runners, so `publish` re-runs install/build. Both use `--frozen-lockfile`, so a green `open-pr` is a strong signal — but not a hard guarantee `publish` succeeds (e.g. a registry outage). The dry-run exists to catch packaging regressions early, not to make `publish` infallible.

### Triggers and gates, in order

1. **Trigger — `workflow_dispatch`** (write-access collaborators only; public read access does *not* grant this): opens the PR. Harmless — publishes nothing.
2. **Gate — branch protection** on the PR merge: required checks + review + signatures, then a human squash-merges.
3. **Trigger — `push` to `main`**: the merge. `detect` filters it to real releases.
4. **Gate — `npm-publish` environment**: holds the entire `publish` job in "Waiting" until a required reviewer clicks **Approve and deploy** ("Prevent self-review" stops you approving your own). Hold off and **nothing goes live**; the irreversible publish is the only thing behind this gate.

## Day-to-day: shipping a code change

Merge PRs to `main` as normal — no per-PR release bookkeeping (no changeset files, no changelog). When you want to ship what's accumulated:

1. **Actions → Release → Run workflow**, type the version (e.g. `0.2.2`), Run. → a `chore: release v0.2.2` PR appears once `open-pr` is green.
2. Review the bump PR and **squash-merge** it. (Keep the squash commit title starting with `chore: release v` — it's the publish marker.)
3. The merge starts the **publish** path; `detect` sees the version is ahead of npm and the `publish` job requests approval.
4. A reviewer (not the merger, ideally) opens the run, confirms the version, and clicks **Approve and deploy**.
5. All four packages publish; the merged commit is tagged `v0.2.2` and a GitHub Release is cut.
6. Edit the auto-generated Release notes if you want them tidied.

`npm install @piplabs/cdr-sdk` resolves to the new version as soon as publish finishes — `pnpm publish` (no `--tag`) moves the `latest` dist-tag automatically.

## Reviewing the approval

Before clicking Approve on the `publish` job:

- [ ] The version being published matches what you intend to ship.
- [ ] The merged commit is the `chore: release v<version>` bump (not something unexpected that happened to be ahead of npm).
- [ ] The version is greater than the current npm `latest` (the workflow enforces this, but sanity-check).

This is the irreversible step — once published, a version cannot be reused.

## Local dry-run with Verdaccio

Before a release with non-trivial publish-surface changes (file layout, new dist outputs, peer-dep changes, scope tweaks), validate against [Verdaccio](https://verdaccio.org/), a local npm registry mirror:

```sh
# 1. Spin up Verdaccio
docker run -d --name verdaccio -p 4873:4873 -v /tmp/verdaccio-storage:/verdaccio/storage verdaccio/verdaccio
sleep 4

# 2. Register a local user
curl -s -X PUT -H "Content-Type: application/json" \
  -d '{"name":"testuser","password":"testpass","email":"test@local"}' \
  http://localhost:4873/-/user/org.couchdb.user:testuser
# Copy the "token" field from the response

# 3. Create a temporary .npmrc
cat > /tmp/verdaccio.npmrc <<EOF
registry=http://localhost:4873/
//localhost:4873/:_authToken=<paste-token>
EOF

# 4. Build + publish all four packages to Verdaccio
pnpm install
pnpm -r run build
for dir in packages/contracts packages/crypto packages/sdk apps/cli; do
  ( cd "$dir" && NPM_CONFIG_USERCONFIG=/tmp/verdaccio.npmrc pnpm publish --registry http://localhost:4873/ --no-git-checks )
done

# 5. Smoke test: install in a fresh project
mkdir /tmp/cdr-smoke && cd /tmp/cdr-smoke
echo '{"name":"smoke","type":"module","version":"0.0.0","private":true}' > package.json
NPM_CONFIG_USERCONFIG=/tmp/verdaccio.npmrc pnpm add @piplabs/cdr-sdk viem --registry http://localhost:4873/
node -e "import('@piplabs/cdr-sdk').then(m => console.log('exports:', Object.keys(m).length))"

# 6. Cleanup
docker rm -f verdaccio
sudo rm -rf /tmp/verdaccio-storage
rm -rf /tmp/cdr-smoke /tmp/verdaccio.npmrc
```

This catches malformed `package.json`, missing `dist/`, `workspace:*` not substituted, and runtime import failures — all without touching public npm.

## Authentication: npm Trusted Publishing (OIDC)

There is **no `NPM_TOKEN`** in this repo. Each of the four packages has this repo + `release.yml` + the `npm-publish` environment configured as a **trusted publisher** in its npm package settings (npmjs.com → package → Settings → Trusted Publisher). At publish time GitHub mints a short-lived OIDC token that npm exchanges for a single-use publish credential — nothing is stored, nothing expires, nothing to rotate.

If a publish fails authentication, check the trusted-publisher config on npm matches exactly: organization `piplabs`, repository `cdr-sdk`, workflow `release.yml`, environment `npm-publish`. Do **not** add an `NPM_TOKEN` secret — if both a token and the OIDC path are present, npm prefers the token and bypasses trusted publishing (and loses provenance).

## When something goes wrong

| Situation | Recovery |
|---|---|
| Published a wrong version (within 72 hours) | `npm unpublish @piplabs/<package>@<version>` (org member with publish rights). After 72 hours, npm policy denies unpublish. |
| Published a wrong version (> 72 hours) | Cannot unpublish. `npm deprecate @piplabs/<package>@<version> "Please use <newer-version> instead"` and ship a corrected version on top. |
| `pnpm -r publish` failed partway through the four packages | The bump is already on `main` (the PR merged); only the tag/Release are still pending (they happen after a full publish). `pnpm -r publish` **skips packages already on the registry**, so use **Actions → re-run failed jobs** on that run. ⚠️ Edge case: if `@piplabs/cdr-sdk` itself published before the failure, `detect` will now see the version as *not* ahead of npm and skip `publish` on re-run — in that case publish the missing package(s) manually at that version, or open a new release PR at the next version. |
| Reviewer approved a run that shouldn't publish | If the `publish` job hasn't run yet, **Cancel workflow** in the Actions UI. If it has, fall back to unpublish/deprecate above. |
| Version rejected by `open-pr` validation | It's not valid semver or not greater than npm `latest`. Re-run the Release workflow with a corrected version. |
| Squash commit title was edited and lost the `chore: release v` prefix | `detect` won't recognize it, so `publish` is skipped and nothing publishes. The bump is on `main` but unpublished — push an empty/trivial commit titled `chore: release v<version>` to `main` (via a PR), or run the publish manually. Keep release PR titles intact to avoid this. |

## Verifying provenance

Configured via `NPM_CONFIG_PROVENANCE=true` in `release.yml`. After publish:

```sh
npm view @piplabs/cdr-sdk@<version> --json | jq '.dist.attestations'
```

Should show a signed attestation bundle with the GitHub Actions run URL embedded. If absent, provenance config was lost — investigate the workflow env block.

## References

- [npm Trusted Publishing](https://docs.npmjs.com/trusted-publishers)
- [npm provenance](https://docs.npmjs.com/generating-provenance-statements)
- [GitHub Environments](https://docs.github.com/en/actions/deployment/targeting-different-environments/using-environments-for-deployment)
- This repo's release workflow: [`.github/workflows/release.yml`](../.github/workflows/release.yml)
