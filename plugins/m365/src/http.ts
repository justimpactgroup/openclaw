import {
  fetchWithSsrFGuard,
  GuardedFetchRedirectError,
  SsrFBlockedError,
} from "openclaw/plugin-sdk/ssrf-runtime";

export type JsonRequest = {
  url: URL;
  /** The only host this request may reach; also the SSRF guard's allowlist. */
  host: string;
  init: RequestInit;
  signal?: AbortSignal;
  maxBytes: number;
  auditContext: string;
  /** False keeps the request and response out of operator debug captures. */
  capture?: false;
};

export type JsonResponse = {
  status: number;
  headers: Headers;
  /** The parsed body, or undefined when it is empty or not JSON. */
  json: unknown;
};

const TIMEOUT_MS = 15_000;

/** Sends one request to a fixed Microsoft host. Errors never carry upstream text. */
export async function requestJson(request: JsonRequest): Promise<JsonResponse> {
  const { url, host, signal } = request;
  signal?.throwIfAborted();
  if (url.protocol !== "https:" || url.hostname !== host) {
    throw new Error("Refusing to send a Microsoft 365 request to an unexpected address");
  }

  let guarded: Awaited<ReturnType<typeof fetchWithSsrFGuard>>;
  try {
    guarded = await fetchWithSsrFGuard({
      url: url.href,
      init: request.init,
      policy: { hostnameAllowlist: [host] },
      requireHttps: true,
      maxRedirects: 0,
      timeoutMs: TIMEOUT_MS,
      signal,
      auditContext: request.auditContext,
      ...(request.capture === false ? { capture: false } : {}),
    });
  } catch (error) {
    throw transportError(error, signal);
  }

  const { response, release } = guarded;
  try {
    const text = await readText(response, request.maxBytes, signal);
    return { status: response.status, headers: response.headers, json: parseJson(text) };
  } finally {
    await release();
  }
}

async function readText(
  response: Response,
  maxBytes: number,
  signal: AbortSignal | undefined,
): Promise<string> {
  const tooLarge = new Error("Microsoft 365 sent a response that is too large");
  if (Number(response.headers.get("content-length")) > maxBytes) throw tooLarge;
  if (!response.body) return "";

  const reader = (response.body as ReadableStream<Uint8Array>).getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    let chunk: Awaited<ReturnType<typeof reader.read>>;
    try {
      chunk = await reader.read();
    } catch (error) {
      throw transportError(error, signal);
    }
    if (chunk.done) return Buffer.concat(chunks).toString("utf8");
    size += chunk.value.byteLength;
    if (size > maxBytes) {
      await reader.cancel().catch(() => undefined);
      throw tooLarge;
    }
    chunks.push(chunk.value);
  }
}

export function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function parseJson(text: string): unknown {
  try {
    return text ? (JSON.parse(text) as unknown) : undefined;
  } catch {
    return undefined;
  }
}

/** Maps transport failures to fixed messages; the guard's own messages name hosts and policies. */
function transportError(error: unknown, signal: AbortSignal | undefined): unknown {
  if (signal?.aborted) return signal.reason;
  if (error instanceof SsrFBlockedError) {
    return new Error("Microsoft 365 request blocked by network policy");
  }
  if (error instanceof GuardedFetchRedirectError) {
    return new Error("Microsoft 365 sent an unexpected redirect");
  }
  if (error instanceof Error && error.name === "TimeoutError") {
    return new Error("Microsoft 365 request timed out");
  }
  return new Error("Could not reach Microsoft 365");
}
