import { Type, type Static, type TSchema } from "typebox";
import { Value } from "typebox/value";
import type { OpenClawPluginApi } from "openclaw/plugin-sdk/plugin-entry";
import { defineToolPlugin, type ToolPluginToolDefinition } from "openclaw/plugin-sdk/tool-plugin";
import { jsonResult } from "openclaw/plugin-sdk/tool-results";
import {
  completeSignIn,
  inputError,
  REDIRECT_URI,
  SIGN_IN_PROBLEMS,
  SIGN_IN_TTL_MS,
  SignInError,
  signedInScopes,
  signOut,
  startSignIn,
  tokenProvider,
} from "./auth.js";
import { ConfigSchema, resolveAccount, type Account, type M365Config } from "./config.js";
import { getMe } from "./graph.js";

const NoParams = Type.Object({}, { additionalProperties: false });

const SignInCompleteParams = Type.Object(
  {
    redirectUrl: Type.String({
      description: `The full address the browser showed after sign-in, starting with ${REDIRECT_URI}?`,
      minLength: 1,
      maxLength: 8192,
      pattern: `^${REDIRECT_URI}\\?`,
    }),
  },
  { additionalProperties: false },
);

const StatusOutput = Type.Object(
  {
    connection: Type.Union([
      Type.Object(
        {
          signedIn: Type.Literal(true),
          userPrincipalName: Type.String(),
          displayName: Type.Optional(Type.String()),
          scopes: Type.Array(Type.String()),
        },
        { additionalProperties: false },
      ),
      Type.Object(
        {
          signedIn: Type.Literal(false),
          reason: Type.Enum(["not-configured", ...SIGN_IN_PROBLEMS]),
        },
        { additionalProperties: false },
      ),
    ]),
  },
  { additionalProperties: false },
);

/** `/tools/invoke` and the `tools.invoke` RPC reach `execute` without schema validation. */
function parse<T extends TSchema>(schema: T, params: unknown): Static<T> {
  if (Value.Check(schema, params)) return params;
  const [first] = Value.Errors(schema, params);
  throw inputError(`Invalid arguments: ${first?.instancePath || "/"} ${first?.message ?? ""}`);
}

function requireAccount(config: M365Config): Account {
  const account = resolveAccount(config);
  if (!account) {
    throw inputError(
      "Microsoft 365 is not configured: set tenantId and clientId in the plugin config",
    );
  }
  return account;
}

async function connectionStatus(
  api: OpenClawPluginApi,
  config: M365Config,
  signal?: AbortSignal,
): Promise<Static<typeof StatusOutput>["connection"]> {
  const account = resolveAccount(config);
  if (!account) return { signedIn: false, reason: "not-configured" };
  try {
    const me = await getMe(tokenProvider(api, account), api.logger, signal);
    return { signedIn: true, ...me, scopes: (await signedInScopes(api, account)) ?? [] };
  } catch (error) {
    if (error instanceof SignInError) return { signedIn: false, reason: error.reason };
    throw error;
  }
}

type OwnerToolSpec<T extends TSchema> = {
  name: string;
  label: string;
  description: string;
  parameters: T;
  optional?: boolean;
  run: (
    params: Static<T>,
    context: {
      api: OpenClawPluginApi;
      config: M365Config;
      signal?: AbortSignal;
      /** The host's final-effect guard; pass it to every state write. */
      assertCurrent?: () => void;
    },
  ) => unknown;
};

/** A tool that only the Gateway owner gets: it is not created for anyone else. */
function ownerTool<T extends TSchema>({
  run,
  optional,
  ...tool
}: OwnerToolSpec<T>): ToolPluginToolDefinition<M365Config, T> {
  return {
    ...tool,
    optional,
    factory: ({ api, config, toolContext }) => {
      if (toolContext.senderIsOwner !== true) return null;
      return {
        ...tool,
        execute: async (_toolCallId, params, signal) => {
          const parsed = parse(tool.parameters, params);
          signal?.throwIfAborted();
          const assertCurrent = toolContext.assertInvocationCurrent;
          return jsonResult(await run(parsed, { api, config, signal, assertCurrent }));
        },
      };
    },
  };
}

export default defineToolPlugin({
  id: "justimpactgroup-m365",
  name: "Just Impact Group Microsoft 365",
  description:
    "Microsoft 365 for OpenClaw: Outlook mail, calendar, contacts, OneDrive and SharePoint through Microsoft Graph",
  configSchema: ConfigSchema,
  tools: (tool) => [
    tool({
      name: "justimpactgroup_m365_status",
      label: "Microsoft 365 status",
      description:
        "Show whether OpenClaw is signed in to Microsoft 365 and with which account. Read-only toward Microsoft 365.",
      parameters: NoParams,
      outputSchema: StatusOutput,
      execute: async (params, config, { api, signal }) => {
        parse(NoParams, params);
        signal?.throwIfAborted();
        return { connection: await connectionStatus(api, config, signal) };
      },
    }),
    tool(
      ownerTool({
        name: "justimpactgroup_m365_sign_in",
        label: "Microsoft 365 sign-in",
        description:
          "Start signing in to Microsoft 365 and get a sign-in link for the user. After signing in, " +
          'the browser shows an error page such as "This site can\'t be reached"; that is expected. ' +
          `The user copies the full address from the address bar (it starts with ${REDIRECT_URI}) ` +
          "and you pass it to justimpactgroup_m365_sign_in_complete within about a minute.",
        parameters: NoParams,
        run: (_params, { api, config }) => ({
          signIn: {
            url: startSignIn(api, requireAccount(config)),
            redirectAddressStartsWith: REDIRECT_URI,
            expiresInMinutes: SIGN_IN_TTL_MS / 60_000,
          },
        }),
      }),
    ),
    tool(
      ownerTool({
        name: "justimpactgroup_m365_sign_in_complete",
        label: "Microsoft 365 sign-in completion",
        description:
          "Finish the Microsoft 365 sign-in with the address the browser was sent to after signing in.",
        parameters: SignInCompleteParams,
        run: async ({ redirectUrl }, { api, config, signal, assertCurrent }) => ({
          account: {
            signedIn: true,
            ...(await completeSignIn(
              api,
              requireAccount(config),
              redirectUrl,
              signal,
              assertCurrent,
            )),
          },
        }),
      }),
    ),
    tool(
      ownerTool({
        name: "justimpactgroup_m365_sign_out",
        label: "Microsoft 365 sign-out",
        description:
          "Sign out of Microsoft 365 by deleting the tokens OpenClaw stores. Does not revoke access at Microsoft.",
        parameters: NoParams,
        optional: true,
        run: async (_params, { api, assertCurrent }) => {
          await signOut(api, assertCurrent);
          return { account: { signedIn: false } };
        },
      }),
    ),
  ],
});
