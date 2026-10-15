import type { OpenClawPluginApi } from "openclaw/plugin-sdk/plugin-entry";
import { fetchWithSsrFGuard } from "openclaw/plugin-sdk/ssrf-runtime";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  completeSignIn,
  currentSignIn,
  pkceChallenge,
  REDIRECT_URI,
  SignInError,
  signOut,
  startSignIn,
  tokenProvider,
} from "./auth.js";
import { resolveAccount, type Account } from "./config.js";

const TENANT = "11111111-2222-3333-4444-555555555555";
const CLIENT = "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee";
const OID = "99999999-8888-7777-6666-555555555555";
const ACCOUNT = resolveAccount({ tenantId: TENANT, clientId: CLIENT }) as Account;
const TOKEN_URL = `https://login.microsoftonline.com/${TENANT}/oauth2/v2.0/token`;

vi.mock(import("openclaw/plugin-sdk/ssrf-runtime"), async (importOriginal) => {
  const original = await importOriginal();
  return { ...original, fetchWithSsrFGuard: vi.fn(original.fetchWithSsrFGuard) };
});

function fakeApi(entries = new Map<string, unknown>()) {
  type Guard = { assertCurrent?: () => void };
  const store = {
    register: vi.fn((key: string, value: unknown, opts?: Guard) => {
      opts?.assertCurrent?.();
      entries.set(key, structuredClone(value));
      return Promise.resolve();
    }),
    lookup: vi.fn((key: string) => Promise.resolve(entries.get(key))),
    delete: vi.fn((key: string, opts?: Guard) => {
      opts?.assertCurrent?.();
      return Promise.resolve(entries.delete(key));
    }),
  };
  const logger = { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() };
  const openKeyedStore = vi.fn(() => store);
  const api = { logger, runtime: { state: { openKeyedStore } } } as unknown as OpenClawPluginApi;
  return { api, entries, logger, openKeyedStore, store };
}

function idToken(claims: Record<string, unknown> = {}): string {
  const encode = (value: unknown) => Buffer.from(JSON.stringify(value)).toString("base64url");
  return [
    encode({ alg: "RS256" }),
    encode({
      tid: TENANT,
      aud: CLIENT,
      oid: OID,
      preferred_username: "ada@contoso.example",
      ...claims,
    }),
    "fake-signature",
  ].join(".");
}

function tokens(overrides: Record<string, unknown> = {}) {
  return {
    token_type: "Bearer",
    access_token: "fake-access-1",
    refresh_token: "fake-refresh-1",
    id_token: idToken(),
    expires_in: 3600,
    scope: "https://graph.microsoft.com/User.Read openid profile offline_access",
    ...overrides,
  };
}

type TokenCall = { url: string; headers: Headers; form: URLSearchParams };

/** Stubs fetch with a token endpoint that answers with the given bodies in order. */
function stubTokenEndpoint(...bodies: Array<{ status?: number; body: unknown }>) {
  const calls: TokenCall[] = [];
  const fetch = vi.fn((input: string | URL, init?: RequestInit) => {
    init?.signal?.throwIfAborted();
    calls.push({
      url: String(input),
      headers: new Headers(init?.headers),
      form: new URLSearchParams(typeof init?.body === "string" ? init.body : ""),
    });
    const next = bodies.shift();
    if (String(input) !== TOKEN_URL || !next) throw new Error("unexpected request");
    return Promise.resolve(new Response(JSON.stringify(next.body), { status: next.status ?? 200 }));
  });
  vi.stubGlobal("fetch", fetch);
  return { calls, fetch };
}

function redirectFor(signInUrl: string, extra = "code=fake-code"): string {
  const state = new URL(signInUrl).searchParams.get("state") ?? "";
  return `${REDIRECT_URI}?${extra}&state=${state}&session_state=fake-session`;
}

async function signIn(api: OpenClawPluginApi) {
  return completeSignIn(api, ACCOUNT, redirectFor(startSignIn(api, ACCOUNT)));
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
  vi.mocked(fetchWithSsrFGuard).mockClear();
});

describe("startSignIn", () => {
  it("computes the RFC 7636 appendix B challenge", () => {
    expect(pkceChallenge("dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk")).toBe(
      "E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM",
    );
  });

  it("builds the authorize address for the configured tenant and app", () => {
    const url = new URL(startSignIn(fakeApi().api, ACCOUNT));
    expect(url.origin + url.pathname).toBe(
      `https://login.microsoftonline.com/${TENANT}/oauth2/v2.0/authorize`,
    );
    expect(Object.fromEntries(url.searchParams)).toEqual({
      client_id: CLIENT,
      response_type: "code",
      redirect_uri: "http://localhost/openclaw-m365",
      response_mode: "query",
      scope: "openid profile offline_access https://graph.microsoft.com/User.Read",
      state: expect.stringMatching(/^[A-Za-z0-9_-]{22}$/) as unknown,
      code_challenge: expect.stringMatching(/^[A-Za-z0-9_-]{43}$/) as unknown,
      code_challenge_method: "S256",
      prompt: "select_account",
    });
  });
});

describe("completeSignIn", () => {
  it("redeems the code with PKCE and stores the session", async () => {
    const { api, entries, openKeyedStore, store } = fakeApi();
    const { calls } = stubTokenEndpoint({ body: tokens() });
    const signInUrl = startSignIn(api, ACCOUNT);

    await expect(completeSignIn(api, ACCOUNT, redirectFor(signInUrl))).resolves.toEqual({
      username: "ada@contoso.example",
      scopes: ["User.Read"],
    });
    // capture: false keeps the code, verifier and tokens out of operator debug captures.
    expect(fetchWithSsrFGuard).toHaveBeenCalledWith(
      expect.objectContaining({
        capture: false,
        maxRedirects: 0,
        timeoutMs: 15_000,
        requireHttps: true,
        policy: { hostnameAllowlist: ["login.microsoftonline.com"] },
        auditContext: "m365.token",
      }),
    );

    const [call] = calls;
    expect(call?.headers.get("content-type")).toBe("application/x-www-form-urlencoded");
    expect(call?.headers.has("authorization")).toBe(false);
    expect(Object.fromEntries(call?.form ?? [])).toEqual({
      client_id: CLIENT,
      scope: "openid profile offline_access https://graph.microsoft.com/User.Read",
      grant_type: "authorization_code",
      code: "fake-code",
      redirect_uri: REDIRECT_URI,
      code_verifier: expect.stringMatching(/^[A-Za-z0-9_-]{43}$/) as unknown,
    });
    expect(pkceChallenge(call?.form.get("code_verifier") ?? "")).toBe(
      new URL(signInUrl).searchParams.get("code_challenge"),
    );
    expect(entries.get("current")).toEqual({
      v: 1,
      account: `global|${TENANT}|${CLIENT}`,
      oid: OID,
      username: "ada@contoso.example",
      refreshToken: "fake-refresh-1",
      scopes: ["User.Read"],
      updatedAt: expect.any(Number) as unknown,
    });
    expect(openKeyedStore).toHaveBeenCalledWith({
      namespace: "session",
      maxEntries: 1,
      overflowPolicy: "reject-new",
    });
    expect(store.register).toHaveBeenLastCalledWith(
      "current",
      expect.anything(),
      expect.objectContaining({ ttlMs: 90 * 86_400_000 }),
    );
    // The access token from the redemption is used without another request.
    await expect(tokenProvider(api, ACCOUNT).getAccessToken()).resolves.toBe("fake-access-1");
    expect(calls).toHaveLength(1);
  });

  it.each([
    ["another host", (url: string) => url.replace("localhost", "evil.example")],
    ["another path", (url: string) => url.replace("/openclaw-m365", "/other")],
    ["https", (url: string) => url.replace("http:", "https:")],
    ["a wrong state", (url: string) => url.replace(/state=[^&]+/, "state=forged")],
    ["no code", (url: string) => url.replace("code=fake-code", "x=1")],
  ])("rejects an address with %s", async (_case, change) => {
    const { api } = fakeApi();
    const { fetch } = stubTokenEndpoint({ body: tokens() });
    const url = change(redirectFor(startSignIn(api, ACCOUNT)));
    await expect(completeSignIn(api, ACCOUNT, url)).rejects.toThrow();
    expect(fetch).not.toHaveBeenCalled();
  });

  it("uses a pending sign-in only once", async () => {
    const { api } = fakeApi();
    const { fetch } = stubTokenEndpoint({ body: tokens() });
    const url = redirectFor(startSignIn(api, ACCOUNT));
    await completeSignIn(api, ACCOUNT, url);
    await expect(completeSignIn(api, ACCOUNT, url)).rejects.toThrow(
      "No Microsoft 365 sign-in is in progress",
    );

    const retried = redirectFor(startSignIn(api, ACCOUNT));
    await expect(
      completeSignIn(api, ACCOUNT, retried.replace(/state=[^&]+/, "state=forged")),
    ).rejects.toThrow("does not belong to the current sign-in");
    await expect(completeSignIn(api, ACCOUNT, retried)).rejects.toThrow(
      "No Microsoft 365 sign-in is in progress",
    );
    expect(fetch).toHaveBeenCalledOnce();
  });

  it("rejects a sign-in that was not started or has expired", async () => {
    const { api } = fakeApi();
    const { fetch } = stubTokenEndpoint({ body: tokens() });
    await expect(completeSignIn(api, ACCOUNT, `${REDIRECT_URI}?code=c&state=s`)).rejects.toThrow(
      "No Microsoft 365 sign-in is in progress",
    );

    vi.useFakeTimers({ toFake: ["Date"] });
    const url = redirectFor(startSignIn(api, ACCOUNT));
    vi.setSystemTime(Date.now() + 11 * 60_000);
    await expect(completeSignIn(api, ACCOUNT, url)).rejects.toThrow(
      "No Microsoft 365 sign-in is in progress",
    );
    expect(fetch).not.toHaveBeenCalled();
  });

  it("reports a denied sign-in without Microsoft's description", async () => {
    const { api } = fakeApi();
    const url = redirectFor(
      startSignIn(api, ACCOUNT),
      "error=access_denied&error_description=AADSTS65004%3A+secret-description",
    );
    const error = await completeSignIn(api, ACCOUNT, url).catch((e: unknown) => e);
    // The name lets /tools/invoke return the message instead of a bare HTTP 500.
    expect(error).toMatchObject({
      name: "ToolInputError",
      message: "The Microsoft sign-in was cancelled or denied",
    });
  });

  it.each([
    ["tenant", { tid: "00000000-0000-0000-0000-000000000000" }],
    ["app", { aud: "00000000-0000-0000-0000-000000000000" }],
  ])("rejects an id_token for another %s", async (_case, claims) => {
    const { api, entries } = fakeApi();
    stubTokenEndpoint({ body: tokens({ id_token: idToken(claims) }) });
    await expect(signIn(api)).rejects.toThrow("different tenant or app");
    expect(entries.size).toBe(0);
  });

  it.each([
    ["token type", { token_type: "mac" }],
    ["access token", { access_token: "" }],
    ["lifetime", { expires_in: "soon" }],
    ["scope", { scope: 42 }],
    ["refresh token", { refresh_token: undefined }],
    ["id_token", { id_token: undefined }],
    ["object id", { id_token: idToken({ oid: undefined }) }],
    ["id_token payload", { id_token: "a.not-json.c" }],
  ])("rejects a token response with a bad %s", async (_case, overrides) => {
    const { api, entries } = fakeApi();
    stubTokenEndpoint({ body: tokens(overrides) });
    await expect(signIn(api)).rejects.toThrow("Microsoft sign-in returned an unexpected response");
    expect(entries.size).toBe(0);
  });

  it.each([
    [{ error: "invalid_grant", error_codes: [70008] }, "Microsoft did not accept the sign-in code"],
    [{ error: "invalid_grant", error_codes: [54005] }, "Microsoft did not accept the sign-in code"],
    [{ error: "invalid_client", error_codes: [7000218] }, "app registration"],
    [{ error: "invalid_grant", error_codes: [65001] }, "lacks consent"],
    [{ error: "interaction_required", error_codes: [53003] }, "Conditional Access"],
  ])("reports the redemption error %j as an input error", async (body, message) => {
    const { api } = fakeApi();
    stubTokenEndpoint({ status: 400, body });
    await expect(signIn(api)).rejects.toMatchObject({
      name: "ToolInputError",
      message: expect.stringContaining(message) as unknown,
    });
  });

  it("reports an unavailable token endpoint as an internal error", async () => {
    const { api } = fakeApi();
    stubTokenEndpoint({ status: 429, body: {} });
    const error = await signIn(api).catch((e: unknown) => e);
    expect(error).toMatchObject({
      name: "Error",
      message: expect.stringContaining("HTTP 429") as unknown,
    });
  });

  it("uses the requested scopes when Microsoft omits them", async () => {
    const { api } = fakeApi();
    stubTokenEndpoint({ body: tokens({ scope: undefined }) });
    await expect(signIn(api)).resolves.toEqual({
      username: "ada@contoso.example",
      scopes: ["User.Read"],
    });
  });

  it("stores nothing when the host withdraws the call's authority", async () => {
    const { api, entries } = fakeApi();
    stubTokenEndpoint({ body: tokens() });
    const assertCurrent = () => {
      throw new Error("authority changed");
    };
    const url = redirectFor(startSignIn(api, ACCOUNT));
    await expect(completeSignIn(api, ACCOUNT, url, undefined, assertCurrent)).rejects.toThrow(
      "authority changed",
    );
    expect(entries.size).toBe(0);
  });

  it("refuses a second account until the first signs out", async () => {
    const { api, entries } = fakeApi();
    const other = { id_token: idToken({ oid: "00000000-0000-0000-0000-000000000001" }) };
    stubTokenEndpoint({ body: tokens() }, { body: tokens(other) }, { body: tokens(other) });
    await signIn(api);
    await expect(signIn(api)).rejects.toThrow("Sign out first");
    expect(entries.get("current")).toMatchObject({ oid: OID });

    await signOut(api);
    await signIn(api);
    expect(entries.get("current")).toMatchObject({ oid: "00000000-0000-0000-0000-000000000001" });
  });
});

describe("tokenProvider", () => {
  async function signedIn(...refreshBodies: Array<{ status?: number; body: unknown }>) {
    const fake = fakeApi();
    const endpoint = stubTokenEndpoint({ body: tokens() }, ...refreshBodies);
    await signIn(fake.api);
    const provider = tokenProvider(fake.api, ACCOUNT);
    provider.invalidate();
    return { ...fake, ...endpoint, provider };
  }

  it("stores the rotated refresh token", async () => {
    const { provider, calls, entries, store } = await signedIn({
      body: tokens({ access_token: "fake-access-2", refresh_token: "fake-refresh-2" }),
    });
    await expect(provider.getAccessToken()).resolves.toBe("fake-access-2");
    expect(Object.fromEntries(calls[1]?.form ?? [])).toEqual({
      client_id: CLIENT,
      scope: "openid profile offline_access https://graph.microsoft.com/User.Read",
      grant_type: "refresh_token",
      refresh_token: "fake-refresh-1",
    });
    expect(entries.get("current")).toMatchObject({ refreshToken: "fake-refresh-2" });
    expect(store.register).toHaveBeenLastCalledWith(
      "current",
      expect.anything(),
      expect.objectContaining({ ttlMs: 90 * 86_400_000 }),
    );
  });

  it("keeps the old refresh token when Microsoft sends none", async () => {
    const { provider, entries } = await signedIn({
      body: tokens({ access_token: "fake-access-2", refresh_token: undefined }),
    });
    await expect(provider.getAccessToken()).resolves.toBe("fake-access-2");
    expect(entries.get("current")).toMatchObject({ refreshToken: "fake-refresh-1" });
  });

  it("refreshes once for concurrent callers", async () => {
    const { provider, calls } = await signedIn({ body: tokens({ access_token: "fake-access-2" }) });
    await expect(
      Promise.all([provider.getAccessToken(), provider.getAccessToken()]),
    ).resolves.toEqual(["fake-access-2", "fake-access-2"]);
    expect(calls).toHaveLength(2);
  });

  it("lets a caller abort without cancelling the shared refresh", async () => {
    const { provider, entries } = await signedIn({
      body: tokens({ access_token: "fake-access-2", refresh_token: "fake-refresh-2" }),
    });
    const controller = new AbortController();
    const first = provider.getAccessToken(controller.signal);
    const second = provider.getAccessToken();
    controller.abort();
    await expect(first).rejects.toThrow();
    await expect(second).resolves.toBe("fake-access-2");
    expect(entries.get("current")).toMatchObject({ refreshToken: "fake-refresh-2" });
  });

  it("refreshes only within five minutes of expiry", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    const fake = fakeApi();
    const { calls } = stubTokenEndpoint(
      { body: tokens() },
      { body: tokens({ access_token: "fake-access-2" }) },
    );
    await signIn(fake.api);
    const provider = tokenProvider(fake.api, ACCOUNT);

    vi.setSystemTime(Date.now() + 54 * 60_000);
    await expect(provider.getAccessToken()).resolves.toBe("fake-access-1");
    vi.setSystemTime(Date.now() + 2 * 60_000);
    await expect(provider.getAccessToken()).resolves.toBe("fake-access-2");
    expect(calls).toHaveLength(2);
  });

  it("deletes the session when Microsoft rejects the refresh token", async () => {
    const { provider, entries, logger } = await signedIn({
      status: 400,
      body: {
        error: "invalid_grant",
        error_description: "AADSTS700082: secret-description",
        error_codes: [700082],
        correlation_id: "12345678-1234-1234-1234-123456789012",
      },
    });
    const error = await provider.getAccessToken().catch((e: unknown) => e);
    expect(error).toBeInstanceOf(SignInError);
    expect(error).toMatchObject({ reason: "sign-in-expired" });
    expect(String(error)).not.toMatch(/AADSTS|secret-description/);
    expect(entries.size).toBe(0);
    expect(logger.warn).toHaveBeenCalledWith(
      "m365: token request failed: HTTP 400 error=invalid_grant codes=700082 correlation=12345678-1234-1234-1234-123456789012",
    );
  });

  it.each([
    [{ error: "invalid_grant", error_codes: [65001] }, { reason: "consent-required" }],
    [{ error: "interaction_required", error_codes: [53003] }, { reason: "blocked-by-policy" }],
    [{ error: "invalid_grant", error_codes: [53000] }, { reason: "blocked-by-policy" }],
    [{ error: "invalid_grant", error_codes: [530035] }, { reason: "blocked-by-policy" }],
    [{ error: "invalid_grant", error_codes: [50076] }, { reason: "blocked-by-policy" }],
    [{ error: "interaction_required", error_codes: [50079] }, { reason: "blocked-by-policy" }],
    [
      { error: "invalid_client", error_codes: [7000218] },
      { message: expect.stringContaining("app registration") as unknown },
    ],
    [
      { error: "invalid_request", error_codes: [9002327] },
      { message: expect.stringContaining("app registration") as unknown },
    ],
    [
      { error: "temporarily_unavailable" },
      { message: expect.stringContaining("HTTP 400") as unknown },
    ],
  ])("maps token error %j and keeps the session", async (body, expected) => {
    const { provider, entries } = await signedIn({
      status: 400,
      body: { ...body, error_description: "secret-description" },
    });
    const error = await provider.getAccessToken().catch((e: unknown) => e);
    expect(error).toMatchObject(expected);
    expect(String(error)).not.toContain("secret-description");
    expect(entries.size).toBe(1);
  });

  it("reads as signed out after the tenant changes", async () => {
    const first = fakeApi();
    stubTokenEndpoint({ body: tokens() });
    await signIn(first.api);

    const changed = fakeApi(first.entries);
    const other = resolveAccount({ tenantId: OID, clientId: CLIENT }) as Account;
    await expect(currentSignIn(changed.api, other)).resolves.toBeUndefined();
    await expect(tokenProvider(changed.api, other).getAccessToken()).rejects.toMatchObject({
      reason: "not-signed-in",
    });
  });

  it("does not store a refresh that finishes after sign-out", async () => {
    const { api, provider, entries } = await signedIn({
      body: tokens({ refresh_token: "fake-refresh-2" }),
    });
    const pending = provider.getAccessToken();
    await signOut(api);
    await pending;
    expect(entries.size).toBe(0);
  });

  it("does not cache a refreshed token when sign-out happens during the write", async () => {
    const { api, provider, entries, store } = await signedIn({
      body: tokens({ access_token: "fake-access-2" }),
    });
    store.register.mockImplementationOnce(async (key, value) => {
      entries.set(key, structuredClone(value));
      await signOut(api);
    });
    await provider.getAccessToken();
    expect(entries.size).toBe(0);
    await expect(provider.getAccessToken()).rejects.toMatchObject({ reason: "not-signed-in" });
  });

  /** Holds the refresh answer back until `release` is called. */
  function holdRefresh(refreshBody: { status: number; body: unknown }) {
    let release = () => {};
    const held = new Promise<void>((resolve) => (release = resolve));
    const answers = [
      { body: tokens() },
      { ...refreshBody, held },
      { body: tokens({ access_token: "fake-access-3", refresh_token: "fake-refresh-3" }) },
    ];
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        const next = answers.shift();
        if (!next) throw new Error("unexpected request");
        if ("held" in next) await next.held;
        return new Response(JSON.stringify(next.body), {
          status: "status" in next ? next.status : 200,
        });
      }),
    );
    return () => release();
  }

  it("does not give a token to a caller who arrives after sign-out", async () => {
    const fake = fakeApi();
    const release = holdRefresh({ status: 200, body: tokens({ access_token: "fake-access-2" }) });
    await signIn(fake.api);
    const provider = tokenProvider(fake.api, ACCOUNT);
    provider.invalidate();

    const pending = provider.getAccessToken();
    await vi.waitFor(() => expect(fetch).toHaveBeenCalledTimes(2));
    await signOut(fake.api);
    const after = provider.getAccessToken();
    release();
    await expect(after).rejects.toMatchObject({ reason: "not-signed-in" });
    await pending;
    expect(fake.entries.size).toBe(0);
  });

  it("does not delete a newer sign-in when an older refresh is rejected", async () => {
    const fake = fakeApi();
    const release = holdRefresh({ status: 400, body: { error: "invalid_grant" } });
    await signIn(fake.api);
    const provider = tokenProvider(fake.api, ACCOUNT);
    provider.invalidate();

    const pending = provider.getAccessToken().catch((e: unknown) => e);
    await vi.waitFor(() => expect(fetch).toHaveBeenCalledTimes(2));
    await signOut(fake.api);
    await signIn(fake.api);
    release();
    await expect(pending).resolves.toMatchObject({ reason: "sign-in-expired" });
    expect(fake.entries.get("current")).toMatchObject({ refreshToken: "fake-refresh-3" });
  });

  it("keeps a new sign-in when an older refresh is rejected during its write", async () => {
    const fake = fakeApi();
    const release = holdRefresh({ status: 400, body: { error: "invalid_grant" } });
    await signIn(fake.api);
    const provider = tokenProvider(fake.api, ACCOUNT);
    provider.invalidate();

    const pending = provider.getAccessToken().catch((e: unknown) => e);
    await vi.waitFor(() => expect(fetch).toHaveBeenCalledTimes(2));
    // Like the host's store, writes run in order: a delete issued during the write runs after it.
    let deleting = () => {};
    const deleteCalled = new Promise<void>((resolve) => (deleting = resolve));
    let written = Promise.resolve();
    fake.store.register.mockImplementationOnce((key, value) => {
      release();
      written = Promise.race([pending, deleteCalled]).then(
        () => void fake.entries.set(key, structuredClone(value)),
      );
      return written;
    });
    fake.store.delete.mockImplementationOnce(async (key) => {
      deleting();
      await written;
      return fake.entries.delete(key);
    });

    await signIn(fake.api);
    await expect(pending).resolves.toMatchObject({ reason: "sign-in-expired" });
    expect(fake.entries.get("current")).toMatchObject({ refreshToken: "fake-refresh-3" });
    await expect(provider.getAccessToken()).resolves.toBe("fake-access-3");
  });

  it("deletes nothing on sign-out when the host withdraws the call's authority", async () => {
    const { api, entries } = await signedIn();
    const assertCurrent = () => {
      throw new Error("authority changed");
    };
    await expect(signOut(api, assertCurrent)).rejects.toThrow("authority changed");
    expect(entries.size).toBe(1);
  });
});
