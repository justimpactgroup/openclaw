import { Type, type Static, type TSchema } from "typebox";
import { Value } from "typebox/value";
import { defineToolPlugin } from "openclaw/plugin-sdk/tool-plugin";

const EchoParams = Type.Object(
  {
    input: Type.String({ description: "Text to echo", minLength: 1, maxLength: 1000 }),
  },
  { additionalProperties: false },
);

/** `/tools/invoke` and the `tools.invoke` RPC reach `execute` without schema validation. */
function parse<T extends TSchema>(schema: T, params: unknown): Static<T> {
  if (Value.Check(schema, params)) return params;
  const [first] = Value.Errors(schema, params);
  throw new Error(`Invalid arguments: ${first?.instancePath || "/"} ${first?.message ?? ""}`);
}

export default defineToolPlugin({
  id: "__PLUGIN_ID__",
  name: "__DISPLAY_NAME__",
  description: "__DESCRIPTION__",
  configSchema: Type.Object(
    {
      prefix: Type.Optional(
        Type.String({ description: "Text prepended to every echoed value", maxLength: 100 }),
      ),
    },
    { additionalProperties: false },
  ),
  tools: (tool) => [
    tool({
      name: "__TOOL_NAME__",
      description: "Echo the given input back, optionally with a configured prefix",
      parameters: EchoParams,
      execute: (params, config, { signal }) => {
        const { input } = parse(EchoParams, params);
        signal?.throwIfAborted();
        return (config.prefix ?? "") + input;
      },
    }),
  ],
});
