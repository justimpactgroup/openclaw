# AGENTS.md

Commands and layout: [README](README.md). Read [docs/plugin-security.md](docs/plugin-security.md)
before writing tool code.

## Rules

- Node from `.nvmrc`, then `npm ci`. Never change or bypass `.npmrc`. npm runs no install or
  pre/post scripts, not even this repo's own. Add `--min-release-age=0` only when a newer version is
  really needed, and say why in the PR.
- `npm run check` must pass before a PR; `npm run format` fixes formatting.
- Create plugins only with `npm run new-plugin`, and commit the `package-lock.json` change.
- After changing a plugin's id, name, description, config schema or tools, run
  `npx nx run @justimpactgroup/<name>:manifest` and commit `openclaw.plugin.json`. Edit it by hand
  only for `configContracts` (docs/plugin-security.md).
- Leave `version`, `openclaw.build` and `CHANGELOG.md` to the release. Raise
  `peerDependencies.openclaw` and `openclaw.compat.pluginApi` together, and only when the plugin
  uses newer SDK features.
- Runtime dependencies besides `typebox` need a maintainer's agreement.
- Template changes (`tools/templates/plugin/`): run CI's steps with `ci-smoke`
  (`npm run new-plugin -- ci-smoke --description 'Smoke test "quoted" plugin'`, then
  `npm run check`), then delete `plugins/ci-smoke` and `git checkout package-lock.json`.
- Tests: Vitest in `src/*.spec.ts`, covering invalid arguments and aborted calls like the template.
- Comments only for a non-obvious reason or constraint.
- Workflows: `permissions` set explicitly with the least needed, actions pinned to a full commit SHA,
  no third-party actions.
- PR titles: Conventional Commits scoped to the plugin (`feat(my-plugin): add a tool`), or
  `ci:`/`chore:` for repo-wide changes.
- PR descriptions: short, no session links, ending with "Authored by Claude and carefully reviewed
  by a human."

## Never

- Publish or release: no `npm publish`/`deprecate`/`trust`, no `clawhub` publish/delete/login, no
  running the Release workflow, tagging or pushing to `main`.
- Edit `package-lock.json` by hand.
- Weaken a check to get green: ESLint rules, `tools/scripts`, `.npmrc`, tsconfig strictness, CI
  workflows. If a rule seems wrong, stop and say why. The only exception is a one-line
  `// eslint-disable-next-line <rule> -- <reason>` that you point out in the PR.
- Add telemetry or any other call home, or commit secrets, tokens or `.env` files (tests too).
- Merge or approve PRs, or describe a vulnerability in public ([SECURITY.md](SECURITY.md)).
