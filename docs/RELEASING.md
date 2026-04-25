# Releasing @piplabs/cdr-sdk

Maintainer-facing guide for cutting a new version of `@piplabs/cdr-contracts`, `@piplabs/cdr-crypto`, and `@piplabs/cdr-sdk` to the npm public registry.

> The release pipeline is fully automated by [Changesets](https://github.com/changesets/changesets) + [`changesets/action`](https://github.com/changesets/action), gated by a GitHub `npm-publish` environment with required reviewers. **Do not run `pnpm publish` manually.** All releases go through `main` and the gates below.

## Pipeline gates

Every push to `main` triggers `.github/workflows/release.yml`, which runs in two stages:

**Stage 1 — `changesets` job** (always runs, no approval gate, no npm contact)
- `pnpm install --frozen-lockfile` — reproducible install
- `pnpm -r run build` — TypeScript compiles
- `pnpm -r run test` — vitest unit suites pass
- `changesets/action@v1` — opens / updates the "Version Packages" PR when unreleased changesets exist; otherwise no-op

**Stage 2 — `publish` job** (runs only on actual release commits)
- Conditional `if`: `hasChangesets == 'false' && contains(commit message, 'chore: release packages')`
- `environment: npm-publish` — required reviewer must click **Approve and deploy** before any step runs
- `pnpm install --frozen-lockfile` + `pnpm -r run build` + `pnpm changeset publish` (with OIDC provenance)

The two-stage split means ordinary chore / docs / fix commits never request reviewer approval — they finish in stage 1 and never reach the publish job. Approval is requested only when the merged commit is the auto-generated Version Packages PR (default title `chore: release packages`).

> **Important constraint**: do not rename the Version Packages PR title before merging. The publish guard checks the merge commit message contains `"chore: release packages"`. A renamed title fails the guard closed → the publish job is skipped → no release.

For exact action behaviour see the upstream [`changesets/action` README](https://github.com/changesets/action#readme).

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

1. release.yml `changesets` job runs install / build / test, then `changesets/action` sees your `.md` file and opens (or updates) a PR titled **"chore: release packages"** that:
   - Bumps the affected packages' `version` fields in `package.json`
   - Appends a CHANGELOG entry per package using `@changesets/changelog-github` (auto-links your PR + handle)
   - Deletes the consumed `.changeset/*.md`
2. The `publish` job's `if` guard evaluates false on this commit (the merge commit message is your feature PR's title, not `chore: release packages`), so the job is skipped and no environment approval is requested.
3. Maintainer reviews the "chore: release packages" PR (see [Reviewing the Version Packages PR](#reviewing-the-version-packages-pr) below) and merges it. **Do not rename the PR title** — the publish guard depends on it.
4. release.yml runs again. `changesets` job no-ops (no `.md` files left). `publish` job's `if` guard evaluates true → reaches the `environment: npm-publish` gate.
5. A reviewer (someone in the environment's required reviewers list, not yourself due to **Prevent self-review**) approves in the Actions UI.
6. `pnpm changeset publish` runs, which:
   - Publishes each bumped package (whose `package.json.version > npm dist-tags.latest`)
   - Adds OIDC-signed npm provenance attestation
   - Creates per-package git tags like `@piplabs/cdr-sdk@0.1.3`
   - Creates a GitHub Release per tag (`createGithubReleases` defaults to true)

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

## Reviewing the approval

The `npm-publish` environment gate is reached **only when the publish job runs**, which happens only on the merge of an auto-generated Version Packages PR. Reviewer responsibility at approval time:

| The Actions run is for | What approval means |
|---|---|
| A merged "chore: release packages" PR (Version Packages PR) | Approve to publish to npm. **This is the irreversible step.** Confirm the package versions in the merge commit's `package.json` diffs match what you expect to ship. |
| Anything else (chore / docs / fix / feature PR with changeset) | The publish job's `if` guard skips this run — no approval is requested in the first place. If you do see an unexpected approval request, **DO NOT APPROVE.** Investigate the merge commit; the only way the publish job runs is if its commit message contains `chore: release packages`, which should mean the Version Packages PR was merged.

Before clicking Approve, click into the run, expand the `publish` job, and verify the diff that triggered it actually bumps versions you intend to release.

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

The `NPM_TOKEN` environment secret has a 90-day expiration by default. Rotate it before expiry. Any maintainer with publish rights to the `@piplabs` npm org can perform the rotation; the token belongs to whoever generated it, not to a fixed individual.

1. Generate a new granular access token at https://www.npmjs.com/settings/<your-npm-handle>/tokens (the npmjs.com Account → Access Tokens page for your own npm user)
   - Scope: `@piplabs` org, `Read and write` permission
   - 90-day expiration
2. **Verify the new token works against the real npm registry, locally**, before touching the secret:

   ```sh
   # Replace <new-token> with the value just generated.
   # Single-line, no shell history (don't quote the token in a way that lands in ~/.zsh_history).
   NPM_TOKEN_TEST=<new-token>; \
     curl -fsS -H "Authorization: Bearer $NPM_TOKEN_TEST" https://registry.npmjs.org/-/whoami; \
     unset NPM_TOKEN_TEST
   # Expected: {"username":"<your-npm-handle>"}.  401 → token bad / wrong scope.
   ```

3. Repo Settings → Environments → `npm-publish` → Environment secrets → `NPM_TOKEN` → **Update**
4. Revoke the old token in the previous owner's npmjs.com Access Tokens page

If the token expires before rotation, releases fail at the publish step with a 401. Rotate, then re-run the failed workflow.

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
