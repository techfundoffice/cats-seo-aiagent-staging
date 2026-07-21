import { describe, expect, it } from "vitest";
import { isKimiCreditsExhausted, redactSecrets } from "../http-utils";

// Regression suite covering every pattern in redactSecrets. Each pattern
// has at least one positive ("secret is removed") + at least one
// adjacent-but-benign ("non-secret prose untouched") case to prevent
// future drift from silently widening the redactor.

describe("redactSecrets — positive matches", () => {
  it.each([
    [
      "Authorization Bearer",
      "Authorization: Bearer sk-ant-1234567890abcdefghij",
      "Authorization: Bearer [REDACTED]"
    ],
    [
      "Anthropic sk-ant-",
      "key: sk-ant-aaaaaaaaaaaaaaaaaaaa",
      "key: [REDACTED]"
    ],
    ["OpenAI sk-", "key: sk-1234567890abcdefghij", "key: [REDACTED]"],
    [
      "Composio ck_",
      "Composio: ck_G2_abcdefghijklmnopqrstuvwxyz123456",
      "Composio: [REDACTED]"
    ],
    [
      "AWS AKIA",
      "AWS_ACCESS_KEY_ID=AKIAIOSFODNN7EXAMPLE",
      "AWS_ACCESS_KEY_ID=[REDACTED]"
    ],
    [
      "GitHub PAT (ghp_)",
      "token=ghp_abcdefghijklmnopqrstuvwxyz1234567890",
      "token=[REDACTED]"
    ],
    [
      "GitHub fine-grained PAT",
      "github_pat_1Aabcdefghijklmnopqrstuv_aBcDeFgHiJkLmNoPqRsTuVwXyZ12345678901234",
      "[REDACTED]"
    ],
    [
      "Slack xoxb-",
      "Slack: xoxb-1234567890-abcdefghij-AbCdEfGhIjKlMnOpQrStUvWx",
      "Slack: [REDACTED]"
    ],
    [
      "Slack xoxp- legacy",
      "Slack legacy: xoxp-1234-1234-abcdefghij",
      "Slack legacy: [REDACTED]"
    ],
    [
      "Stripe sk_live_",
      "Stripe live: sk_live_abcdefghijklmnopqrstuvwx",
      "Stripe live: [REDACTED]"
    ],
    [
      "Stripe pk_test_",
      "Stripe test: pk_test_abcdefghijklmnopqrstuvwxyz",
      "Stripe test: [REDACTED]"
    ],
    [
      "Stripe whsec_",
      "Webhook: whsec_abcdefghijklmnopqrstuvwxyz12",
      "Webhook: [REDACTED]"
    ],
    [
      "OpenAI sess-",
      "OpenAI: sess-1234567890abcdefghijklmnopqr",
      "OpenAI: [REDACTED]"
    ],
    [
      "URL ?api_key=",
      "https://api.example.com/?api_key=mysecretvalue123&other=foo",
      "https://api.example.com/?api_key=[REDACTED]&other=foo"
    ],
    [
      "URL ?token=",
      "https://api.example.com/?token=abcdef123456",
      "https://api.example.com/?token=[REDACTED]"
    ],
    [
      "URL ?Signature= (signed URL)",
      "https://cdn.example.com/img?Signature=abcdef0123456789&Expires=1",
      "https://cdn.example.com/img?Signature=[REDACTED]&Expires=1"
    ],
    [
      "URL ?X-Amz-Signature=",
      "https://b.s3.amazonaws.com/k?X-Amz-Signature=abc123def456ghi789jkl&X-Amz-Expires=900",
      "https://b.s3.amazonaws.com/k?X-Amz-Signature=[REDACTED]&X-Amz-Expires=900"
    ],
    [
      "Cookie:",
      "Cookie: session=abcdefghijklmnopqrstuvwxyz1234567890",
      "Cookie: [REDACTED]"
    ],
    [
      "Set-Cookie:",
      "Set-Cookie: __Host-csrf=xyz; HttpOnly; Path=/",
      "Set-Cookie: [REDACTED]"
    ],
    [
      "X-Hub-Signature-256 (GitHub)",
      "X-Hub-Signature-256: sha256=abcdef1234567890abcdef1234567890abcdef12",
      "X-Hub-Signature-256: sha256=[REDACTED]"
    ],
    [
      "X-Webhook-Signature",
      "X-Webhook-Signature: sha512=fedcba0987654321fedcba0987654321fedcba09",
      "X-Webhook-Signature: sha512=[REDACTED]"
    ],
    [
      "JWT (3-segment)",
      "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dozjgNryP4J3jVmNHl0w5N_XgL0n3I9PlFUP0THsR8U",
      "[REDACTED]"
    ]
  ])("redacts %s", (_label, input, expected) => {
    expect(redactSecrets(input)).toBe(expected);
  });
});

describe("redactSecrets — non-secrets preserved", () => {
  it.each([
    "plain prose with no secrets",
    "the cookie expired in flight",
    "Authorization required but no token here",
    "GitHub user contributed via gh CLI",
    "https://example.com/path?foo=bar&baz=qux",
    "sess-XYZ_too_short", // 16 chars after prefix, below 20-char threshold
    "AKIA short", // not 16-char AKIA pattern
    "ck_short", // below threshold
    '{ "status": "ok", "items": [1,2,3] }'
  ])("leaves %s untouched", (input) => {
    expect(redactSecrets(input)).toBe(input);
  });
});

describe("redactSecrets — idempotency", () => {
  it.each([
    "Authorization: Bearer sk-ant-1234567890abcdefghij",
    "Cookie: session=abcdefghijklmnopqrstuvwxyz1234567890",
    "X-Hub-Signature-256: sha256=abcdef1234567890abcdef1234567890abcdef12",
    "Slack: xoxb-1234567890-abcdefghij-AbCdEfGhIjKlMnOpQrStUvWx",
    "Stripe live: sk_live_abcdefghijklmnopqrstuvwx",
    "JWT eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dozjgNryP4J3jVmNHl0w5N_XgL0n3I9PlFUP0THsR8U"
  ])("redact(redact(x)) === redact(x): %s", (input) => {
    const r1 = redactSecrets(input);
    const r2 = redactSecrets(r1);
    expect(r2).toBe(r1);
  });
});

describe("redactSecrets — mixed-content & multi-secret", () => {
  it("redacts every secret across multiple lines in one payload", () => {
    // One \n per secret so the Cookie regex (which is anchored to
    // newline boundaries on purpose — see comment in redactSecrets) only
    // eats its own line. Real log payloads from upstream HTTP errors
    // arrive this way.
    const input = [
      "Failed request:",
      "Authorization: Bearer sk-ant-abcdefghijklmnopqrst",
      "Cookie: session=abcdefghijklmnopqrstuvwxyz1234567890",
      "https://api.example.com/?api_key=mysecretvalue123",
      "JWT eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dozjgNryP4J3jVmNHl0w5N_XgL0n3I9PlFUP0THsR8U"
    ].join("\n");
    const out = redactSecrets(input);
    expect(out).not.toMatch(/sk-ant-[A-Za-z0-9]{20,}/);
    expect(out).not.toMatch(/session=[A-Za-z0-9]{20,}/);
    expect(out).not.toMatch(/api_key=[A-Za-z0-9]{6,}/);
    expect(out).not.toMatch(
      /\b[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/
    );
    // Each of 4 secrets produces its own [REDACTED] marker.
    expect((out.match(/\[REDACTED\]/g) ?? []).length).toBe(4);
  });

  it("Cookie regex over-redacts within its own line (safe default)", () => {
    // Documented behavior: the Cookie regex intentionally eats `[^\r\n]+`
    // — anything appearing after `Cookie:` on the same line is treated as
    // cookie body. This is the over-redaction we WANT (false-positive >
    // leak). If this changes, the threat model needs revisiting.
    const input =
      "Cookie: session=secret123 and other public stuff on same line";
    expect(redactSecrets(input)).toBe("Cookie: [REDACTED]");
  });

  it("redacts secrets inside JSON-stringified objects", () => {
    const obj = JSON.stringify({
      err: "auth",
      token: "sk-ant-1234567890abcdefghijabcd",
      headers: {
        Authorization: "Bearer ghp_abcdefghijklmnopqrstuvwxyz1234567890"
      }
    });
    const out = redactSecrets(obj);
    expect(out).not.toContain("sk-ant-1234567890");
    expect(out).not.toContain("ghp_abcdefghij");
    expect(out).toContain("[REDACTED]");
  });
});

describe("redactSecrets — input safety", () => {
  it("handles non-string input by returning it unchanged", () => {
    // The TypeScript signature blocks this at compile time; this asserts
    // runtime resilience for callers that bypass type checks.
    expect(redactSecrets(undefined as unknown as string)).toBe(undefined);
    expect(redactSecrets(null as unknown as string)).toBe(null);
    expect(redactSecrets(42 as unknown as string)).toBe(42);
    expect(redactSecrets("")).toBe("");
  });

  it("handles large payloads (100 KB) without throwing", () => {
    const oneKB =
      "x".repeat(900) +
      " Authorization: Bearer sk-ant-abcdefghijklmnopqrst " +
      "y".repeat(40);
    const big = oneKB.repeat(100); // ~100 KB
    expect(() => redactSecrets(big)).not.toThrow();
    const out = redactSecrets(big);
    expect(out).not.toMatch(/sk-ant-abcdefghijklmnopqrst/);
  });
});

// ── isKimiCreditsExhausted ────────────────────────────────────────────
// Pattern detector that drives the editorial-agent's credit-exhaustion
// short-circuit. Mistakes here mean infrastructure outages get
// re-classified as content failures — the exact bug class #4776/#4777
// eliminated. Strict positive/negative table.

describe("isKimiCreditsExhausted — positive matches", () => {
  it.each([
    // The verbatim OpenRouter shape observed in production (PR follow-up):
    "This request requires more credits, or fewer max_tokens. You requested up to 4096 tokens, but can only afford 452. To increase, visit https://openrouter.ai/settings/credits and add more credits",
    "[kimi-model] OpenRouter call failed (This request requires more credits, or fewer max_tokens. You requested up to 2048 tokens, but can only afford 317. To increase, visit https://openrouter.ai/settings/credits and add more credits); falling back to Workers AI",
    "Intent Gap: Kimi K2.5 failed — skipping step (This request requires more credits, or fewer max_tokens. You requested up to 900 tokens, but can only afford 323. To increase, visit https://openrouter.ai/settings/credits and add more credits)",
    // Variations that still mean the same thing.
    "you can only afford 12 tokens",
    "THIS REQUEST REQUIRES MORE CREDITS"
  ])("matches credit-exhaustion shape: %s", (msg) => {
    expect(isKimiCreditsExhausted(msg)).toBe(true);
  });
});

describe("isKimiCreditsExhausted — negative matches", () => {
  it.each([
    "",
    "Prompt tokens limit exceeded: 5374 > 1507",
    "TypeError: cannot read properties of undefined",
    "AbortError: signal is aborted without reason",
    "OpenRouter 500: Internal Server Error",
    "Failed to process successful response",
    "the credits agency required a check"
  ])("leaves benign message untouched: %s", (msg) => {
    expect(isKimiCreditsExhausted(msg)).toBe(false);
  });

  it("handles non-string input gracefully", () => {
    expect(isKimiCreditsExhausted(undefined as unknown as string)).toBe(false);
    expect(isKimiCreditsExhausted(null as unknown as string)).toBe(false);
    expect(isKimiCreditsExhausted(42 as unknown as string)).toBe(false);
  });
});
