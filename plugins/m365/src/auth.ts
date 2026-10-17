import { createHash, randomBytes } from "node:crypto";
import type { OpenClawPluginApi } from "openclaw/plugin-sdk/plugin-entry";
import { asOptionalRecord, truncateUtf16Safe } from "openclaw/plugin-sdk/string-coerce-runtime";
import type { Account } from "./config.js";
import type { TokenProvider } from "./graph.js";
import { requestJson } from "./http.js";

export const REDIRECT_URI = "http://localhost/openclaw-m365";
const LOGIN_HOST = "login.microsoftonline.com";
const SCOPES = "openid profile offline_access https://graph.microsoft.com/User.Read";
const OIDC_SCOPES = new Set(["openid", "profile", "offline_access", "email"]);
export const SIGN_IN_TTL_MS = 10 * 60_000;
const REFRESH_MARGIN_MS = 5 * 60_000;
// Microsoft expires refresh tokens after 90 days without use.
const SESSION_TTL_MS = 90 * 86_400_000;
const SESSION_KEY = "current";

const NOT_SIGNED_IN =
  "Not signed in to Microsoft 365. The owner can sign in with justimpactgroup_m365_sign_in";
const START_AGAIN = "Start again with justimpactgroup_m365_sign_in";

/** Why there is no working connection. The status tool reports these instead of failing. */
export const SIGN_IN_PROBLEMS = [
  "not-signed-in",
  "sign-in-expired",
  "consent-required",
  "blocked-by-policy",
] as const;
type SignInProblem = (typeof SIGN_IN_PROBLEMS)[number];

export class SignInError extends Error {
  readonly reason: SignInProblem;

  constructor(reason: SignInProblem, message: string) {
    super(message);
    this.name = "SignInError";
    this.reason = reason;
  }
}

type StoredSession = {
  v: 1;
  account: string;
  oid: string;
  refreshToken: string;
  scopes: string[];
};

function openSessionStore(api: OpenClawPluginApi) {
  return api.runtime.state.openKeyedStore<StoredSession>({
    namespace: "session",
    maxEntries: 1,
    overflowPolicy: "reject-new",
  });
}

type AuthState = {
  store: ReturnType<typeof openSessionStore>;
  /** The PKCE verifier stays in memory and is never stored. */
  signIn?: { verifier: string; state: string; expiresAt: number };
  accessToken?: { value: string; expiresAt: number };
  refreshing?: Promise<string>;
  /** Changes on sign-in and sign-out, so a refresh that started earlier does not write back. */
  generation: number;
};

// One state per plugin registration: a config change registers the plugin again with a new api.
const states = new WeakMap<OpenClawPluginApi, AuthState>();

function stateFor(api: OpenClawPluginApi): AuthState {
  let state = states.get(api);
  if (!state) {
    state = { store: openSessionStore(api), generation: 0 };
    states.set(api, state);
  }
  return state;
}

/** RFC 7636 S256 code challenge. */
export function pkceChallenge(verifier: string): string {
  return createHash("sha256").update(verifier).digest("base64url");
}

/** Starts a sign-in and returns the Microsoft address the user opens. Replaces any earlier one. */
export function startSignIn(api: OpenClawPluginApi, account: Account): string {
  const verifier = randomBytes(32).toString("base64url");
  const state = randomBytes(16).toString("base64url");
  stateFor(api).signIn = { verifier, state, expiresAt: Date.now() + SIGN_IN_TTL_MS };
  const query = new URLSearchParams({
    client_id: account.clientId,
    response_type: "code",
    redirect_uri: REDIRECT_URI,
    response_mode: "query",
    scope: SCOPES,
    state,
    code_challenge: pkceChallenge(verifier),
    code_challenge_method: "S256",
    prompt: "select_account",
  });
  return `https://${LOGIN_HOST}/${account.tenantId}/oauth2/v2.0/authorize?${query.toString()}`;
}

const NEEDS_CONSENT =
  "The app lacks consent for its permissions: an admin must grant it in Microsoft Entra";

const AUTHORIZE_ERRORS = new Map([
  ["access_denied", "The Microsoft sign-in was cancelled or denied"],
  ["consent_required", NEEDS_CONSENT],
  ["interaction_required", `Microsoft needs more input to sign in. ${START_AGAIN}`],
]);

/** The pending sign-in is used up even if this fails. Another signed-in account is refused. */
export async function completeSignIn(
  api: OpenClawPluginApi,
  account: Account,
  redirectUrl: string,
  signal?: AbortSignal,
  assertCurrent?: () => void,
): Promise<{ username: string; scopes: string[] }> {
  const state = stateFor(api);
  const signIn = state.signIn;
  if (!signIn || Date.now() > signIn.expiresAt) {
    throw inputError(`No Microsoft 365 sign-in is in progress, or it expired. ${START_AGAIN}`);
  }
  const url = URL.parse(redirectUrl);
  if (!url || url.origin + url.pathname !== REDIRECT_URI) {
    throw inputError(`Paste the full address that starts with ${REDIRECT_URI}`);
  }
  state.signIn = undefined;

  const error = url.searchParams.get("error");
  if (error !== null) {
    throw inputError(
      AUTHORIZE_ERRORS.get(error) ?? `Microsoft reported a sign-in error. ${START_AGAIN}`,
    );
  }
  const code = url.searchParams.get("code");
  if (url.searchParams.get("state") !== signIn.state || !code) {
    throw inputError(`The address does not belong to the current sign-in. ${START_AGAIN}`);
  }

  let tokens: TokenSet;
  try {
    tokens = await tokenRequest(
      api,
      account,
      {
        grant_type: "authorization_code",
        code,
        redirect_uri: REDIRECT_URI,
        code_verifier: signIn.verifier,
      },
      signal,
    );
  } catch (error) {
    if (!(error instanceof SignInError)) throw error;
    throw inputError(
      error.reason === "sign-in-expired"
        ? `Microsoft did not accept the sign-in code. It works once, for about a minute. ${START_AGAIN}`
        : error.message,
    );
  }
  if (!tokens.refreshToken || !tokens.idToken) throw invalidResponse();
  const claims = idTokenClaims(tokens.idToken);
  if (claims.tid !== account.tenantId || claims.aud !== account.clientId) {
    throw inputError(
      "The sign-in came from a different tenant or app than the plugin config names",
    );
  }
  const existing = await loadSession(state, account);
  if (existing && existing.oid !== claims.oid) {
    throw inputError(
      "Another Microsoft account is signed in. Sign out first with justimpactgroup_m365_sign_out",
    );
  }

  const session: StoredSession = {
    v: 1,
    account: account.key,
    oid: claims.oid,
    refreshToken: tokens.refreshToken,
    scopes: tokens.scopes,
  };
  // Before the write, so a refresh that started earlier neither deletes nor overwrites this session.
  const generation = ++state.generation;
  state.refreshing = undefined;
  await state.store.register(SESSION_KEY, session, { ttlMs: SESSION_TTL_MS, assertCurrent });
  if (state.generation === generation) {
    state.accessToken = { value: tokens.accessToken, expiresAt: tokens.expiresAt };
  }
  return { username: claims.username, scopes: session.scopes };
}

/** Deletes the stored session and cached tokens. Access is not revoked at Microsoft. */
export async function signOut(api: OpenClawPluginApi, assertCurrent?: () => void): Promise<void> {
  const state = stateFor(api);
  state.generation += 1;
  state.signIn = undefined;
  state.accessToken = undefined;
  state.refreshing = undefined;
  await state.store.delete(SESSION_KEY, { assertCurrent });
}

/** The scopes of the signed-in account, or undefined when nobody is signed in. */
export async function signedInScopes(
  api: OpenClawPluginApi,
  account: Account,
): Promise<string[] | undefined> {
  return (await loadSession(stateFor(api), account))?.scopes;
}

export function tokenProvider(api: OpenClawPluginApi, account: Account): TokenProvider {
  return {
    getAccessToken: (signal) => getAccessToken(api, account, signal),
    invalidate: () => {
      stateFor(api).accessToken = undefined;
    },
  };
}

async function getAccessToken(
  api: OpenClawPluginApi,
  account: Account,
  signal?: AbortSignal,
): Promise<string> {
  signal?.throwIfAborted();
  const state = stateFor(api);
  const cached = state.accessToken;
  if (cached && cached.expiresAt - Date.now() > REFRESH_MARGIN_MS) return cached.value;
  // One refresh at a time, not tied to any caller's signal, so the rotated token is always stored.
  // Sign-out drops it, so later callers start a new one instead of joining it.
  if (!state.refreshing) {
    const refreshing: Promise<string> = refresh(api, account, state).finally(() => {
      if (state.refreshing === refreshing) state.refreshing = undefined;
    });
    state.refreshing = refreshing;
  }
  return await untilAborted(state.refreshing, signal);
}

async function refresh(
  api: OpenClawPluginApi,
  account: Account,
  state: AuthState,
): Promise<string> {
  const generation = state.generation;
  const session = await loadSession(state, account);
  if (!session) throw new SignInError("not-signed-in", NOT_SIGNED_IN);

  let tokens: TokenSet;
  try {
    tokens = await tokenRequest(api, account, {
      grant_type: "refresh_token",
      refresh_token: session.refreshToken,
    });
  } catch (error) {
    if (
      error instanceof SignInError &&
      error.reason === "sign-in-expired" &&
      state.generation === generation
    ) {
      state.accessToken = undefined;
      await state.store.delete(SESSION_KEY);
    }
    throw error;
  }
  if (state.generation !== generation) return tokens.accessToken;

  // Microsoft may omit the new refresh token; the old one then stays valid.
  const refreshToken = tokens.refreshToken ?? session.refreshToken;
  const updated: StoredSession = { ...session, refreshToken, scopes: tokens.scopes };
  await state.store.register(SESSION_KEY, updated, { ttlMs: SESSION_TTL_MS });
  if (state.generation === generation) {
    state.accessToken = { value: tokens.accessToken, expiresAt: tokens.expiresAt };
  }
  return tokens.accessToken;
}

function untilAborted<T>(promise: Promise<T>, signal: AbortSignal | undefined): Promise<T> {
  if (!signal) return promise;
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => reject(signal.reason as Error);
    signal.addEventListener("abort", onAbort, { once: true });
    void promise.then(resolve, reject).finally(() => signal.removeEventListener("abort", onAbort));
  });
}

async function loadSession(state: AuthState, account: Account): Promise<StoredSession | undefined> {
  const value = asOptionalRecord(await state.store.lookup(SESSION_KEY));
  const valid =
    value?.v === 1 &&
    value.account === account.key &&
    typeof value.oid === "string" &&
    typeof value.refreshToken === "string" &&
    Array.isArray(value.scopes) &&
    value.scopes.every((scope) => typeof scope === "string");
  return valid ? (value as StoredSession) : undefined;
}

type TokenSet = {
  accessToken: string;
  expiresAt: number;
  scopes: string[];
  refreshToken?: string;
  idToken?: string;
};

async function tokenRequest(
  api: OpenClawPluginApi,
  account: Account,
  grant: Record<string, string>,
  signal?: AbortSignal,
): Promise<TokenSet> {
  const { status, json } = await requestJson({
    url: new URL(`https://${LOGIN_HOST}/${account.tenantId}/oauth2/v2.0/token`),
    host: LOGIN_HOST,
    init: {
      method: "POST",
      headers: {
        "content-type": "application/x-www-form-urlencoded",
        accept: "application/json",
      },
      body: new URLSearchParams({
        client_id: account.clientId,
        scope: SCOPES,
        ...grant,
      }).toString(),
    },
    signal,
    maxBytes: 64 * 1024,
    auditContext: "m365.token",
    capture: false,
  });
  if (status !== 200) throw tokenError(api, status, json);
  return parseTokens(json);
}

function parseTokens(json: unknown): TokenSet {
  const body = asOptionalRecord(json) ?? {};
  const { token_type, access_token, refresh_token, id_token, scope } = body;
  const expiresIn = Number(body.expires_in);
  if (
    typeof token_type !== "string" ||
    token_type.toLowerCase() !== "bearer" ||
    !isFilled(access_token) ||
    !Number.isFinite(expiresIn) ||
    (scope !== undefined && typeof scope !== "string")
  ) {
    throw invalidResponse();
  }
  return {
    accessToken: access_token,
    expiresAt: Date.now() + expiresIn * 1000,
    // Microsoft may omit the scope when it is the one requested.
    scopes: graphScopes(scope ?? SCOPES),
    refreshToken: isFilled(refresh_token) ? refresh_token : undefined,
    idToken: isFilled(id_token) ? id_token : undefined,
  };
}

/** Graph scopes without the resource prefix, for display; OpenID scopes are left out. */
function graphScopes(scope: string): string[] {
  return scope
    .split(" ")
    .map((name) => name.replace(/^https:\/\/graph\.microsoft\.com\//i, ""))
    .filter((name) => /^[A-Za-z0-9._-]{1,64}$/.test(name) && !OIDC_SCOPES.has(name.toLowerCase()))
    .slice(0, 50);
}

/** Reads the id_token's claims. It came straight from Microsoft over TLS, so the signature is not checked. */
function idTokenClaims(idToken: string): {
  tid: string;
  aud: string;
  oid: string;
  username: string;
} {
  let claims: Record<string, unknown> = {};
  try {
    const payload = Buffer.from(idToken.split(".")[1] ?? "", "base64url").toString("utf8");
    claims = asOptionalRecord(JSON.parse(payload)) ?? {};
  } catch {
    // Rejected below.
  }
  const { tid, aud, oid, preferred_username } = claims;
  if (typeof tid !== "string" || typeof aud !== "string" || !isFilled(oid) || oid.length > 64) {
    throw invalidResponse();
  }
  return {
    tid: tid.toLowerCase(),
    aud: aud.toLowerCase(),
    oid,
    // preferred_username is a display name for the sign-in, not necessarily the UPN.
    username:
      typeof preferred_username === "string" ? truncateUtf16Safe(preferred_username, 256) : "",
  };
}

const EXPIRED_CODES = [700082, 70043, 50173];
const CONSENT_CODES = [65001, 90094, 65004];
// 50076 and 50079 (MFA required) keep the session: Conditional Access checks the Gateway's IP on
// every refresh, so signing in again from a trusted location would not fix it.
const POLICY_CODES = [53000, 53001, 53002, 53003, 53004, 530032, 530035, 50076, 50079];
const APP_REGISTRATION_CODES = [7000218, 700016, 50011, 50194, 9002327];

/** Maps a token endpoint error. Only `error`, the AADSTS numbers and the correlation id are logged. */
function tokenError(api: OpenClawPluginApi, status: number, json: unknown): Error {
  const body = asOptionalRecord(json) ?? {};
  const error =
    typeof body.error === "string" && /^[a-z_]{1,64}$/.test(body.error) ? body.error : "";
  const codes = Array.isArray(body.error_codes)
    ? body.error_codes.filter((code): code is number => Number.isSafeInteger(code)).slice(0, 10)
    : [];
  const correlationId =
    typeof body.correlation_id === "string" && /^[0-9a-f-]{1,64}$/i.test(body.correlation_id)
      ? body.correlation_id
      : "";
  api.logger.warn(
    `m365: token request failed: HTTP ${status} error=${error} codes=${codes.join(",")} correlation=${correlationId}`,
  );

  const has = (list: number[]) => codes.some((code) => list.includes(code));
  if (has(CONSENT_CODES)) {
    return new SignInError("consent-required", NEEDS_CONSENT);
  }
  if (has(POLICY_CODES)) {
    return new SignInError(
      "blocked-by-policy",
      "A Conditional Access or MFA policy blocked the Microsoft 365 sign-in",
    );
  }
  if (error === "invalid_client" || has(APP_REGISTRATION_CODES)) {
    return inputError(
      "Microsoft rejected the app registration: check it against the plugin README",
    );
  }
  if (has(EXPIRED_CODES) || error === "invalid_grant" || error === "interaction_required") {
    return new SignInError(
      "sign-in-expired",
      "The Microsoft 365 sign-in expired or was revoked. The owner must sign in again with justimpactgroup_m365_sign_in",
    );
  }
  if (status === 429 || status >= 500) {
    return new Error(`Microsoft sign-in is unavailable (HTTP ${status}). Try again later`);
  }
  return new Error(`Microsoft sign-in failed with HTTP ${status}`);
}

function invalidResponse(): Error {
  return new Error("Microsoft sign-in returned an unexpected response");
}

/** /tools/invoke returns the message of an error with this name; others become a bare HTTP 500. */
export function inputError(message: string): Error {
  const error = new Error(message);
  error.name = "ToolInputError";
  return error;
}

function isFilled(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
}
