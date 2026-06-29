# Releasing @piplabs/cdr-sdk

Maintainer-facing guide for cutting a new version of `@piplabs/cdr-contracts`, `@piplabs/cdr-crypto`, `@piplabs/cdr-sdk`, and `@piplabs/cdr-cli` to the npm public registry.

> Releases are cut by **manually running the `Release` workflow** and typing the version. All four packages move in **lockstep** (same version every release). Publishing is gated by a GitHub `npm-publish` environment with required reviewers, and authenticated via npm **Trusted Publishing (OIDC)**. 

## How a release works

One workflow, [`.github/workflows/release.yml`](../.github/workflows/release.yml), triggered by hand (`workflow_dispatch`) with a single `version` input (e.g. `0.2.2`). It runs two jobs:

**`prepare`** — runs immediately, no gate, **no external side effects**:
- Validates the input is valid semver and strictly greater than the current npm `latest`.
- Sets the version in all four `package.json` files (on the runner only).
- `pnpm install` + audit (high+ severity prod-dep gate) + `pnpm -r run build` + `pnpm -r publish --dry-run`.
- This is the reviewer's green pre-flight: it proves the release builds and packs before anyone approves the irreversible publish.

**`publish`** — `environment: npm-publish`, so a **required reviewer must click "Approve and deploy"** before any step runs. Only after approval:
- `pnpm -r publish` to npm via OIDC trusted publishing, with provenance.
- Pushes the version-bump commit **directly to `main`** and a `v<version>` tag.
- Creates a GitHub Release titled `v<version>`, with notes auto-populated from every commit since the previous `v*` tag (edit afterwards as needed).

Publish happens **before** the commit/tag/Release are pushed, so `main` never advertises a version that didn't actually reach npm.

### The approval gate

The publish job cannot do anything until a reviewer approves in the Actions UI (and "Prevent self-review" stops you approving your own run). If you hold off, **nothing goes live** — no npm publish, no commit to `main`, no tag, no Release. The run waits up to 30 days, or you can cancel it, and the world is unchanged. Approving is the single irreversible moment.

## Day-to-day: shipping a code change

Just merge PRs to `main` as normal — there is no per-PR release bookkeeping (no changeset files, no changelog to maintain). When you want to ship what's accumulated:

1. Decide the new version (semver, greater than current npm `latest`).
2. **Actions → Release → Run workflow**, type the version (e.g. `0.2.2`), Run.
3. Watch the `prepare` job go green (validation + build + dry-run).
4. A reviewer (not the trigger-er) opens the run, expands the `publish` job, confirms the version is what's intended, and clicks **Approve and deploy**.
5. The workflow publishes all four packages, pushes the bump + `v0.2.2` tag to `main`, and opens the GitHub Release.
6. Edit the auto-generated Release notes if you want them tidied.

`npm install @piplabs/cdr-sdk` resolves to the new version as soon as publish finishes — `pnpm publish` (no `--tag`) moves the `latest` dist-tag automatically.

## Reviewing the approval

Before clicking Approve:

- [ ] The `version` input matches what you intend to ship.
- [ ] The `prepare` job passed (build + audit + dry-run all green).
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
| `pnpm -r publish` failed partway through the four packages | `pnpm -r publish` checks the registry and **skips packages already published**, so it's idempotent — re-running at the **same version** publishes only the stragglers. The version-bump commit/tag is **not** pushed until publish fully succeeds, so on failure `main` is untouched. ⚠️ Edge case: if `@piplabs/cdr-sdk` itself published before the failure, `prepare`'s validation (which compares the input against `cdr-sdk`'s npm `latest`) will reject the same version on re-run — in that case publish the missing package(s) manually at that version, or bump all four to the next version. |
| Reviewer approved a run that shouldn't publish | If publish hasn't run yet, **Cancel workflow** in the Actions UI. If it has, fall back to unpublish/deprecate above. |
| Input version rejected by `prepare` | It's not valid semver or not greater than npm `latest`. Re-run with a corrected version. |

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
