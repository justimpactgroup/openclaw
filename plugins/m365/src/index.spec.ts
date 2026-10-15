import { getToolPluginMetadata } from "openclaw/plugin-sdk/tool-plugin";
import { afterEach, describe, expect, it, vi } from "vitest";
import plugin from "./index.js";

const TENANT = "11111111-2222-3333-4444-555555555555";
const CLIENT = "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee";
const CONFIG = { tenantId: TENANT, clientId: CLIENT };
const SECRETS = ["fake-access", "fake-refresh", "fake-code"];

type Tool = {
  name: string;
  execute: (toolCallId: string, params: unknown, signal?: AbortSignal) => Promise<unknown>;
};
type Context = { senderIsOwner?: boolean; assertInvocationCurrent?: () => void };
type Factory = (context: Context) => Tool | null;
type Guard = { assertCurrent?: () => void };

function setUp(pluginConfig: Record<string, unknown> = CONFIG) {
  const entries = new Map<string, unknown>();
  const store = {
    register: (key: string, value: unknown, opts?: Guard) => {
      opts?.assertCurrent?.();
      return Promise.resolve(void entries.set(key, value));
    },
    lookup: (key: string) => Promise.resolve(entries.get(key)),
    delete: (key: string, opts?: Guard) => {
      opts?.assertCurrent?.();
      return Promise.resolve(entries.delete(key));
    },
  };
  const logger = { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() };
  const registered = new Map<string, Tool | Factory>();
  plugin.register({
    pluginConfig,
    logger,
    runtime: { state: { openKeyedStore: () => store } },
    registerTool: (tool: Tool | Factory, opts?: { name?: string }) =>
      registered.set(typeof tool === "function" ? (opts?.name ?? "") : tool.name, tool),
  } as never);

  const tool = (name: string, toolContext: Context = { senderIsOwner: true }) => {
    const entry = registered.get(`justimpactgroup_m365_${name}`);
    if (!entry) throw new Error(`${name} is not registered`);
    return typeof entry === "function" ? entry(toolContext) : entry;
  };
  const run = async (name: string, params: unknown = {}, signal?: AbortSignal) => {
    const found = tool(name);
    if (!found) throw new Error(`${name} is not available`);
    return ((await found.execute("call-1", params, signal)) as { details: unknown }).details;
  };
  return { entries, logger, tool, run };
}

/** A fake Microsoft that serves the token endpoint and GET /me. */
function stubMicrosoft() {
  const calls: Array<{ url: string; headers: Headers }> = [];
  const json = (body: unknown) => Promise.resolve(new Response(JSON.stringify(body)));
  const encode = (value: unknown) => Buffer.from(JSON.stringify(value)).toString("base64url");
  const fetch = vi.fn((input: string | URL, init?: RequestInit) => {
    init?.signal?.throwIfAborted();
    const url = String(input);
    calls.push({ url, headers: new Headers(init?.headers) });
    if (url === `https://login.microsoftonline.com/${TENANT}/oauth2/v2.0/token`) {
      return json({
        token_type: "Bearer",
        access_token: "fake-access-1",
        refresh_token: "fake-refresh-1",
        id_token: `${encode({})}.${encode({ tid: TENANT, aud: CLIENT, oid: "oid-1", preferred_username: "ada@contoso.example" })}.sig`,
        expires_in: 3600,
        scope: "https://graph.microsoft.com/User.Read openid profile offline_access",
      });
    }
    if (url.startsWith("https://graph.microsoft.com/v1.0/me?")) {
      return json({ id: "oid-1", displayName: "Ada", userPrincipalName: "ada@contoso.example" });
    }
    throw new Error("unexpected request");
  });
  vi.stubGlobal("fetch", fetch);
  return { calls, fetch };
}

const TOOLS = ["status", "sign_in", "sign_in_complete", "sign_out"];

afterEach(() => vi.unstubAllGlobals());

describe("tools", () => {
  it.each(TOOLS.flatMap((name) => [42, null, { extra: true }].map((params) => [name, params])))(
    "%s rejects invalid arguments %j",
    async (name, params) => {
      await expect(setUp().run(name as string, params)).rejects.toThrow(/^Invalid arguments/);
    },
  );

  it.each([
    "http://localhost/other?code=x",
    "http://localhost:8080/openclaw-m365?code=x",
    `http://localhost/openclaw-m365?${"x".repeat(8192)}`,
  ])("sign_in_complete rejects the address %s", async (redirectUrl) => {
    await expect(setUp().run("sign_in_complete", { redirectUrl })).rejects.toThrow(
      /^Invalid arguments/,
    );
  });

  it.each(TOOLS)("%s stops when the call is aborted", async (name) => {
    const { fetch } = stubMicrosoft();
    const params =
      name === "sign_in_complete"
        ? { redirectUrl: "http://localhost/openclaw-m365?code=c&state=s" }
        : {};
    await expect(setUp().run(name, params, AbortSignal.abort())).rejects.toMatchObject({
      name: "AbortError",
    });
    expect(fetch).not.toHaveBeenCalled();
  });

  it.each([false, undefined])("hides the sign-in tools when senderIsOwner is %s", (owner) => {
    const { tool } = setUp();
    for (const name of ["sign_in", "sign_in_complete", "sign_out"]) {
      expect(tool(name, { senderIsOwner: owner })).toBeNull();
    }
    expect(tool("status", { senderIsOwner: owner })).not.toBeNull();
  });

  it("marks only sign_out as optional", () => {
    const tools = getToolPluginMetadata(plugin)?.tools ?? [];
    expect(tools.filter((t) => t.optional).map((t) => t.name)).toEqual([
      "justimpactgroup_m365_sign_out",
    ]);
  });

  it.each([{}, { tenantId: TENANT }, { tenantId: "common", clientId: CLIENT }])(
    "reports config %j as not configured",
    async (config) => {
      const { run } = setUp(config);
      await expect(run("status")).resolves.toEqual({
        connection: { signedIn: false, reason: "not-configured" },
      });
      await expect(run("sign_in")).rejects.toThrow("not configured");
    },
  );

  it("reports not-signed-in without contacting Microsoft", async () => {
    const { fetch } = stubMicrosoft();
    await expect(setUp().run("status")).resolves.toEqual({
      connection: { signedIn: false, reason: "not-signed-in" },
    });
    expect(fetch).not.toHaveBeenCalled();
  });

  it.each([
    [{ error: "invalid_grant" }, "sign-in-expired"],
    [{ error: "invalid_grant", error_codes: [65001] }, "consent-required"],
    [{ error: "interaction_required", error_codes: [53003] }, "blocked-by-policy"],
    [{ error: "invalid_grant", error_codes: [50076] }, "blocked-by-policy"],
  ])("reports the refresh error %j as %s", async (body, reason) => {
    const { run, entries } = setUp();
    entries.set("current", {
      v: 1,
      account: `global|${TENANT}|${CLIENT}`,
      oid: "oid-1",
      username: "ada@contoso.example",
      refreshToken: "fake-refresh",
      scopes: ["User.Read"],
      updatedAt: 0,
    });
    vi.stubGlobal(
      "fetch",
      vi.fn(() => Promise.resolve(new Response(JSON.stringify(body), { status: 400 }))),
    );
    await expect(run("status")).resolves.toEqual({ connection: { signedIn: false, reason } });
  });

  it("returns a consent error from sign_in_complete as an input error", async () => {
    const { run } = setUp();
    const started = (await run("sign_in")) as { signIn: { url: string } };
    const state = new URL(started.signIn.url).searchParams.get("state") ?? "";
    const body = { error: "invalid_grant", error_codes: [65001] };
    vi.stubGlobal(
      "fetch",
      vi.fn(() => Promise.resolve(new Response(JSON.stringify(body), { status: 400 }))),
    );
    await expect(
      run("sign_in_complete", {
        redirectUrl: `http://localhost/openclaw-m365?code=c&state=${state}`,
      }),
    ).rejects.toMatchObject({
      name: "ToolInputError",
      message:
        "The app lacks consent for its permissions: an admin must grant it in Microsoft Entra",
    });
  });

  it("passes the host's invocation guard to the state writes", async () => {
    stubMicrosoft();
    const { run, tool, entries } = setUp();
    const stale = {
      senderIsOwner: true,
      assertInvocationCurrent: () => {
        throw new Error("stale");
      },
    };
    const redirectFor = async () => {
      const started = (await run("sign_in")) as { signIn: { url: string } };
      const state = new URL(started.signIn.url).searchParams.get("state") ?? "";
      return { redirectUrl: `http://localhost/openclaw-m365?code=fake-code&state=${state}` };
    };

    await expect(
      tool("sign_in_complete", stale)?.execute("call-2", await redirectFor()),
    ).rejects.toThrow("stale");
    expect(entries.size).toBe(0);

    await run("sign_in_complete", await redirectFor());
    await expect(tool("sign_out", stale)?.execute("call-3", {})).rejects.toThrow("stale");
    expect(entries.size).toBe(1);
  });

  it("signs in, checks the connection and signs out without exposing secrets", async () => {
    const { calls } = stubMicrosoft();
    const { run, entries, logger } = setUp();

    const started = (await run("sign_in")) as { signIn: { url: string } };
    expect(started).toEqual({
      signIn: {
        url: expect.stringMatching(
          `^https://login\\.microsoftonline\\.com/${TENANT}/oauth2/v2\\.0/authorize\\?`,
        ) as unknown,
        redirectAddressStartsWith: "http://localhost/openclaw-m365",
        expiresInMinutes: 10,
      },
    });
    const state = new URL(started.signIn.url).searchParams.get("state") ?? "";
    const redirectUrl = `http://localhost/openclaw-m365?code=fake-code&state=${state}&session_state=s`;

    const results = [
      started,
      await run("sign_in_complete", { redirectUrl }),
      await run("status"),
      await run("sign_out"),
      await run("status"),
    ];
    expect(results.slice(1)).toEqual([
      {
        account: {
          signedIn: true,
          username: "ada@contoso.example",
          scopes: ["User.Read"],
        },
      },
      {
        connection: {
          signedIn: true,
          userPrincipalName: "ada@contoso.example",
          displayName: "Ada",
          scopes: ["User.Read"],
        },
      },
      { account: { signedIn: false } },
      { connection: { signedIn: false, reason: "not-signed-in" } },
    ]);
    expect(entries.size).toBe(0);

    // Authorization goes to Graph only; the token endpoint gets none.
    expect(
      calls.map((call) => [new URL(call.url).hostname, call.headers.has("authorization")]),
    ).toEqual([
      ["login.microsoftonline.com", false],
      ["graph.microsoft.com", true],
    ]);
    const visible = JSON.stringify([results, Object.values(logger).map((fn) => fn.mock.calls)]);
    for (const secret of SECRETS) expect(visible).not.toContain(secret);
  });
});
