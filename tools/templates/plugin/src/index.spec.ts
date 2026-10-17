import { describe, expect, it } from "vitest";
import plugin from "./index.js";

type RegisteredTool = {
  name: string;
  execute: (toolCallId: string, params: unknown, signal?: AbortSignal) => Promise<unknown>;
};

function echoTool(pluginConfig: Record<string, unknown> = {}): RegisteredTool {
  const tools: RegisteredTool[] = [];
  plugin.register({
    pluginConfig,
    registerTool: (tool: RegisteredTool) => tools.push(tool),
  } as never);
  const tool = tools.find((t) => t.name === "__TOOL_NAME__");
  if (!tool) throw new Error("__TOOL_NAME__ is not registered");
  return tool;
}

describe("__TOOL_NAME__", () => {
  it("echoes the input with the configured prefix", async () => {
    await expect(
      echoTool({ prefix: "> " }).execute("call-1", { input: "hi" }),
    ).resolves.toMatchObject({ content: [{ type: "text", text: "> hi" }] });
  });

  it.each([{ input: 42 }, { input: "hi", extra: true }, {}, { input: "x".repeat(1001) }])(
    "rejects invalid arguments %j",
    async (params) => {
      const call = echoTool().execute("call-1", params);
      await expect(call).rejects.toThrow(/^Invalid arguments/);
      await expect(call).rejects.toMatchObject({ name: "ToolInputError" });
    },
  );

  it("stops when the call is aborted", async () => {
    await expect(
      echoTool().execute("call-1", { input: "hi" }, AbortSignal.abort()),
    ).rejects.toThrow();
  });
});
