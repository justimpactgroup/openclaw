import { randomUUID } from "node:crypto";
import type { PluginLogger } from "openclaw/plugin-sdk/plugin-entry";
import { asOptionalRecord, truncateUtf16Safe } from "openclaw/plugin-sdk/string-coerce-runtime";
import { requestJson, type JsonResponse } from "./http.js";

const GRAPH_HOST = "graph.microsoft.com";
const GRAPH_ROOT = `https://${GRAPH_HOST}/v1.0/`;
const SEGMENT = /^[A-Za-z0-9!._=-]{1,256}$/;
const QUERY_NAME = /^\$[a-z]{1,32}$/;

export type TokenProvider = {
  getAccessToken(signal?: AbortSignal): Promise<string>;
  /** Drops the cached access token so the next call gets a fresh one. */
  invalidate(): void;
};

/** Segments are checked because encodeURIComponent leaves `..`, which would walk to other resources. */
function graphUrl(segments: string[], query: Record<string, string>): URL {
  const safe = (segment: string) => SEGMENT.test(segment) && segment !== "." && segment !== "..";
  if (
    segments.length === 0 ||
    !segments.every(safe) ||
    !Object.keys(query).every((name) => QUERY_NAME.test(name))
  ) {
    throw new Error("Refusing to send a Microsoft Graph request to an unexpected address");
  }
  const url = new URL(GRAPH_ROOT + segments.map(encodeURIComponent).join("/"));
  url.search = Object.entries(query)
    .map(([name, value]) => `${name}=${encodeURIComponent(value).replaceAll("%2C", ",")}`)
    .join("&");
  return url;
}

/** A 401 is retried once with a fresh token. */
export async function graphGet(
  tokens: TokenProvider,
  segments: string[],
  query: Record<string, string>,
  logger: PluginLogger,
  signal?: AbortSignal,
): Promise<unknown> {
  const url = graphUrl(segments, query);
  const send = async () =>
    requestJson({
      url,
      host: GRAPH_HOST,
      init: {
        headers: {
          authorization: `Bearer ${await tokens.getAccessToken(signal)}`,
          accept: "application/json",
          "client-request-id": randomUUID(),
        },
      },
      signal,
      maxBytes: 1024 * 1024,
      auditContext: "m365.graph",
    });

  let response = await send();
  if (response.status === 401) {
    tokens.invalidate();
    response = await send();
  }
  if (response.status < 200 || response.status > 299) throw graphError(response, logger);
  if (response.json === undefined) throw invalidResponse();
  return response.json;
}

export async function getMe(
  tokens: TokenProvider,
  logger: PluginLogger,
  signal?: AbortSignal,
): Promise<{ userPrincipalName: string; displayName?: string }> {
  const me = asOptionalRecord(
    await graphGet(tokens, ["me"], { $select: "id,displayName,userPrincipalName" }, logger, signal),
  );
  if (typeof me?.id !== "string" || typeof me.userPrincipalName !== "string") {
    throw invalidResponse();
  }
  return {
    userPrincipalName: truncateUtf16Safe(me.userPrincipalName, 256),
    ...(typeof me.displayName === "string"
      ? { displayName: truncateUtf16Safe(me.displayName, 256) }
      : {}),
  };
}

const FAILURES = new Map([
  [400, "rejected the request"],
  [401, "did not accept the sign-in"],
  [403, "denied access: the app lacks a permission or admin consent"],
  [404, "found nothing at that address"],
]);

/** Graph's `error.message` is never used: it is upstream text. Only a well-formed code is kept. */
function graphError({ status, headers, json }: JsonResponse, logger: PluginLogger): Error {
  const rawCode = asOptionalRecord(asOptionalRecord(json)?.error)?.code;
  const code =
    typeof rawCode === "string" && /^[A-Za-z][A-Za-z0-9_.]{0,63}$/.test(rawCode) ? rawCode : "";
  const requestId = /^[0-9a-f-]{1,64}$/i.exec(headers.get("request-id") ?? "")?.[0] ?? "";
  logger.warn(`m365: Graph request failed: HTTP ${status} code=${code} request-id=${requestId}`);

  const detail = code ? `HTTP ${status}, ${code}` : `HTTP ${status}`;
  if (status === 429 || status === 503) {
    const seconds = Number(headers.get("retry-after") ?? "");
    const wait = Number.isInteger(seconds) && seconds > 0 && seconds <= 86_400;
    return new Error(
      `Microsoft Graph is throttling requests (${detail})${wait ? `; retry after ${seconds} seconds` : ""}`,
    );
  }
  const reason = FAILURES.get(status) ?? (status >= 500 ? "is unavailable" : "request failed");
  return new Error(`Microsoft Graph ${reason} (${detail})`);
}

function invalidResponse(): Error {
  return new Error("Microsoft Graph returned an unexpected response");
}
