# __PACKAGE_NAME__

__DESCRIPTION__

## Install

```bash
openclaw plugins install clawhub:__PACKAGE_NAME__
# or from npm; append @<version> to pin the version you reviewed
openclaw plugins install npm:__PACKAGE_NAME__
```

## Configuration

```json5
{
  plugins: {
    entries: {
      "__PLUGIN_ID__": {
        enabled: true,
        config: {
          prefix: "> ",
        },
      },
    },
  },
}
```

## Tools

<!-- Replace the example row with one row per tool, and state its side effects. -->

| Tool | Description | Side effects |
| --- | --- | --- |
| `__TOOL_NAME__` | Echo the input back, with the configured `prefix` | None |

## Network access

<!-- Update this when a tool contacts a service: name each host and the data it sends. -->

None. The example tool makes no network requests.

## Security

Runs inside the OpenClaw Gateway without a sandbox; enable only the tools you need. This plugin
sends no telemetry. Report vulnerabilities privately as described in the
[security policy](https://github.com/justimpactgroup/openclaw/blob/main/SECURITY.md).

## License

MIT. Not affiliated with or endorsed by the OpenClaw project.
