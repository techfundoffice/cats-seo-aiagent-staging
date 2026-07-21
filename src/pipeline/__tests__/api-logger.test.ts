import { afterEach, describe, expect, it, vi } from "vitest";
import type { SEOArticleAgent } from "../../server";
import { loggedFetch } from "../api-logger";

type LogEntry = { level: string; msg: string; role?: string };

const originalFetch = globalThis.fetch;

function makeFakeAgent(): { agent: SEOArticleAgent; logs: LogEntry[] } {
  const logs: LogEntry[] = [];
  const agent = {
    log: (level: string, msg: string, role?: string) => {
      logs.push({ level, msg, role });
    }
  };
  return { agent: agent as unknown as SEOArticleAgent, logs };
}

afterEach(() => {
  (globalThis as { fetch: typeof fetch }).fetch = originalFetch;
  vi.restoreAllMocks();
});

describe("loggedFetch", () => {
  it("redacts nested OAuth-style secrets and omits fragments from logged URLs", async () => {
    const { agent, logs } = makeFakeAgent();
    (globalThis as { fetch: typeof fetch }).fetch = vi
      .fn<typeof fetch>()
      .mockResolvedValue(new Response("ok", { status: 200 }));

    await loggedFetch(
      agent,
      "https://api.example.com/callback?oauth.accessToken=secret123&state=ok#access_token=fragment-secret",
      undefined,
      { api: "GitHub", op: "oauth" }
    );

    expect(logs).toHaveLength(1);
    expect(logs[0]).toMatchObject({ level: "info", role: "apiCall" });
    expect(logs[0].msg).toContain(
      "[GitHub] oauth GET api.example.com/callback?"
    );
    expect(logs[0].msg).toContain("oauth.accessToken=%5BREDACTED%5D");
    expect(logs[0].msg).toContain("state=ok");
    expect(logs[0].msg).not.toContain("#");
    expect(logs[0].msg).not.toContain("secret123");
    expect(logs[0].msg).not.toContain("fragment-secret");
  });

  it("redacts plain code only when the query shape looks OAuth-like", async () => {
    const { agent, logs } = makeFakeAgent();
    (globalThis as { fetch: typeof fetch }).fetch = vi
      .fn<typeof fetch>()
      .mockResolvedValue(new Response("ok", { status: 200 }));

    await loggedFetch(
      agent,
      "https://api.example.com/callback?code=oauth-secret&client_id=cat-app&state=ok",
      undefined,
      { api: "GitHub" }
    );
    await loggedFetch(
      agent,
      "https://api.example.com/search?code=SAVE10&coupon=spring",
      undefined,
      { api: "GitHub" }
    );

    expect(logs[0].msg).toContain("code=%5BREDACTED%5D");
    expect(logs[0].msg).toContain("client_id=%5BREDACTED%5D");
    expect(logs[0].msg).not.toContain("oauth-secret");

    expect(logs[1].msg).toContain("code=SAVE10");
    expect(logs[1].msg).toContain("coupon=spring");
  });

  it("redacts sensitive fields from 4xx response body excerpts", async () => {
    const { agent, logs } = makeFakeAgent();
    (globalThis as { fetch: typeof fetch }).fetch = vi
      .fn<typeof fetch>()
      .mockResolvedValue(
        new Response(
          JSON.stringify({
            message: "bad credentials",
            access_token: "token-123",
            nested: { client_secret: "secret-456" },
            coupon: "SPRING10"
          }),
          { status: 401, statusText: "Unauthorized" }
        )
      );

    await loggedFetch(
      agent,
      "https://api.example.com/oauth/callback",
      undefined,
      { api: "GitHub" }
    );

    expect(logs).toHaveLength(1);
    expect(logs[0].msg).toContain("401");
    expect(logs[0].msg).toContain("body=");
    expect(logs[0].msg).toContain('"access_token":"[REDACTED]"');
    expect(logs[0].msg).toContain('"client_secret":"[REDACTED]"');
    expect(logs[0].msg).toContain('"coupon":"SPRING10"');
    expect(logs[0].msg).not.toContain("token-123");
    expect(logs[0].msg).not.toContain("secret-456");
  });

  it("redacts sensitive key=value fields in non-JSON body excerpts", async () => {
    const { agent, logs } = makeFakeAgent();
    (globalThis as { fetch: typeof fetch }).fetch = vi
      .fn<typeof fetch>()
      .mockResolvedValue(
        new Response(
          'error=invalid_grant access_token="secret 123" client_secret=secret-456',
          { status: 400, statusText: "Bad Request" }
        )
      );

    await loggedFetch(agent, "https://api.example.com/oauth/token", undefined, {
      api: "GitHub"
    });

    expect(logs).toHaveLength(1);
    expect(logs[0].msg).toContain("body=");
    expect(logs[0].msg).toContain("access_token=[REDACTED]");
    expect(logs[0].msg).toContain("client_secret=[REDACTED]");
    expect(logs[0].msg).toContain("error=invalid_grant");
    expect(logs[0].msg).not.toContain("secret 123");
    expect(logs[0].msg).not.toContain("secret-456");
  });
});
