import { describe, expect, it } from "vitest";
import { redactSecrets } from "../pipeline/http-utils";
import { appendToRingBuffer } from "../pipeline/ring-buffer";

// End-to-end privacy test for the agent.log → redactSecrets → persist →
// render chain that protects /api/logs, the dashboard panels, and the
// Google Sheets mirror. This is the highest-value test in the suite:
// it doesn't matter how individual helpers behave in isolation if
// secrets still appear in the final rendered output.
//
// We can't easily instantiate SEOArticleAgent here (Durable Object
// runtime), so we model the composition of the production code path:
//
//   1. log(msg) is the entry — first action is `msg = redactSecrets(msg)`
//      (src/server.ts:4740, the exact line shipped in #4741).
//   2. The redacted msg is packed into an ActivityLogEntry whose `msg`
//      field is what every downstream consumer reads.
//   3. The entry is appended to capped ring buffers — main activityLog,
//      observerLog (when role === "observerAgent"), and activityLogErrors
//      (when level === "error") — via appendToRingBuffer().
//   4. The dashboard reads `entry.msg` straight to its panel renderers.
//
// Any secret in step 1 that survives into the rendered string in step 4
// is a leak. We assert exactly that — the rendered string must not
// match any of the regex shapes from the redactor.

type Entry = { level: string; msg: string; role?: string };

function fakeLog(
  state: {
    activityLog: Entry[];
    observerLog: Entry[];
    activityLogErrors: Entry[];
  },
  level: string,
  msgRaw: string,
  role?: string
): typeof state {
  // Matches src/server.ts:log() shape — redactSecrets at entry, then ring
  // buffers per role/level. Caps mirror server constants.
  const msg = redactSecrets(msgRaw);
  const entry: Entry = { level, msg, role };
  return {
    activityLog: appendToRingBuffer(state.activityLog, entry, 200),
    activityLogErrors:
      level === "error"
        ? appendToRingBuffer(state.activityLogErrors, entry, 200)
        : state.activityLogErrors,
    observerLog:
      role === "observerAgent"
        ? appendToRingBuffer(state.observerLog, entry, 40)
        : state.observerLog
  };
}

// What the dashboard's panels render. The text in `entry.msg` is what
// reaches the DOM — the panels pass it straight through.
function renderedText(state: ReturnType<typeof fakeLog>): string {
  return [
    ...state.activityLog.map((e) => e.msg),
    ...state.activityLogErrors.map((e) => e.msg),
    ...state.observerLog.map((e) => e.msg)
  ].join("\n");
}

const FORBIDDEN_PATTERNS: RegExp[] = [
  /\bsk-ant-[A-Za-z0-9_-]{20,}/,
  /\bsk-[A-Za-z0-9_-]{20,}/,
  /\bck_[A-Za-z0-9_-]{20,}/,
  /\bAKIA[0-9A-Z]{16}\b/,
  /\b(?:ghp|ghs|ghr|gho|ghu)_[A-Za-z0-9]{30,}\b/,
  /\bgithub_pat_[A-Za-z0-9_]{40,}\b/,
  /\bxox[abprso]-[A-Za-z0-9-]{10,}/,
  /\b(?:sk|pk|rk)_(?:live|test)_[A-Za-z0-9]{20,}/,
  /\bwhsec_[A-Za-z0-9]{20,}/,
  /\bsess-[A-Za-z0-9]{20,}/,
  /\bx-amz-signature=[^&\s"'[]+/i,
  /\b[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/
];

describe("agent.log secret-leak integration", () => {
  it("no secret survives from log entry to rendered panel text", () => {
    const secrets: { level: string; msg: string; role?: string }[] = [
      { level: "info", msg: "Bearer sk-ant-1234567890abcdefghijabcd" },
      { level: "warning", msg: "OpenAI key sk-1234567890abcdefghij failed" },
      {
        level: "error",
        msg: "Composio: ck_G2_abcdefghijklmnopqrstuvwxyz123456"
      },
      { level: "info", msg: "AWS_KEY=AKIAIOSFODNN7EXAMPLE rejected" },
      {
        level: "error",
        msg: "PR push failed using ghp_abcdefghijklmnopqrstuvwxyz1234567890"
      },
      {
        level: "info",
        msg: "Slack notify: xoxb-1234567890-abcdefghij-AbCdEfGhIjKlMnOpQrStUvWx"
      },
      {
        level: "info",
        msg: "Stripe charge: sk_live_abcdefghijklmnopqrstuvwx",
        role: "observerAgent"
      },
      {
        level: "info",
        msg: "Stripe webhook: whsec_abcdefghijklmnopqrstuvwxyz12"
      },
      {
        level: "info",
        msg: "OpenAI session: sess-1234567890abcdefghijklmnopqr"
      },
      {
        level: "info",
        msg: "Cookie: session=abcdefghijklmnopqrstuvwxyz1234567890"
      },
      {
        level: "info",
        msg: "X-Hub-Signature-256: sha256=abcdef1234567890abcdef1234567890abcdef12"
      },
      {
        level: "info",
        msg: "S3 url: https://b.s3.amazonaws.com/k?X-Amz-Signature=abc123def456ghi789jkl&X-Amz-Expires=900"
      },
      {
        level: "info",
        msg: "JWT eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dozjgNryP4J3jVmNHl0w5N_XgL0n3I9PlFUP0THsR8U",
        role: "observerAgent"
      },
      {
        level: "info",
        msg: 'Auth fail: {"token":"sk-ant-aaaaaaaaaaaaaaaaaaaa","key":"ghp_abcdefghijklmnopqrstuvwxyz1234567890"}'
      }
    ];

    let state = {
      activityLog: [] as Entry[],
      observerLog: [] as Entry[],
      activityLogErrors: [] as Entry[]
    };
    for (const s of secrets) state = fakeLog(state, s.level, s.msg, s.role);

    const rendered = renderedText(state);

    for (const pattern of FORBIDDEN_PATTERNS) {
      expect(rendered, `leaked: ${pattern}`).not.toMatch(pattern);
    }

    // Sanity: every entry produced at least one [REDACTED] marker.
    const redactedMarkers = (rendered.match(/\[REDACTED\]/g) ?? []).length;
    expect(redactedMarkers).toBeGreaterThanOrEqual(secrets.length);
  });

  it("observer-only entries reach observerLog AND main log, redacted in both", () => {
    let state = {
      activityLog: [] as Entry[],
      observerLog: [] as Entry[],
      activityLogErrors: [] as Entry[]
    };
    state = fakeLog(
      state,
      "info",
      "Observer (Kimi): Bearer sk-ant-abcdefghijklmnopqrst seen",
      "observerAgent"
    );
    expect(state.observerLog).toHaveLength(1);
    expect(state.activityLog).toHaveLength(1);
    expect(state.observerLog[0].msg).not.toMatch(/sk-ant-[A-Za-z0-9]{20,}/);
    expect(state.activityLog[0].msg).not.toMatch(/sk-ant-[A-Za-z0-9]{20,}/);
    expect(state.observerLog[0].msg).toContain("[REDACTED]");
  });

  it("error-level entries reach activityLogErrors AND main log, redacted in both", () => {
    let state = {
      activityLog: [] as Entry[],
      observerLog: [] as Entry[],
      activityLogErrors: [] as Entry[]
    };
    state = fakeLog(
      state,
      "error",
      "publish failed with token ghp_abcdefghijklmnopqrstuvwxyz1234567890"
    );
    expect(state.activityLog).toHaveLength(1);
    expect(state.activityLogErrors).toHaveLength(1);
    expect(state.activityLog[0].msg).not.toMatch(/ghp_/);
    expect(state.activityLogErrors[0].msg).not.toMatch(/ghp_/);
  });
});
