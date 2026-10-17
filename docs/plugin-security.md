# Plugin security

Our plugins run inside users' OpenClaw Gateways without a sandbox. Their tools are called by a
model, and anything the model has read can steer those calls through prompt injection. Write every
tool so that a manipulated model can do as little damage as possible.

ESLint and `validate` enforce part of this. If an exception is justified, disable the rule for one
line and say why: `// eslint-disable-next-line no-restricted-globals -- fixed origin from config`.

## Checklist for every tool

1. **Closed, bounded parameters.** `additionalProperties: false` on every object, `maxLength` on
   strings, `maxItems` on arrays, `minimum`/`maximum` on numbers. Prefer literal unions to free
   text. Constrain IDs with a `pattern` such as `^[A-Za-z0-9_-]{1,64}$`: `encodeURIComponent`
   leaves `.` and `..` intact, so an unchecked ID can walk the API's paths.
2. **Validate again in `execute`** with the template's `parse()`: `/tools/invoke` and the
   `tools.invoke` RPC skip the schema check. Keep the `ToolInputError` name on its errors: those
   calls return only such messages (HTTP 400) and turn other errors into a bare HTTP 500.
3. **Side effects are opt-in and confirmed.** Tools that write, send, delete, pay or publish set
   `optional: true`, and the README tells users to enable them with
   `tools.alsoAllow: ["<tool name>"]`. Irreversible or costly actions also ask on every call with a
   [plugin permission request](https://docs.openclaw.ai/plugins/plugin-permission-requests) (a
   `before_tool_call` hook, so `definePluginEntry` instead of `defineToolPlugin`) offering only
   `["allow-once", "deny"]`.
4. **Network only through the SSRF guard, to the host from plugin config.** Pass the `signal` from
   `execute`'s context, set `timeoutMs`, and call `signal?.throwIfAborted()` inside loops:

   ```ts
   import { fetchWithSsrFGuard } from "openclaw/plugin-sdk/ssrf-runtime";

   const base = new URL(config.baseUrl); // from plugin config, never from tool arguments
   const { response, release } = await fetchWithSsrFGuard({
     url: new URL(`records/${encodeURIComponent(id)}`, base).href,
     init: { headers: { authorization: `Bearer ${config.apiKey}` } },
     policy: { hostnameAllowlist: [base.hostname] },
     requireHttps: true,
     timeoutMs: 15_000,
     signal,
   });
   try {
     if (!response.ok) throw new Error(`Record lookup failed with HTTP ${response.status}`);
     return await response.json();
   } finally {
     await release();
   }
   ```

   If a plugin must reach private-network hosts, make that a config flag that defaults to off and
   list it in `configContracts.dangerousFlags`, so the install screen and `openclaw doctor` show it.

5. **Credentials come from config, as SecretRefs.** Accept a string or a SecretRef:

   ```ts
   const SecretRef = Type.Object(
     {
       source: Type.Union([
         Type.Literal("env"),
         Type.Literal("file"),
         Type.Literal("exec"),
         Type.Literal("store"),
       ]),
       provider: Type.String({ maxLength: 64 }),
       id: Type.String({ maxLength: 256 }),
     },
     { additionalProperties: false },
   );
   // configSchema: Type.Object({ apiKey: Type.Union([Type.String({ minLength: 1 }), SecretRef]) }, ...)
   ```

   Then add this to `openclaw.plugin.json` by hand (`openclaw plugins build` keeps it):

   ```json
   "configContracts": { "secretInputs": { "paths": [{ "path": "apiKey", "expected": "string" }] } }
   ```

   Without `secretInputs` the plugin receives the unresolved object, so narrow it before use:
   `if (typeof config.apiKey !== "string") throw new Error("apiKey is not resolved")`. Never read
   `process.env`, and never put secrets in descriptions, results, errors or logs.

6. **Return little, and treat it as untrusted.** Return only what the model needs. Third-party
   content can carry prompt injection itself, so never phrase results as instructions, and don't
   copy raw upstream errors. Log ids, counts and status codes only.
7. **Document** each tool's side effects, network destinations and the data it sends in the plugin
   README.

See also: [Prompt injection](https://docs.openclaw.ai/gateway/security/prompt-injection).
