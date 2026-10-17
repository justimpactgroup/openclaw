import { Type, type Static } from "typebox";

const GUID = "^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$";
const GUID_PATTERN = new RegExp(GUID);

export const ConfigSchema = Type.Object(
  {
    tenantId: Type.Optional(
      Type.String({
        description: "Directory (tenant) ID of your Microsoft Entra tenant",
        pattern: GUID,
        maxLength: 36,
      }),
    ),
    clientId: Type.Optional(
      Type.String({
        description: "Application (client) ID of your Entra app registration",
        pattern: GUID,
        maxLength: 36,
      }),
    ),
  },
  { additionalProperties: false },
);

export type M365Config = Static<typeof ConfigSchema>;

/** The Entra app and tenant the plugin signs in with. `key` tells stored sessions apart. */
export type Account = { key: string; tenantId: string; clientId: string };

/** Checks the config again: tests and raw config can bypass schema validation. */
export function resolveAccount(config: M365Config | undefined): Account | undefined {
  const tenantId = guid(config?.tenantId);
  const clientId = guid(config?.clientId);
  if (!tenantId || !clientId) return undefined;
  return { key: `global|${tenantId}|${clientId}`, tenantId, clientId };
}

function guid(value: unknown): string | undefined {
  return typeof value === "string" && GUID_PATTERN.test(value) ? value.toLowerCase() : undefined;
}
