/**
 * Claude Pro/Max OAuth (Claude Code public-client PKCE).
 *
 * Verified 2026-08 live probes:
 *   POST https://console.anthropic.com/v1/oauth/token  → 404 Not found (DEAD)
 *   POST https://platform.claude.com/v1/oauth/token    → 400 invalid_grant on
 *        dummy code (endpoint EXISTS — use this)
 *   POST https://api.anthropic.com/v1/oauth/token      → same as platform
 *
 * authorize: https://claude.ai/oauth/authorize?code=true&...
 * redirect:  https://console.anthropic.com/oauth/code/callback
 * client_id: 9d1c250a-e61b-44d9-88ed-5944d1962f5e  (no client_secret — public PKCE)
 *
 * state MUST be independent of code_verifier (not the same string).
 */

export const CLAUDE_OAUTH_CLIENT_ID = "9d1c250a-e61b-44d9-88ed-5944d1962f5e";

export const CLAUDE_OAUTH_AUTHORIZE_URL = "https://claude.ai/oauth/authorize";

/** Live token endpoint (console …/v1/oauth/token returns 404). */
export const CLAUDE_OAUTH_TOKEN_URL =
  "https://platform.claude.com/v1/oauth/token";

const CLAUDE_OAUTH_TOKEN_URL_FALLBACK =
  "https://api.anthropic.com/v1/oauth/token";

export const CLAUDE_OAUTH_REDIRECT_URI =
  "https://console.anthropic.com/oauth/code/callback";

export const CLAUDE_OAUTH_SCOPES =
  "org:create_api_key user:profile user:inference";

export type ClaudeOAuthPendingSession = {
  codeVerifier: string;
  state: string;
  createdAt: number;
};

export type ClaudeOAuthTokenResult = {
  accessToken: string;
  refreshToken?: string;
  expiresIn?: number;
  expiresAtMs: number;
};

function base64UrlFromBytes(bytes: Uint8Array): string {
  let binary = "";
  for (let i = 0; i < bytes.length; i++) {
    binary += String.fromCharCode(bytes[i]!);
  }
  return btoa(binary)
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/g, "");
}

export function generateCodeVerifier(): string {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  return base64UrlFromBytes(bytes);
}

/** Independent OAuth state (must NOT equal code_verifier). */
export function generateOAuthState(): string {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  return base64UrlFromBytes(bytes);
}

export async function codeChallengeS256(verifier: string): Promise<string> {
  const data = new TextEncoder().encode(verifier);
  const digest = await crypto.subtle.digest("SHA-256", data);
  return base64UrlFromBytes(new Uint8Array(digest));
}

export async function createClaudeOAuthPendingSession(): Promise<{
  session: ClaudeOAuthPendingSession;
  authUrl: string;
}> {
  const codeVerifier = generateCodeVerifier();
  // Independent from verifier — required for valid OAuth / CSRF
  const state = generateOAuthState();
  const challenge = await codeChallengeS256(codeVerifier);
  const session: ClaudeOAuthPendingSession = {
    codeVerifier,
    state,
    createdAt: Date.now()
  };
  const u = new URL(CLAUDE_OAUTH_AUTHORIZE_URL);
  u.searchParams.set("code", "true");
  u.searchParams.set("client_id", CLAUDE_OAUTH_CLIENT_ID);
  u.searchParams.set("response_type", "code");
  u.searchParams.set("redirect_uri", CLAUDE_OAUTH_REDIRECT_URI);
  u.searchParams.set("scope", CLAUDE_OAUTH_SCOPES);
  u.searchParams.set("code_challenge", challenge);
  u.searchParams.set("code_challenge_method", "S256");
  u.searchParams.set("state", state);
  return { session, authUrl: u.toString() };
}

export function parseAuthorizationCodePaste(raw: string): {
  code: string;
  state?: string;
} {
  const t = raw.trim().replace(/\s+/g, "");
  if (!t) return { code: "" };
  if (t.includes("#")) {
    const i = t.indexOf("#");
    return {
      code: t.slice(0, i),
      state: t.slice(i + 1) || undefined
    };
  }
  if (t.includes("code=")) {
    try {
      const q = t.startsWith("http")
        ? new URL(t)
        : new URL(`https://x/?${t.replace(/^\?/, "")}`);
      return {
        code: q.searchParams.get("code")?.trim() ?? "",
        state: q.searchParams.get("state")?.trim() || undefined
      };
    } catch {
      /* fall through */
    }
  }
  return { code: t };
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

type ExchangeFail = { status: number; message: string };

async function postJsonToken(
  tokenUrl: string,
  body: Record<string, string>
): Promise<ClaudeOAuthTokenResult | ExchangeFail> {
  const res = await fetch(tokenUrl, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      accept: "application/json",
      "user-agent": "claude-cli/1.0.0 (external, cli)"
    },
    body: JSON.stringify(body)
  });
  const text = await res.text();
  let json: Record<string, unknown> = {};
  try {
    json = JSON.parse(text) as Record<string, unknown>;
  } catch {
    return {
      status: res.status,
      message: `Non-JSON (${res.status}): ${text.slice(0, 160)}`
    };
  }

  // OAuth error shape: { error, error_description }
  // Anthropic API shape: { type, error: { type, message } }
  if (!res.ok) {
    const nested =
      json.error && typeof json.error === "object"
        ? (json.error as Record<string, unknown>)
        : null;
    const msg =
      (typeof json.error_description === "string" && json.error_description) ||
      (nested && typeof nested.message === "string" && nested.message) ||
      (typeof json.error === "string" && json.error) ||
      text.slice(0, 160);
    return { status: res.status, message: String(msg) };
  }

  const accessToken =
    typeof json.access_token === "string" ? json.access_token : "";
  if (!accessToken) {
    return { status: res.status, message: "No access_token in response" };
  }
  const expiresIn =
    typeof json.expires_in === "number" ? json.expires_in : 3600;
  return {
    accessToken,
    refreshToken:
      typeof json.refresh_token === "string" ? json.refresh_token : undefined,
    expiresIn,
    expiresAtMs: Date.now() + Math.max(60, expiresIn) * 1000
  };
}

/**
 * Exchange CODE#STATE for tokens.
 * Uses platform.claude.com (live). Does not use dead console …/v1/oauth/token.
 * No client_secret — Claude Code client is public PKCE.
 */
export async function exchangeClaudeOAuthCode(params: {
  code: string;
  codeVerifier: string;
  state?: string;
  rawPaste?: string;
}): Promise<ClaudeOAuthTokenResult> {
  const cleaned = (params.rawPaste || params.code).replace(/\s+/g, "").trim();
  const parsed = parseAuthorizationCodePaste(cleaned);
  const code = parsed.code;
  // Prefer explicit state from session; paste #half is CSRF echo only
  const state = params.state || parsed.state || "";

  if (!code) throw new Error("Empty authorization code.");
  if (!params.codeVerifier || params.codeVerifier.length < 20) {
    throw new Error(
      "Missing PKCE code_verifier — click Authorize again on this dashboard first."
    );
  }

  const body: Record<string, string> = {
    grant_type: "authorization_code",
    code,
    client_id: CLAUDE_OAUTH_CLIENT_ID,
    redirect_uri: CLAUDE_OAUTH_REDIRECT_URI,
    code_verifier: params.codeVerifier
  };
  if (state) body.state = state;

  const urls = [CLAUDE_OAUTH_TOKEN_URL, CLAUDE_OAUTH_TOKEN_URL_FALLBACK];

  let last: ExchangeFail = { status: 0, message: "no attempt" };

  for (const url of urls) {
    let result = await postJsonToken(url, body);
    if ("accessToken" in result) return result;
    last = result;

    // 404 = wrong path; try next host
    if (result.status === 404) continue;

    // One delayed retry on rate limit only
    if (result.status === 429) {
      await sleep(5000);
      result = await postJsonToken(url, body);
      if ("accessToken" in result) return result;
      last = result;
      break;
    }

    // invalid_grant on this host — don't spam alternates/hosts
    if (
      result.status === 400 &&
      /invalid.?grant|invalid.?code|Invalid 'code'/i.test(result.message)
    ) {
      // Try full CODE#STATE as code once (some UI variants)
      if (cleaned.includes("#") && body.code !== cleaned) {
        const alt = await postJsonToken(url, { ...body, code: cleaned });
        if ("accessToken" in alt) return alt;
        last = alt as ExchangeFail;
      }
      break;
    }
  }

  throw new Error(`Token exchange failed (${last.status}): ${last.message}`);
}

export async function refreshClaudeOAuthToken(
  refreshToken: string
): Promise<ClaudeOAuthTokenResult> {
  const body = {
    grant_type: "refresh_token",
    refresh_token: refreshToken,
    client_id: CLAUDE_OAUTH_CLIENT_ID
  };
  for (const url of [CLAUDE_OAUTH_TOKEN_URL, CLAUDE_OAUTH_TOKEN_URL_FALLBACK]) {
    const result = await postJsonToken(url, body);
    if ("accessToken" in result) return result;
    if (result.status === 404) continue;
    throw new Error(`Refresh failed (${result.status}): ${result.message}`);
  }
  throw new Error("Refresh failed: token endpoint not found");
}
