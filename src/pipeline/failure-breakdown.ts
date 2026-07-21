/**
 * Failure-rate breakdown — categorize article-generation failures into
 * credential / provider-side vs real content-quality failures.
 *
 * Background: the operator reported an 8.7% failure rate but couldn't
 * tell what fraction was REAL (content gates rejected the article) vs
 * PROVIDER (OpenRouter out of credits, Workers AI rate-limited,
 * DataForSEO 401, Amazon 401). Provider failures are a billing /
 * rotation problem; content failures are a code / prompt problem. The
 * autonomous defect loop should only target content failures — chasing
 * a credentials issue with a Copilot PR wastes a cycle.
 *
 * Pure module: takes a list of error messages, returns a typed
 * breakdown. No I/O. Unit-tested. Wired into the admin endpoint
 * `/api/admin/failure-breakdown` in src/server.ts and into the
 * observer tick in observer-agent.ts so the dashboard surfaces it
 * without polling.
 */

export type FailureCategory =
  | "credential-openrouter-credits"
  | "credential-openrouter-401"
  | "credential-workers-ai-rate"
  | "credential-dataforseo-401"
  | "credential-amazon-401"
  | "credential-github-401"
  | "credential-other"
  | "content-thin"
  | "content-seo-regression"
  | "content-jsonld-severe"
  | "content-plagiarism"
  | "content-xss"
  | "content-ftc-gate"
  | "content-document-shape"
  | "content-parser-error"
  | "content-no-sections"
  | "content-fabricated-editorial-note"
  | "content-fingerprint-mismatch"
  | "content-other"
  | "unknown";

const CREDENTIAL_CATEGORIES: ReadonlySet<FailureCategory> =
  new Set<FailureCategory>([
    "credential-openrouter-credits",
    "credential-openrouter-401",
    "credential-workers-ai-rate",
    "credential-dataforseo-401",
    "credential-amazon-401",
    "credential-github-401",
    "credential-other"
  ]);

/**
 * Returns `true` when the category represents a provider-side credential
 * or billing issue (OpenRouter credits, 401 from any upstream, Workers AI
 * rate limit). Callers use this to separate "fix the prompt/pipeline" work
 * from "rotate a key / top up credits" operator actions.
 */
export function isCredentialFailure(c: FailureCategory): boolean {
  return CREDENTIAL_CATEGORIES.has(c);
}

/**
 * Classify a single error message. Pure function; case-insensitive.
 * Order matters — specific patterns must run before generic fallbacks.
 *
 * Accepts `unknown` because real callers pass concatenated activity-
 * log fields whose runtime type isn't guaranteed at the boundary
 * (level/msg/errorMessage are typed `unknown` upstream). Non-string
 * inputs short-circuit to "unknown".
 */
export function categorizeFailureMessage(msg: unknown): FailureCategory {
  if (typeof msg !== "string" || !msg) return "unknown";

  // ── Credential / provider-side (specific first) ────────────────────────
  // OpenRouter credits exhausted — observed live as "402" + "credits".
  if (/openrouter/i.test(msg) && /(credit|402|insufficient)/i.test(msg)) {
    return "credential-openrouter-credits";
  }
  if (/openrouter/i.test(msg) && /(401|unauthor|invalid.*key)/i.test(msg)) {
    return "credential-openrouter-401";
  }
  if (
    /workers.?ai/i.test(msg) &&
    /(rate.?limit|429|quota|exhausted)/i.test(msg)
  ) {
    return "credential-workers-ai-rate";
  }
  if (/dataforseo/i.test(msg) && /(401|403|unauthor)/i.test(msg)) {
    return "credential-dataforseo-401";
  }
  if (/amazon/i.test(msg) && /(401|403|invalidtoken|unauthor)/i.test(msg)) {
    return "credential-amazon-401";
  }
  if (/github/i.test(msg) && /(401|403|bad credentials)/i.test(msg)) {
    return "credential-github-401";
  }

  // ── Content / gate failures (specific first) ──────────────────────────
  if (
    /thin-content-word-count|words.*need.*for.*(?:informational|comparison)/i.test(
      msg
    )
  ) {
    return "content-thin";
  }
  if (/seo regression|seo-regression/i.test(msg)) {
    return "content-seo-regression";
  }
  if (/prepub-jsonld-severe|jsonld.*severe|jsonld regression/i.test(msg)) {
    return "content-jsonld-severe";
  }
  if (/plagiarism|overlap.*\d+\s*%|wirecutter.*voice/i.test(msg)) {
    return "content-plagiarism";
  }
  if (/xss gate|post-rewrite-xss/i.test(msg)) {
    return "content-xss";
  }
  if (/\bftc\s+gate\b/i.test(msg)) {
    return "content-ftc-gate";
  }
  if (/document.shape|rewrite-fragment-not-document/i.test(msg)) {
    return "content-document-shape";
  }
  if (/no sections found|sections.*length.*0|missing.*sections/i.test(msg)) {
    return "content-no-sections";
  }
  if (/unexpected token|json.parse|parser error|invalid json/i.test(msg)) {
    return "content-parser-error";
  }
  if (/editorial.*note|editorial.*integrity/i.test(msg)) {
    return "content-fabricated-editorial-note";
  }
  if (/content fingerprint mismatch|fingerprint.*missing/i.test(msg)) {
    return "content-fingerprint-mismatch";
  }

  // ── Generic fallbacks ─────────────────────────────────────────────────
  // Anything credential-shaped that didn't match a vendor falls into
  // credential-other so we don't misclassify it as a content failure.
  // The "invalid (api key|credentials|token)" check matches either
  // word-order ("invalid API key" / "API key invalid") since both
  // forms appear in real upstream error messages.
  if (
    /(401|403|429|invalid.*(?:api.?key|credentials|token)|(?:api.?key|credentials|token).*invalid|rate.?limit|quota|credit)/i.test(
      msg
    )
  ) {
    return "credential-other";
  }
  // Anything that mentions a known content-gate label falls into
  // content-other. The named buckets above catch the common shapes;
  // this catches the long tail.
  if (/(gate|regress|reject|defect|finding)/i.test(msg)) {
    return "content-other";
  }
  return "unknown";
}

/**
 * Aggregated result from `summarizeFailureBreakdown`. Splits the failure
 * population into credential (billing / provider) vs content (pipeline /
 * prompt) buckets so the autonomous defect loop and the admin dashboard
 * can target the right remediation action.
 */
export interface FailureBreakdown {
  total: number;
  byCategory: Record<FailureCategory, number>;
  credentialCount: number;
  contentCount: number;
  unknownCount: number;
  /**
   * (contentCount + unknownCount) / total — the share of failures NOT
   * explained by a credential / provider issue. This is the rate the
   * autonomous defect loop should be targeting; everything else is a
   * billing / rotation operator action.
   */
  nonCredentialRate: number;
  /** credentialCount / total. */
  credentialRate: number;
}

/**
 * Aggregate a list of failure messages into a typed breakdown. Empty
 * input produces a zero-filled report with rates = 0.
 */
export function summarizeFailureBreakdown(
  messages: readonly unknown[]
): FailureBreakdown {
  const byCategory: Record<FailureCategory, number> = {
    "credential-openrouter-credits": 0,
    "credential-openrouter-401": 0,
    "credential-workers-ai-rate": 0,
    "credential-dataforseo-401": 0,
    "credential-amazon-401": 0,
    "credential-github-401": 0,
    "credential-other": 0,
    "content-thin": 0,
    "content-seo-regression": 0,
    "content-jsonld-severe": 0,
    "content-plagiarism": 0,
    "content-xss": 0,
    "content-ftc-gate": 0,
    "content-document-shape": 0,
    "content-parser-error": 0,
    "content-no-sections": 0,
    "content-fabricated-editorial-note": 0,
    "content-fingerprint-mismatch": 0,
    "content-other": 0,
    unknown: 0
  };
  let credentialCount = 0;
  let contentCount = 0;
  let unknownCount = 0;
  for (const m of messages) {
    const cat = categorizeFailureMessage(m);
    byCategory[cat]++;
    if (isCredentialFailure(cat)) credentialCount++;
    else if (cat === "unknown") unknownCount++;
    else contentCount++;
  }
  const total = messages.length;
  const credentialRate = total > 0 ? credentialCount / total : 0;
  const nonCredentialRate =
    total > 0 ? (contentCount + unknownCount) / total : 0;
  return {
    total,
    byCategory,
    credentialCount,
    contentCount,
    unknownCount,
    credentialRate,
    nonCredentialRate
  };
}

/**
 * Render the breakdown as a one-line summary suitable for an
 * observer-tick log entry. Operators see this in the dashboard
 * without needing to hit the admin endpoint.
 */
export function formatBreakdownOneLine(b: FailureBreakdown): string {
  if (b.total === 0) return "Failure breakdown: 0 failures in window.";
  const pct = (n: number) => `${(n * 100).toFixed(1)}%`;
  const topContent = Object.entries(b.byCategory)
    .filter(([k]) => k.startsWith("content-"))
    .sort((a, b2) => b2[1] - a[1])
    .filter(([, n]) => n > 0)
    .slice(0, 3)
    .map(([k, n]) => `${k.replace("content-", "")}=${n}`)
    .join(", ");
  return (
    `Failure breakdown: total=${b.total} ` +
    `credential=${b.credentialCount} (${pct(b.credentialRate)}) ` +
    `non-credential=${b.contentCount + b.unknownCount} (${pct(b.nonCredentialRate)})` +
    (topContent ? ` | top content: ${topContent}` : "")
  );
}
