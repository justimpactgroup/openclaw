# Just Impact Group OpenClaw plugins

[OpenClaw](https://github.com/openclaw/openclaw) plugins by Just Impact Group, each published as
`@justimpactgroup/<name>` to npm and [ClawHub](https://clawhub.ai). MIT licensed, no telemetry, not
affiliated with the OpenClaw project.

## Layout

```
plugins/<name>/       one plugin per package; install instructions in its README
docs/                 plugin security guide, release process
tools/scripts/        repo scripts, run directly by Node
tools/templates/      template for `npm run new-plugin`
tools/release/        nx release hook (keeps openclaw.plugin.json versions in sync)
```

## Development

```bash
nvm use && npm ci
npm run check                                     # everything CI checks
npm run check:project -- @justimpactgroup/<name>  # lint, typecheck, test, build, validate one plugin
npm run format
```

`.npmrc` refuses install scripts, git dependencies and versions published less than 7 days ago. To
take a newer release on purpose, add `--min-release-age=0` to the install command.

## Adding a plugin

```bash
npm run new-plugin -- my-plugin --description "Describe what it does"
```

Replace the example tool, following [Plugin security](docs/plugin-security.md).
`openclaw.plugin.json` is generated: after changing the plugin id, name, description, config schema
or tools, run `npx nx run @justimpactgroup/my-plugin:manifest` and commit the result.

Docs: [Tool plugins](https://docs.openclaw.ai/plugins/tool-plugins),
[Building plugins](https://docs.openclaw.ai/plugins/building-plugins),
[Manifest](https://docs.openclaw.ai/plugins/manifest).

## Upgrading OpenClaw

```bash
npm install -D openclaw@<version>
npm run check
```

Raise a plugin's `peerDependencies.openclaw` and `openclaw.compat.pluginApi` together, and only when
it starts using newer SDK features: they are the minimum version users need.

## Contributing

Open an issue before larger changes. A Just Impact Group maintainer reviews every change, and
whoever opens a pull request is responsible for all of it. PRs are squash-merged and the title
becomes the release commit, so use Conventional Commits scoped to the plugin:
`feat(my-plugin): add a tool` (`ci:` or `chore:` for repo-wide changes).

Releases: [docs/releasing.md](docs/releasing.md). Security issues: [SECURITY.md](SECURITY.md).
