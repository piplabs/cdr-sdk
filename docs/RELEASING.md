# Releasing @piplabs/cdr-sdk

Maintainer-facing guide for cutting a new version of `@piplabs/cdr-contracts`, `@piplabs/cdr-crypto`, and `@piplabs/cdr-sdk` to the npm public registry.

> The release pipeline is fully automated by [Changesets](https://github.com/changesets/changesets) + [`changesets/action`](https://github.com/changesets/action), gated by a GitHub `npm-publish` environment with required reviewers. **Do not run `pnpm publish` manually.** All releases go through `main` and the gates below.

## Pipeline gates

Every push to `main` triggers `.github/workflows/release.yml`. The job is gated by:

| Gate | Where it lives | What it checks |
|---|---|---|
| 1. `pnpm install --frozen-lockfile` | release.yml step | `pnpm-lock.yaml` matches `package.json` deps; reproducible install |
| 2. `pnpm -r run build` | release.yml step | TypeScript compiles for every package |
| 3. `pnpm -r run test` | release.yml step | vitest unit suites pass: `packages/crypto` (17 tests) + `packages/sdk` (81 passed, 23 integration skipped on CI) |
| 4. `environment: npm-publish` | repo Settings → Environments | A required reviewer must click **Approve and deploy** in the Actions UI before any step runs. Reviewer list and main-only branch restriction live in the environment config. |
| 5. Changesets two-stage flow | `.changeset/` files in repo | Action opens a "Version Packages" PR when `.changeset/*.md` files exist; only publishes when those files are absent (i.e. after the version PR merges). |

Source for gate 5 (verbatim from [changesets/action README](https://github.com/changesets/action#readme)): *"a commit without any new changesets can always land on your base branch after a successful publish. In such a case you need to figure out on your own how to skip over the actual publishing logic or handle errors gracefully as most package registries won't allow you to publish over already published version."* — meaning **any push to main where `package.json` versions are higher than what's on npm will publish those versions**. This is by design; the gates above ensure such pushes only happen via merged Version Packages PRs.

## Day-to-day: shipping a code change

```sh
# 1. Branch + code
git checkout -b yourname/some-feature
# ... edit files ...

# 2. Declare intent (interactive)
pnpm changeset
# Prompts:
#   - Which packages should be bumped?  (space to toggle, enter to confirm)
#   - Which packages should have a major bump? (rarely)
#   - Which packages should have a minor bump? (new public API)
#   - The remaining are patch (bug fix / internal refactor)
#   - Summary: short sentence that becomes a CHANGELOG bullet
# Writes a file like .changeset/clever-mountain-rhinos.md
git add .changeset/ <your-other-changes>
git commit -m "feat(sdk): your change"
git push origin yourname/some-feature
gh pr create
```

A PR with no `.changeset/*.md` is fine for pure docs / chore work that should not bump any package version. To declare "no version bump needed" explicitly, use `pnpm changeset --empty`.

After your PR merges to `main`:

1. release.yml triggers, pauses at the `npm-publish` environment gate.
2. A reviewer (someone in the environment's required reviewers list, not yourself due to **Prevent self-review**) approves in the Actions UI.
3. Job runs install / build / test.
4. `changesets/action` sees your `.md` file, opens (or updates) a PR titled **"chore: release packages"** that:
   - Bumps the affected packages' `version` fields in `package.json`
   - Appends a CHANGELOG entry per package using `@changesets/changelog-github` (auto-links your PR + handle)
   - Deletes the consumed `.changeset/*.md`
   - Does **not** publish anything yet
5. Maintainer reviews the "chore: release packages" PR (see [Reviewing the Version Packages PR](#reviewing-the-version-packages-pr) below) and merges it.
6. release.yml triggers again, pauses at the `npm-publish` environment gate.
7. Reviewer approves.
8. `changesets/action` sees no remaining `.md` files, runs `pnpm changeset publish`, which:
   - Publishes each bumped package (whose `package.json.version > npm dist-tags.latest`)
   - Adds OIDC-signed npm provenance attestation (configured via `NPM_CONFIG_PROVENANCE=true` in the workflow env)
   - Creates per-package git tags like `@piplabs/cdr-sdk@0.1.3`
   - Creates a GitHub Release per tag (`createGithubReleases` defaults to true on the action)

## First-time release of an unpublished package

Same flow as day-to-day. The only nuance: the changeset should list **all three packages** so they all get the same version bump and ship together:

```sh
pnpm changeset
# When prompted "Which packages should be bumped?":
#   ◉ @piplabs/cdr-contracts
#   ◉ @piplabs/cdr-crypto
#   ◉ @piplabs/cdr-sdk
# Bump type: patch (the existing 0.1.1 in package.json bumps to 0.1.2)
# Summary: "Initial public release."
```

The Version Packages PR will bump all three to 0.1.2. After it merges + final approval, `pnpm changeset publish` publishes all three. From then on, packages can version independently — only mention the ones you changed in subsequent changesets.

## Reviewing approvals (what each gate means)

The `npm-publish` environment gate fires on **every push to `main`**, including merges that don't trigger a release. Reviewer should check the Actions run page before approving:

| Workflow run is for | How to tell from the run page | What approval means |
|---|---|---|
| A merged feature PR with a changeset | The triggering commit message is the feature PR's title; `.changeset/` has new `.md` files (visible in commit diff) | Approve to let action open the Version Packages PR. No npm publish in this run. |
| A merged "chore: release packages" PR | The triggering commit message is `Version Packages` or `chore: release packages`; `.changeset/` has only `README.md` + `config.json` | Approve to publish to npm. **This is the irreversible step.** |
| A merged docs / chore PR (no changeset) | No `.md` files in `.changeset/`; `package.json.version` matches what's already on npm | `pnpm changeset publish` will be a no-op. Safe to approve, but you can also let it sit. |
| A merged PR that bumped `package.json.version` manually | `package.json` diff shows version change; `.changeset/` has no related `.md` | **DO NOT APPROVE.** This bypasses Changesets and would publish an unintended version. Reject and investigate. |

If unsure, click into the Actions run, scroll to the "Create Release Pull Request or Publish" step pre-execution, and check the commit diff that triggered it.

## Reviewing the Version Packages PR

Auto-opened by `changesets/action`, title `chore: release packages` (default). Review checklist:

- [ ] `package.json` `version` bumps match the bump types declared in the consumed `.changeset/*.md` files (patch / minor / major)
- [ ] `CHANGELOG.md` entries per package include the original PR's summary text + auto-generated PR link + contributor handle
- [ ] No spurious changes outside `package.json` + `CHANGELOG.md` + `.changeset/` deletions
- [ ] If multiple packages are bumped, `dependencies` in dependent packages reflects the new versions (e.g. `cdr-sdk` deps section should show `cdr-contracts: "0.1.2"` not `"workspace:*"` or `"0.1.1"`)
- [ ] If this PR bumps to a new minor / major, the affected packages' breaking changes are reflected in the CHANGELOG, and any consumer-facing migration notes are present

A bug in the bump type (e.g. patch declared but should have been minor) is fixed by editing `package.json` and `CHANGELOG.md` directly in the Version Packages PR before merging — Changesets's bump is a starting point, not gospel.

## Local dry-run with Verdaccio

Before any release with non-trivial publish surface changes (file layout, new dist outputs, peer-dep changes, scope tweaks), validate with [Verdaccio](https://verdaccio.org/) — a local npm registry mirror:

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

# 4. Build + publish all 3 packages to Verdaccio
pnpm install
pnpm -r run build

cd packages/contracts
NPM_CONFIG_USERCONFIG=/tmp/verdaccio.npmrc pnpm publish --registry http://localhost:4873/ --no-git-checks
cd ../crypto
NPM_CONFIG_USERCONFIG=/tmp/verdaccio.npmrc pnpm publish --registry http://localhost:4873/ --no-git-checks
cd ../sdk
NPM_CONFIG_USERCONFIG=/tmp/verdaccio.npmrc pnpm publish --registry http://localhost:4873/ --no-git-checks

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

This catches: malformed `package.json`, missing `dist/`, `workspace:*` not substituted, runtime import failures — all without touching public npm.

## Rotating NPM_TOKEN

The `NPM_TOKEN` environment secret has a 90-day expiration by default. Rotate it before expiry:

1. Generate a new granular access token at https://www.npmjs.com/settings/lucas2brh/tokens
   - Same scope as before: `@piplabs` org scope, `Read and write` permission
   - 90-day expiration
2. Repo Settings → Environments → `npm-publish` → Environment secrets → `NPM_TOKEN` → **Update**
3. Trigger a no-op release (push any commit to main) and watch the publish step succeed
4. Revoke the old token at https://www.npmjs.com/settings/lucas2brh/tokens

If the token expires before rotation, releases fail at the publish step with a 401. The npm CLI logs `npm error code E401 npm error 401 Unauthorized`. Rotate then re-run the failed workflow.

## When something goes wrong

| Situation | Recovery |
|---|---|
| Just published a wrong version (within 72 hours) | `npm unpublish @piplabs/<package>@<version>` (must be done by an org member with publish rights, from the same npm CLI auth that published). After 72 hours, unpublish is denied by npm policy. |
| Just published a wrong version (> 72 hours) | Cannot unpublish. Use `npm deprecate @piplabs/<package>@<version> "Please use <newer-version> instead"` and ship a corrected version on top. |
| `pnpm changeset publish` fails mid-way through 3 packages | Some packages published, others didn't. Check `npm view @piplabs/<each-package> versions` to identify what made it. Fix the underlying error, then re-run the workflow — `changeset publish` will skip already-published packages and only publish the rest. |
| Wrong bump type committed (e.g. minor declared but should have been major) | Edit the `chore: release packages` PR before merging: bump `version` higher in `package.json`, edit CHANGELOG. The Changesets-generated content is editable. |
| Reviewer accidentally approved a publish run that shouldn't have published | If npm publish hasn't completed yet, **Cancel workflow** in the Actions UI. If it has completed, fall back to unpublish/deprecate above. |
| `npm publish` fails with `403 Forbidden` after token rotation | Granular token's package scope may not cover newly added packages. Either select the broader `@piplabs` scope when generating the token, or add the missing package explicitly. |

## Verifying provenance

Configured via `NPM_CONFIG_PROVENANCE=true` in `.github/workflows/release.yml`. After publish, verify on npm:

```sh
npm view @piplabs/cdr-sdk@<version> --json | jq '.dist.attestations'
```

Should show signed attestation bundle with the GitHub Actions run URL embedded. If absent, provenance configuration was lost — investigate the workflow env block.

## References

- [Changesets — getting started](https://github.com/changesets/changesets#readme)
- [Changesets CLI — full command list](https://github.com/changesets/changesets/blob/main/docs/command-line-options.md)
- [`changesets/action` README](https://github.com/changesets/action#readme)
- [npm provenance](https://docs.npmjs.com/generating-provenance-statements)
- [GitHub Environments](https://docs.github.com/en/actions/deployment/targeting-different-environments/using-environments-for-deployment)
- This repo's release workflow: [`.github/workflows/release.yml`](../.github/workflows/release.yml)
- This repo's changesets config: [`.changeset/config.json`](../.changeset/config.json)
