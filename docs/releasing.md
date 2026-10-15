# Releasing

Run **Actions → Release → Run workflow** on `main`. After a maintainer approves the `release`
environment, [`nx release`](https://nx.dev/features/manage-releases) bumps each plugin from the
Conventional Commits since its last release, writes `CHANGELOG.md`, commits and tags
`@justimpactgroup/<name>@<version>`. Every version tagged at that commit is then published to npm
(trusted publishing, provenance) and to ClawHub; versions already there are skipped.

Preview locally with `npx nx release --dry-run`. On `0.x`, `feat` bumps the patch and `!` the minor
version, so a new plugin starts at 0.0.1.

If publishing failed, fix the cause and run **Release** again before merging anything else to
`main`: it publishes the tagged versions that npm or ClawHub doesn't have yet.

## One-time setup

1. **Repository** (Settings → General): default branch `main`; allow only squash merging, with the
   pull request title as the default commit message.
2. **Actions** (Settings → Actions → General):
   - Actions permissions: **Allow justimpactgroup, and select non-justimpactgroup, actions and
     reusable workflows**, with only **Allow actions created by GitHub** ticked, and **Require
     actions to be pinned to a full-length commit SHA** ticked
   - Workflow permissions: **Read repository contents and packages permissions**, with **Allow
     GitHub Actions to create and approve pull requests** unticked
3. **Release app**: a GitHub App owned by the organization (needs an organization owner).
   - Open <https://github.com/organizations/justimpactgroup/settings/apps/new>, or: your
     organization's page → **Settings** → **Developer settings** (bottom of the left sidebar) →
     **GitHub Apps** → **New GitHub App**. Use the organization's settings, not your personal ones.
   - **GitHub App name** `justimpactgroup-release`, **Homepage URL**
     `https://github.com/justimpactgroup/openclaw`, untick **Webhook → Active**, **Repository
     permissions → Contents: Read and write**, **Where can this GitHub App be installed?** → **Only
     on this account**, then **Create GitHub App**.
   - On the app's page, copy the **Client ID**, and under **Private keys** click **Generate a
     private key** (it downloads a `.pem` file). Both go into the environment in step 4.
   - In the left sidebar, **Install App** → **Install** next to justimpactgroup → **Only select
     repositories** → `openclaw`.
4. **Environment `release`** (Settings → Environments): deployment branch `main` only, the
   maintainers as required reviewers without admin bypass, secret `RELEASE_APP_PRIVATE_KEY` (the whole `.pem` file),
   variable `RELEASE_APP_CLIENT_ID`, and secret `CLAWHUB_TOKEN` only while a new package needs its
   first ClawHub release. npm and ClawHub trust any `release.yml` run in this environment, so these
   rules are what limit publishing.
5. **Security** (Settings → Advanced Security), everything else can stay as it is:
   - **Private vulnerability reporting:** enabled
   - **Dependency graph:** On
   - **Dependabot alerts:** On, and **Malware alerts:** On
   - **Dependabot security updates:** On
   - **CodeQL analysis:** **Set up** → **Default**, keeping the suggested languages
   - **Secret Protection:** **Enable**, then turn on **Push protection**
6. **Rulesets** (Settings → Rules → Rulesets → **New ruleset**). Create these last, after the first
   pull request is merged. Both rulesets use **Enforcement status: Active** and the release app as
   the only bypass: **Add bypass** → **Apps** → `justimpactgroup-release` (listed once the app is
   installed on the repository).
   - **New branch ruleset**, name `main`: **Add target** → **Include default branch**. Tick
     **Restrict deletions**, **Block force pushes**, **Require a pull request before merging**
     (**Required approvals**: 1, or 0 if you are the only maintainer; **Allowed merge methods**:
     only **Squash**) and **Require status checks to pass** (**Add checks**: `check` and
     `pr-title`). Leave **Restrict creations** and **Restrict updates** unticked, since they would
     block merging pull requests.
   - **New tag ruleset**, name `tags`: **Add target** → **Include all tags**. Tick **Restrict
     creations**, **Restrict updates** and **Restrict deletions**.
7. **Accounts**: two-factor authentication required in the GitHub organization and in the npm
   organization `justimpactgroup`; a ClawHub organization `justimpactgroup` (it must match the npm
   scope).

## First publish of a new package

Do this once for each new plugin, after its pull request is merged and before its first Release.
You need an npm account that can publish in the `justimpactgroup` organization (`npm login`, with
two-factor authentication).

**Why it is needed.** The Release workflow publishes without any password: npm and ClawHub trust
the workflow itself ("trusted publishing"). Both can only be told to trust the workflow for a
package that already exists. So the very first publish of each package is done by hand, with a
placeholder that contains no code. Every version with real code then comes from the Release
workflow, with provenance (a public proof of which commit built it).

**1. Reserve the name on npm** with the placeholder. Run this from the repo root and change
`name`:

```bash
name=my-plugin # folder under plugins/
tmp=$(mktemp -d) && cp LICENSE "$tmp/"
echo "Placeholder. Releases: https://github.com/justimpactgroup/openclaw" > "$tmp/README.md"
cat > "$tmp/package.json" <<EOF
{
  "name": "@justimpactgroup/$name",
  "version": "0.0.0",
  "description": "Placeholder without code",
  "license": "MIT",
  "repository": { "type": "git", "url": "git+https://github.com/justimpactgroup/openclaw.git" }
}
EOF
(cd "$tmp" && npm publish --access public)
npm deprecate "@justimpactgroup/$name@0.0.0" "Placeholder without code"
```

This publishes version 0.0.0 and marks it deprecated so nobody installs it.

**2. Tell npm to trust the Release workflow.** This adds the workflow to npm's list of who may
publish the package. It has to exist when the workflow publishes, and npm removes a new entry that
hasn't been used within 2 days. So run it shortly before you start the Release run: the same day,
right after step 1 and before step 3. If more than 2 days pass, run it again.

```bash
npm trust github "@justimpactgroup/$name" --file release.yml \
  --repository justimpactgroup/openclaw --environment release --allow-publish --yes
npm access set mfa=publish "@justimpactgroup/$name"
```

The first command allows only `release.yml` running in the `release` environment to publish. The
second requires two-factor authentication for any manual publish, so a stolen token can't publish.

**3. Run the Release workflow** (see the top of this page). It publishes the real version to npm
(0.0.1 for a new plugin) and then to ClawHub. ClawHub still needs a token for this first publish:
create it with `npx clawhub login` and `npx clawhub token`, and store it as the `CLAWHUB_TOKEN`
secret in the `release` environment before you run the workflow.

**4. Switch ClawHub to trusted publishing** right after that release, so later versions need no
token:

```bash
npx clawhub package trusted-publisher set "@justimpactgroup/$name" \
  --repository justimpactgroup/openclaw --workflow-filename release.yml --environment release
```

When every package has done step 4, delete `CLAWHUB_TOKEN` from the `release` environment and
revoke the token on clawhub.ai.

## If a published version is broken or compromised

1. Ship the fix first: merge a `fix(<name>): ...` PR and run **Release**.
2. `npm deprecate "@justimpactgroup/<name>@<bad-version>" "<reason>, use <fixed-version>"` and
   `npx clawhub package delete "@justimpactgroup/<name>" --version <bad-version>` (ClawHub only
   withdraws a version that is no longer the latest).
3. For a vulnerability, publish a GitHub security advisory ([SECURITY.md](../SECURITY.md)).
