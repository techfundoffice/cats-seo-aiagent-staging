import { describe, expect, it } from "vitest";
import {
  codeChallengeS256,
  createClaudeOAuthPendingSession,
  generateCodeVerifier,
  parseAuthorizationCodePaste
} from "../claude-oauth-flow";

describe("claude-oauth-flow PKCE", () => {
  it("generates 43-char base64url verifiers", () => {
    const v = generateCodeVerifier();
    expect(v.length).toBeGreaterThanOrEqual(40);
    expect(v).toMatch(/^[A-Za-z0-9_-]+$/);
  });

  it("builds authorize URL with community Claude Code params", async () => {
    const { session, authUrl } = await createClaudeOAuthPendingSession();
    const u = new URL(authUrl);
    expect(u.origin + u.pathname).toBe("https://claude.ai/oauth/authorize");
    expect(u.searchParams.get("code")).toBe("true");
    expect(u.searchParams.get("client_id")).toBe(
      "9d1c250a-e61b-44d9-88ed-5944d1962f5e"
    );
    expect(u.searchParams.get("response_type")).toBe("code");
    expect(u.searchParams.get("redirect_uri")).toBe(
      "https://console.anthropic.com/oauth/code/callback"
    );
    expect(u.searchParams.get("code_challenge_method")).toBe("S256");
    expect(u.searchParams.get("code_challenge")).toBeTruthy();
    // state must be independent of code_verifier
    expect(u.searchParams.get("state")).toBe(session.state);
    expect(session.state).not.toBe(session.codeVerifier);
    const challenge = await codeChallengeS256(session.codeVerifier);
    expect(u.searchParams.get("code_challenge")).toBe(challenge);
  });

  it("uses live platform token endpoint not dead console path", async () => {
    const { CLAUDE_OAUTH_TOKEN_URL } = await import("../claude-oauth-flow");
    expect(CLAUDE_OAUTH_TOKEN_URL).toContain("platform.claude.com");
    expect(CLAUDE_OAUTH_TOKEN_URL).not.toContain("console.anthropic.com");
  });

  it("parses CODE#STATE and query pastes", () => {
    expect(parseAuthorizationCodePaste("abc123#stateXYZ")).toEqual({
      code: "abc123",
      state: "stateXYZ"
    });
    expect(parseAuthorizationCodePaste("onlycode")).toEqual({
      code: "onlycode"
    });
    const q = parseAuthorizationCodePaste(
      "https://console.anthropic.com/oauth/code/callback?code=zz&state=ss"
    );
    expect(q.code).toBe("zz");
    expect(q.state).toBe("ss");
  });

  it("parses real-world Claude paste shape (two base64url chunks)", () => {
    const paste =
      "ZjWtui43PDlQ1AegvwQi8xOB189vvyufTQD2X0CuBMWgjhCF#nCiiv1A9BSJnl_gUBaL18Rx4d6joTm_l8v1hv1OUAcg";
    const p = parseAuthorizationCodePaste(paste);
    expect(p.code).toBe("ZjWtui43PDlQ1AegvwQi8xOB189vvyufTQD2X0CuBMWgjhCF");
    expect(p.state).toBe("nCiiv1A9BSJnl_gUBaL18Rx4d6joTm_l8v1hv1OUAcg");
  });
});
