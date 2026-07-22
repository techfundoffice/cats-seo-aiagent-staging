import {
  memo,
  useCallback,
  useEffect,
  useRef,
  useState,
  type ReactNode
} from "react";
import { useAgent } from "agents/react";
import {
  ACTIVITY_LOG_DASHBOARD_URL,
  getActivityLogSheetColumnLegendLines,
  type AgentRole
} from "./activityLogSheetColumns";
import {
  isActivityLogErrorLevel,
  isActivityLogWarningOrErrorLevel,
  isActivityLogWarningLevel,
  normalizeActivityLogLevel
} from "./activityLogLevels";
import { degradedProviders } from "./externalProviderHealth";
import { filterObjectArrayEntries, parseJsonStringValue } from "./objectLike";
import { computeObserverHealth } from "./observerHealth";
import { errMsg, normalizeSingleLine } from "./pipeline/http-utils";
import type {
  ActivityLogEntry,
  SEOArticleAgent,
  SEOAgentState
} from "./server";
import MermaidChart from "./MermaidChart";

// ── Types for the Generate-1-Article audit panel ─────────────────────────────
interface SeoCheck {
  id: number;
  name: string;
  pillar: string;
  passed: boolean;
  detail: string;
}

interface GenerateOneResult {
  ok: boolean;
  keyword?: string;
  category?: string;
  url?: string;
  seoScore?: number;
  wordCount?: number;
  error?: string;
  seoScorecard?: {
    pillars: Record<string, { passed: number; total: number }>;
    checks: SeoCheck[];
  };
}

// ── Google Sheet iframe embed ─────────────────────────────────────────────────
/**
 * Converts any Google Sheets URL to the /htmlview embed URL.
 *
 * Research findings (tested against the live sheet):
 *   /edit  → HTTP 200, but Google sets X-Frame-Options: SAMEORIGIN → blocked
 *   /pub   → HTTP 302 → Google login redirect (requires "Publish to web")
 *   /htmlview → HTTP 200, NO X-Frame-Options header, NO frame-ancestors CSP
 *              → embeds fine for any sheet shared as "Anyone with the link"
 *   /preview  → same as /htmlview
 *
 * Sources:
 *   1. https://stackoverflow.com/questions/60562968 — htmlview opens in iframe
 *   2. https://webapps.stackexchange.com/questions/130654 — all URL params
 *   3. https://bettersheets.co/download/ — htmlview vs preview difference
 *   4. https://stackoverflow.com/questions/73449337 — /embed trick for Slides
 *   5. Live header probe: curl -sI .../htmlview → no X-Frame-Options at all
 */
// Single source of truth for an activity-log entry's plain-text shape. The
// bulk Copy Log button and the per-row 📋 button both call this so the two
// outputs stay byte-identical — pasting N individual rows is indistinguishable
// from pasting that range from the bulk button.
function formatActivityEntry(e: ActivityLogEntry): string {
  const keyword = typeof e.keyword === "string" ? e.keyword : "";
  const competitorUrl =
    typeof e.competitorUrl === "string" ? e.competitorUrl : "";
  const articleUrlValue = typeof e.articleUrl === "string" ? e.articleUrl : "";
  const kw = keyword.trim() ? keyword : "—";
  const comp = competitorUrl.trim() ? competitorUrl : "—";
  const articleUrl = articleUrlValue.trim() || "—";
  const seo = e.seoScore === "" ? "—" : String(e.seoScore);
  const plag =
    e.plagiarismPercentage === undefined || e.plagiarismPercentage === ""
      ? "—"
      : `${e.plagiarismPercentage}%`;
  const ref = String(e.logRef).padStart(3, " ");
  const step =
    typeof e.stepNumber === "string" && e.stepNumber.trim() !== ""
      ? e.stepNumber
      : "0";
  const level =
    normalizeActivityLogLevel(e.level) ??
    (typeof e.level === "string" && e.level.trim() !== ""
      ? e.level.trim().toLowerCase()
      : "info");
  return `${ref}. step ${step} [${e.timeDate} ${e.timeTime}] Article URL: ${articleUrl} Keyword: ${kw} Competitor URL: ${comp} SEO score: ${seo} Plagiarism %: ${plag} [${level.toUpperCase()}] ${e.msg}`;
}

function sanitizeActivityLogEntries(entries: unknown): ActivityLogEntry[] {
  return filterObjectArrayEntries<ActivityLogEntry>(entries);
}

function getActivityLogEntries(state: SEOAgentState): ActivityLogEntry[] {
  return sanitizeActivityLogEntries(state.activityLog);
}

function getResultErrorMessage(result: unknown): string | undefined {
  if (!result || typeof result !== "object") {
    return undefined;
  }
  if ("error" in result) {
    const { error } = result as { error: unknown };
    if (typeof error === "string" && error.trim()) {
      return error;
    }
    const fallback = errMsg(error).trim();
    return fallback && fallback !== "[object Object]" ? fallback : undefined;
  }
  if (!("success" in result)) {
    return undefined;
  }
  const { success } = result as { success: unknown };
  if (success === true) {
    return undefined;
  }
  const fallback = errMsg(result).trim();
  return fallback && fallback !== "[object Object]" ? fallback : undefined;
}

function logDashboardControlError(action: string, error: unknown): void {
  console.error(`Dashboard control "${action}" failed: ${errMsg(error)}`);
}

function logDashboardControlResultError(action: string, result: unknown): void {
  const errorMessage = getResultErrorMessage(result);
  if (errorMessage) {
    logDashboardControlError(action, errorMessage);
  }
}

function toEmbedUrl(raw: string): string {
  try {
    const u = new URL(raw);
    const match = u.pathname.match(/\/spreadsheets\/d\/([^/]+)/);
    if (!match) return raw;
    const id = match[1];
    // Preserve gid (tab) from query string or hash
    const hashParams = new URLSearchParams(
      u.hash.startsWith("#") ? u.hash.slice(1) : u.hash
    );
    const gid = u.searchParams.get("gid") || hashParams.get("gid") || "";
    const gidParam = gid ? `#gid=${gid}` : "";
    return `https://docs.google.com/spreadsheets/d/${id}/htmlview${gidParam}`;
  } catch {
    return raw;
  }
}

function SheetEmbed({ url }: { url: string }) {
  const embedUrl = toEmbedUrl(url);
  const [loaded, setLoaded] = useState(false);
  const [errored, setErrored] = useState(false);

  return (
    <div>
      {/* Toolbar */}
      <div
        style={{
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
          marginBottom: "0.5rem",
          flexWrap: "wrap",
          gap: "0.5rem"
        }}
      >
        <span style={{ fontSize: "0.75rem", color: "#6b7280" }}>
          {loaded
            ? "✅ Sheet loaded"
            : errored
              ? "❌ Load error"
              : "⏳ Loading sheet…"}
        </span>
        <a
          href={url}
          target="_blank"
          rel="noopener noreferrer"
          style={{
            padding: "0.375rem 0.75rem",
            background: "#059669",
            color: "#fff",
            borderRadius: "0.375rem",
            fontWeight: 600,
            fontSize: "0.8rem",
            textDecoration: "none",
            whiteSpace: "nowrap"
          }}
        >
          📊 Open in Google Sheets ↗
        </a>
      </div>

      {errored && (
        <div
          style={{
            padding: "0.75rem",
            background: "#fef3c7",
            border: "1px solid #fcd34d",
            borderRadius: "0.5rem",
            marginBottom: "0.5rem",
            fontSize: "0.85rem",
            color: "#92400e"
          }}
        >
          <strong>⚠️ Could not load iframe.</strong> Click{" "}
          <a
            href={url}
            target="_blank"
            rel="noopener noreferrer"
            style={{ color: "#1d4ed8" }}
          >
            Open in Google Sheets ↗
          </a>{" "}
          to view the data directly.
        </div>
      )}

      <div style={{ position: "relative" }}>
        {!loaded && !errored && (
          <div
            style={{
              position: "absolute",
              inset: 0,
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              background: "#f9fafb",
              borderRadius: "0.5rem",
              border: "1px solid #e5e7eb",
              zIndex: 1
            }}
          >
            <span style={{ color: "#6b7280", fontSize: "0.9rem" }}>
              Loading Google Sheet…
            </span>
          </div>
        )}
        <iframe
          key={embedUrl}
          title="Google Sheet — AI CEO OF CATS LUV US"
          src={embedUrl}
          style={{
            width: "100%",
            height: "700px",
            border: "1px solid #e5e7eb",
            borderRadius: "0.5rem",
            background: "#fff",
            display: "block"
          }}
          onLoad={() => {
            setLoaded(true);
            setErrored(false);
          }}
          onError={() => {
            setErrored(true);
            setLoaded(false);
          }}
          referrerPolicy="no-referrer-when-downgrade"
        />
      </div>
    </div>
  );
}

// ── ChatGPT-style Audit Panel ─────────────────────────────────────────────────
function AuditPanel({ result }: { result: GenerateOneResult }) {
  const score = result.seoScore ?? 0;
  const checks = result.seoScorecard?.checks ?? [];
  const passed = checks.filter((c) => c.passed).length;
  const failed = checks.filter((c) => !c.passed);
  const pillars = result.seoScorecard?.pillars ?? {};

  // Colour based on score
  const scoreColour =
    score >= 80 ? "#059669" : score >= 60 ? "#d97706" : "#dc2626";

  // Group failed checks by pillar
  const failedByPillar: Record<string, SeoCheck[]> = {};
  for (const c of failed) {
    if (!failedByPillar[c.pillar]) failedByPillar[c.pillar] = [];
    failedByPillar[c.pillar].push(c);
  }

  return (
    <div
      style={{
        background: "#fff",
        borderRadius: "0.75rem",
        border: "1px solid #e5e7eb",
        padding: "1.25rem",
        marginTop: "1rem",
        fontFamily: "ui-sans-serif,system-ui,sans-serif"
      }}
    >
      {/* Header */}
      <div
        style={{
          display: "flex",
          alignItems: "center",
          gap: "0.75rem",
          marginBottom: "1rem"
        }}
      >
        <div
          style={{
            width: "2.5rem",
            height: "2.5rem",
            borderRadius: "50%",
            background: "#2563eb",
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            color: "#fff",
            fontWeight: 700,
            fontSize: "0.875rem",
            flexShrink: 0
          }}
        >
          AI
        </div>
        <div>
          <div style={{ fontWeight: 600, color: "#111827" }}>
            SEO Article Audit
          </div>
          <div style={{ fontSize: "0.8rem", color: "#6b7280" }}>
            100-point scoring
          </div>
        </div>
      </div>

      {/* Score banner */}
      <div
        style={{
          background: result.ok ? "#f0fdf4" : "#fef2f2",
          border: `1px solid ${result.ok ? "#bbf7d0" : "#fecaca"}`,
          borderRadius: "0.5rem",
          padding: "1rem",
          marginBottom: "1rem",
          display: "flex",
          alignItems: "center",
          gap: "1rem"
        }}
      >
        <div
          style={{
            fontSize: "2.5rem",
            fontWeight: 800,
            color: scoreColour,
            lineHeight: 1,
            minWidth: "4rem",
            textAlign: "center"
          }}
        >
          {result.ok ? score : "❌"}
        </div>
        <div>
          <div style={{ fontWeight: 600, color: "#111827", fontSize: "1rem" }}>
            {result.ok
              ? score >= 80
                ? "🏆 Excellent — Ready to rank"
                : score >= 60
                  ? "⚠️ Good — Needs improvements"
                  : "🔴 Below target — Needs work"
              : "Article generation failed"}
          </div>
          {result.ok && (
            <div
              style={{
                fontSize: "0.8rem",
                color: "#6b7280",
                marginTop: "0.25rem"
              }}
            >
              {passed} / {checks.length} checks passed
              {result.wordCount ? ` · ${result.wordCount} words` : ""}
              {result.url ? (
                <>
                  {" · "}
                  <a
                    href={result.url}
                    target="_blank"
                    rel="noopener"
                    style={{ color: "#2563eb" }}
                  >
                    View article ↗
                  </a>
                </>
              ) : null}
            </div>
          )}
          {!result.ok && (
            <div
              style={{
                fontSize: "0.8rem",
                color: "#dc2626",
                marginTop: "0.25rem"
              }}
            >
              {result.error}
            </div>
          )}
        </div>
      </div>

      {/* Keyword + URL */}
      {result.keyword && (
        <div
          style={{
            fontSize: "0.875rem",
            color: "#374151",
            marginBottom: "0.75rem",
            background: "#f9fafb",
            borderRadius: "0.375rem",
            padding: "0.5rem 0.75rem"
          }}
        >
          <span style={{ color: "#6b7280" }}>Keyword: </span>
          <strong>{result.keyword}</strong>
        </div>
      )}

      {/* Pillar breakdown */}
      {Object.keys(pillars).length > 0 && (
        <div style={{ marginBottom: "1rem" }}>
          <div
            style={{
              fontSize: "0.8rem",
              fontWeight: 600,
              color: "#374151",
              marginBottom: "0.5rem",
              textTransform: "uppercase",
              letterSpacing: "0.05em"
            }}
          >
            Pillar Breakdown
          </div>
          <div
            style={{
              display: "grid",
              gridTemplateColumns: "repeat(auto-fill, minmax(160px, 1fr))",
              gap: "0.5rem"
            }}
          >
            {Object.entries(pillars).map(([pillar, { passed: p, total }]) => {
              const pct = total > 0 ? Math.round((p / total) * 100) : 0;
              const col =
                pct >= 80 ? "#059669" : pct >= 50 ? "#d97706" : "#dc2626";
              return (
                <div
                  key={pillar}
                  style={{
                    background: "#f9fafb",
                    border: "1px solid #e5e7eb",
                    borderRadius: "0.375rem",
                    padding: "0.5rem 0.75rem"
                  }}
                >
                  <div
                    style={{
                      fontSize: "0.7rem",
                      color: "#6b7280",
                      marginBottom: "0.25rem",
                      textTransform: "uppercase",
                      letterSpacing: "0.04em"
                    }}
                  >
                    {pillar}
                  </div>
                  <div
                    style={{ fontWeight: 700, color: col, fontSize: "1rem" }}
                  >
                    {p}/{total}
                  </div>
                  <div
                    style={{
                      height: "4px",
                      background: "#e5e7eb",
                      borderRadius: "2px",
                      marginTop: "0.25rem"
                    }}
                  >
                    <div
                      style={{
                        height: "100%",
                        width: `${pct}%`,
                        background: col,
                        borderRadius: "2px",
                        transition: "width 0.6s ease"
                      }}
                    />
                  </div>
                </div>
              );
            })}
          </div>
        </div>
      )}

      {/* Failed checks */}
      {Object.keys(failedByPillar).length > 0 && (
        <div>
          <div
            style={{
              fontSize: "0.8rem",
              fontWeight: 600,
              color: "#374151",
              marginBottom: "0.5rem",
              textTransform: "uppercase",
              letterSpacing: "0.05em"
            }}
          >
            🔴 Issues to Fix ({failed.length})
          </div>
          {Object.entries(failedByPillar).map(([pillar, items]) => (
            <details key={pillar} open style={{ marginBottom: "0.5rem" }}>
              <summary
                style={{
                  cursor: "pointer",
                  fontSize: "0.8rem",
                  fontWeight: 600,
                  color: "#374151",
                  padding: "0.25rem 0",
                  userSelect: "none"
                }}
              >
                {pillar} — {items.length} issue{items.length !== 1 ? "s" : ""}
              </summary>
              <div style={{ marginTop: "0.25rem" }}>
                {items.map((c) => (
                  <div
                    key={c.id}
                    style={{
                      display: "flex",
                      gap: "0.5rem",
                      padding: "0.375rem 0.5rem",
                      fontSize: "0.8rem",
                      borderLeft: "3px solid #fca5a5",
                      marginBottom: "0.25rem",
                      background: "#fef2f2",
                      borderRadius: "0 0.25rem 0.25rem 0"
                    }}
                  >
                    <span style={{ color: "#dc2626", fontWeight: 600 }}>
                      #{c.id}
                    </span>
                    <div>
                      <span style={{ fontWeight: 600, color: "#374151" }}>
                        {c.name}
                      </span>
                      {c.detail && (
                        <span style={{ color: "#6b7280" }}> — {c.detail}</span>
                      )}
                    </div>
                  </div>
                ))}
              </div>
            </details>
          ))}
        </div>
      )}

      {/* Pipeline improvement prompt */}
      <details style={{ marginTop: "1rem" }}>
        <summary
          style={{
            cursor: "pointer",
            fontSize: "0.8rem",
            fontWeight: 600,
            color: "#2563eb",
            userSelect: "none",
            padding: "0.25rem 0"
          }}
        >
          📋 View improvement prompt for this article
        </summary>
        <pre
          style={{
            marginTop: "0.5rem",
            background: "#1e293b",
            color: "#e2e8f0",
            borderRadius: "0.5rem",
            padding: "0.875rem",
            fontSize: "0.72rem",
            lineHeight: 1.5,
            whiteSpace: "pre-wrap",
            wordBreak: "break-word",
            maxHeight: "20rem",
            overflowY: "auto"
          }}
        >
          {buildImprovementPrompt(result)}
        </pre>
      </details>
    </div>
  );
}

/** Build a structured improvement prompt based on the audit result. */
function buildImprovementPrompt(result: GenerateOneResult): string {
  const checks = result.seoScorecard?.checks ?? [];
  const failed = checks
    .filter((c) => !c.passed)
    .map((c) => `  #${c.id} [${c.pillar}] ${c.name}: ${c.detail}`)
    .join("\n");

  return `# Article Improvement Prompt — catsluvus.com SEO Pipeline

## Context
You are an expert SEO content writer for catsluvus.com specialising in cat-product review articles.
The article below scored ${result.seoScore ?? "N/A"}/100 on our 100-point SEO heuristic.
Your job is to rewrite or expand the article so that it passes every failed check listed below
and beats the #1 Google result for the target keyword in both quality and word count.

## Target keyword
${result.keyword ?? "(not available)"}

## Article URL (live)
${result.url ?? "(not published yet)"}

## Word count
Current: ${result.wordCount ?? "unknown"} words.
Target: Beat the #1 ranked competitor — aim for at least 10% more words than the top result.

## Failed SEO checks (fix ALL of these)
${failed || "  (none — all checks passed ✅)"}

## Rewrite instructions
1. Keep the existing title, meta description, and URL slug unchanged.
2. Expand every H2 section to at least 200 words — use real examples, expert observations,
   and concrete data (pricing, dimensions, materials) rather than filler.
3. Expand every FAQ answer to at least 120 words with 2-3 supporting sentences.
4. Address every failed check listed above — each one must pass after the rewrite.
5. Add a unique "Expert Take" paragraph in each section with a first-person observation
   from Amelia Hartwell, Cat Care Specialist (Certified Feline Behavior Consultant).
6. Include at least 3 internal links to related catsluvus.com articles.
7. Do NOT use generic filler phrases like "delve", "leverage", "it's worth noting".
8. Write in a warm, authoritative human tone — short punchy paragraphs, bullet points.
9. Return the full article as valid HTML (same structure as the original).

## Output format
Return ONLY the improved HTML article body (from <h1> onwards).
Do not include <html>, <head>, or <body> tags.`;
}

function useTransientButtonLabel(baseLabel: string) {
  const [label, setLabel] = useState(baseLabel);
  const resetTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    return () => {
      if (resetTimerRef.current !== null) {
        clearTimeout(resetTimerRef.current);
      }
    };
  }, []);

  const showStatus = useCallback(
    (statusLabel: string) => {
      setLabel(statusLabel);
      if (resetTimerRef.current !== null) {
        clearTimeout(resetTimerRef.current);
      }
      resetTimerRef.current = setTimeout(() => {
        setLabel(baseLabel);
      }, 1500);
    },
    [baseLabel]
  );

  return { label, showStatus };
}

// One row of the Activity Log. Owns its own "copied" state so a click on
// row A doesn't re-render every other row, and so React.memo can short-circuit
// when neighbour rows' props are unchanged. Stable key={entry.logRef} on the
// caller side makes the memoization meaningful.
const ActivityLogRow = memo(function ActivityLogRow({
  entry
}: {
  entry: ActivityLogEntry;
}) {
  const [copied, setCopied] = useState(false);
  const copyResetTimerRef = useRef<ReturnType<typeof setTimeout> | undefined>(
    undefined
  );

  useEffect(() => {
    return () => {
      clearTimeout(copyResetTimerRef.current);
      copyResetTimerRef.current = undefined;
    };
  }, []);

  const onCopy = () => {
    const writeText = navigator.clipboard?.writeText;
    if (!writeText) {
      console.warn("Activity Log copy unavailable: Clipboard API missing", {
        logRef: entry.logRef,
        stepNumber: entry.stepNumber
      });
      return;
    }

    writeText
      .call(navigator.clipboard, formatActivityEntry(entry))
      .then(() => {
        setCopied(true);
        clearTimeout(copyResetTimerRef.current);
        copyResetTimerRef.current = setTimeout(() => {
          setCopied(false);
          copyResetTimerRef.current = undefined;
        }, 1500);
      })
      .catch((err) => {
        console.warn("Activity Log copy failed", {
          logRef: entry.logRef,
          stepNumber: entry.stepNumber,
          error: err
        });
      });
  };

  return (
    <div
      style={{
        display: "flex",
        flexWrap: "wrap",
        alignItems: "center",
        gap: "0.5rem",
        fontSize: "0.8rem",
        padding: "0.375rem 0",
        borderBottom: "1px solid #f9fafb"
      }}
    >
      <span
        style={{
          color: "#6b7280",
          fontFamily: "monospace",
          whiteSpace: "nowrap",
          minWidth: "2rem",
          textAlign: "right"
        }}
      >
        {entry.logRef}
      </span>
      <span
        style={{
          color: "#7c3aed",
          fontFamily: "monospace",
          whiteSpace: "nowrap",
          minWidth: "6rem",
          maxWidth: "14rem",
          overflow: "hidden",
          textOverflow: "ellipsis",
          textAlign: "left",
          fontSize: "0.72rem"
        }}
        title={
          typeof entry.stepNumber === "string" && entry.stepNumber.trim() !== ""
            ? entry.stepNumber
            : "Step # (sheet column E), idle = 0"
        }
      >
        {typeof entry.stepNumber === "string" && entry.stepNumber.trim() !== ""
          ? entry.stepNumber
          : "0"}
      </span>
      <span
        style={{
          color: "#6b7280",
          fontFamily: "monospace",
          whiteSpace: "nowrap"
        }}
      >
        <span style={{ marginRight: "0.35rem" }}>{entry.timeDate}</span>
        <span>{entry.timeTime}</span>
      </span>
      <span
        style={{
          color: "#6b7280",
          fontSize: "0.65rem",
          whiteSpace: "nowrap",
          alignSelf: "center"
        }}
      >
        Article URL:
      </span>
      <span
        style={{
          fontFamily: "monospace",
          fontSize: "0.75rem",
          minWidth: "2.5rem",
          maxWidth: "14rem",
          overflow: "hidden",
          textOverflow: "ellipsis",
          whiteSpace: "nowrap",
          color:
            (entry.articleUrl || "Error") === "Error" ? "#dc2626" : "#059669"
        }}
        title={entry.articleUrl || "Error"}
      >
        {entry.articleUrl || "Error"}
      </span>
      <span
        style={{
          color: "#6b7280",
          fontSize: "0.65rem",
          whiteSpace: "nowrap"
        }}
      >
        Keyword:
      </span>
      <span
        style={{
          fontFamily: "monospace",
          fontSize: "0.75rem",
          maxWidth: "10rem",
          overflow: "hidden",
          textOverflow: "ellipsis",
          whiteSpace: "nowrap",
          color: "#4b5563"
        }}
        title={(entry.keyword ?? "").trim()}
      >
        {(entry.keyword ?? "").trim() || "—"}
      </span>
      <span
        style={{
          color: "#6b7280",
          fontSize: "0.65rem",
          whiteSpace: "nowrap"
        }}
      >
        Category:
      </span>
      <span
        style={{
          fontFamily: "monospace",
          fontSize: "0.75rem",
          maxWidth: "12rem",
          overflow: "hidden",
          textOverflow: "ellipsis",
          whiteSpace: "nowrap",
          color: "#6b7280"
        }}
        title={(entry.categorySlug ?? "").trim()}
      >
        {(entry.categorySlug ?? "").trim() || "—"}
      </span>
      <span
        style={{
          color: "#6b7280",
          fontSize: "0.65rem",
          whiteSpace: "nowrap"
        }}
      >
        Competitor URL:
      </span>
      <span
        style={{
          fontFamily: "monospace",
          fontSize: "0.72rem",
          maxWidth: "12rem",
          overflow: "hidden",
          textOverflow: "ellipsis",
          whiteSpace: "nowrap",
          color: "#2563eb"
        }}
        title={(entry.competitorUrl ?? "").trim()}
      >
        {(entry.competitorUrl ?? "").trim()
          ? linkify((entry.competitorUrl ?? "").trim())
          : "—"}
      </span>
      <span
        style={{
          color: "#6b7280",
          fontSize: "0.65rem",
          whiteSpace: "nowrap"
        }}
      >
        SEO score:
      </span>
      <span
        style={{
          fontFamily: "monospace",
          fontSize: "0.75rem",
          whiteSpace: "nowrap",
          color: "#4b5563"
        }}
      >
        {entry.seoScore === "" ? "—" : String(entry.seoScore)}
      </span>
      <span
        style={{
          color: isActivityLogErrorLevel(entry.level)
            ? "#dc2626"
            : isActivityLogWarningLevel(entry.level)
              ? "#d97706"
              : "#374151",
          flex: "1 1 12rem",
          minWidth: "8rem"
        }}
      >
        {linkify(entry.msg)}
      </span>
      <button
        onClick={onCopy}
        type="button"
        title="Copy this entry"
        aria-label="Copy this entry"
        aria-live="polite"
        style={{
          marginLeft: "auto",
          padding: "0.125rem 0.375rem",
          fontSize: "0.7rem",
          minWidth: "1.75rem",
          background: copied ? "#dcfce7" : "transparent",
          color: copied ? "#15803d" : "#6b7280",
          border: "1px solid #e5e7eb",
          borderRadius: "0.25rem",
          cursor: "pointer",
          flexShrink: 0
        }}
      >
        {copied ? "✓" : "📋"}
      </button>
    </div>
  );
});

export default function Dashboard() {
  const [state, setState] = useState<SEOAgentState | null>(null);
  const [connected, setConnected] = useState(false);
  const [sheetInput, setSheetInput] = useState("");
  const [generating, setGenerating] = useState(false);
  const [auditResult, setAuditResult] = useState<GenerateOneResult | null>(
    null
  );
  const [auditMessages, setAuditMessages] = useState<
    { role: "assistant" | "user"; text: string }[]
  >([]);
  const activityLogCopyButton = useTransientButtonLabel("📋 Copy Log");
  const sheetBridgeCopyButton = useTransientButtonLabel("📋 Copy Bridge Log");

  const agent = useAgent<SEOArticleAgent, SEOAgentState>({
    agent: "SEOArticleAgent",
    onStateUpdate: (s) => {
      setState(s);
      setConnected(true);
    }
  });

  useEffect(() => {
    if (state?.googleSheetUrl) setSheetInput(state.googleSheetUrl);
  }, [state?.googleSheetUrl]);

  if (!connected || !state) {
    return (
      <div
        style={{
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          height: "100vh"
        }}
      >
        <p style={{ color: "#9ca3af", fontSize: "1.125rem" }}>
          Connecting to agent...
        </p>
      </div>
    );
  }
  const activityLog = getActivityLogEntries(state);

  return (
    <div
      style={{
        minHeight: "100vh",
        background: "#f9fafb",
        padding: "1.5rem"
      }}
    >
      <div style={{ maxWidth: "56rem", margin: "0 auto" }}>
        {/* GitHub repo link */}
        <div style={{ marginBottom: "0.75rem" }}>
          <a
            href="https://github.com/techfundoffice/cats-seo-aiagent-cloudflare"
            target="_blank"
            rel="noopener"
            style={{
              fontSize: "0.8rem",
              color: "#6b7280",
              textDecoration: "none",
              display: "inline-flex",
              alignItems: "center",
              gap: "0.25rem"
            }}
          >
            <svg width="16" height="16" viewBox="0 0 16 16" fill="currentColor">
              <path d="M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82.64-.18 1.32-.27 2-.27.68 0 1.36.09 2 .27 1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.013 8.013 0 0016 8c0-4.42-3.58-8-8-8z" />
            </svg>
            techfundoffice/cats-seo-aiagent-cloudflare
          </a>
        </div>

        {/* Header */}
        <div
          style={{
            display: "flex",
            alignItems: "center",
            justifyContent: "space-between",
            marginBottom: "1.5rem"
          }}
        >
          <div>
            <h1
              style={{
                fontSize: "1.5rem",
                fontWeight: 700,
                color: "#111827"
              }}
            >
              SEO Cloudflare AI Agent
            </h1>
            <p
              style={{
                fontSize: "0.875rem",
                color: "#6b7280",
                marginTop: "0.25rem"
              }}
            >
              Autonomous article generation via Workers AI (Kimi K2.5)
            </p>
            <p
              style={{
                fontSize: "0.8rem",
                color: "#6b7280",
                marginTop: "0.35rem"
              }}
            >
              <span style={{ fontWeight: 600, color: "#4b5563" }}>
                Dashboard URL:{" "}
              </span>
              <a
                href={ACTIVITY_LOG_DASHBOARD_URL}
                target="_blank"
                rel="noopener noreferrer"
                style={{
                  color: "#2563eb",
                  textDecoration: "underline",
                  wordBreak: "break-all"
                }}
              >
                {ACTIVITY_LOG_DASHBOARD_URL}
              </a>
            </p>
            <p
              style={{
                fontSize: "0.8rem",
                color: "#6b7280",
                marginTop: "0.15rem"
              }}
            >
              <span style={{ fontWeight: 600, color: "#4b5563" }}>
                Raw activity log:{" "}
              </span>
              <a
                href="/api/logs"
                target="_blank"
                rel="noopener noreferrer"
                style={{
                  color: "#2563eb",
                  textDecoration: "underline",
                  wordBreak: "break-all"
                }}
              >
                /api/logs
              </a>
              <span style={{ color: "#9ca3af", marginLeft: "0.5rem" }}>
                (plain text, greppable, no auth required)
              </span>
            </p>
            <p
              style={{
                fontSize: "0.8rem",
                color: "#6b7280",
                marginTop: "0.15rem"
              }}
            >
              <span style={{ fontWeight: 600, color: "#4b5563" }}>
                GitHub repo:{" "}
              </span>
              <a
                href="https://github.com/techfundoffice/cats-seo-aiagent-cloudflare"
                target="_blank"
                rel="noopener noreferrer"
                style={{
                  color: "#2563eb",
                  textDecoration: "underline",
                  wordBreak: "break-all"
                }}
              >
                techfundoffice/cats-seo-aiagent-cloudflare ↗
              </a>
              <span style={{ color: "#9ca3af", marginLeft: "0.5rem" }}>
                (source, issues, Coding Agent PRs)
              </span>
            </p>
          </div>
          <div
            style={{ display: "flex", alignItems: "center", gap: "0.75rem" }}
          >
            <span
              style={{
                padding: "0.375rem 0.75rem",
                borderRadius: "9999px",
                fontSize: "0.875rem",
                fontWeight: 600,
                background:
                  state.status === "generating" || state.status === "scouting"
                    ? "#d1fae5"
                    : "#f3f4f6",
                color:
                  state.status === "generating" || state.status === "scouting"
                    ? "#065f46"
                    : "#374151"
              }}
            >
              {state.status === "generating" || state.status === "scouting"
                ? "● PROCESSING"
                : "■ STOPPED"}
            </span>
            <a
              href="https://cats-seo-playground.webmaster-bc8.workers.dev/dashboard"
              target="_blank"
              rel="noopener noreferrer"
              style={{
                padding: "0.375rem 0.875rem",
                borderRadius: "0.5rem",
                fontSize: "0.8rem",
                fontWeight: 600,
                background: "#eef2ff",
                color: "#3730a3",
                border: "1px solid #c7d2fe",
                textDecoration: "none"
              }}
            >
              SEO Playground ↗
            </a>
            <a
              href="/api/logout"
              style={{
                padding: "0.375rem 0.875rem",
                borderRadius: "0.5rem",
                fontSize: "0.8rem",
                fontWeight: 600,
                background: "#f3f4f6",
                color: "#6b7280",
                border: "1px solid #e5e7eb",
                textDecoration: "none",
                cursor: "pointer",
                transition: "background 0.15s"
              }}
              onMouseOver={(e) =>
                ((e.target as HTMLAnchorElement).style.background = "#e5e7eb")
              }
              onFocus={(e) =>
                ((e.target as HTMLAnchorElement).style.background = "#e5e7eb")
              }
              onMouseOut={(e) =>
                ((e.target as HTMLAnchorElement).style.background = "#f3f4f6")
              }
              onBlur={(e) =>
                ((e.target as HTMLAnchorElement).style.background = "#f3f4f6")
              }
            >
              Sign out
            </a>
          </div>
        </div>

        {/* Current Activity */}
        {state.currentKeyword && (
          <div
            style={{
              background: "#fff",
              borderRadius: "0.75rem",
              border: "1px solid #bfdbfe",
              padding: "1rem",
              marginBottom: "1.5rem"
            }}
          >
            <div
              style={{
                fontSize: "0.875rem",
                color: "#6b7280",
                marginBottom: "0.25rem"
              }}
            >
              Currently generating
            </div>
            <div style={{ fontWeight: 600, color: "#111827" }}>
              {state.currentKeyword}
            </div>
            {state.currentStep && (
              <div
                style={{
                  fontSize: "0.875rem",
                  color: "#2563eb",
                  marginTop: "0.25rem"
                }}
              >
                {state.currentStep}
              </div>
            )}
          </div>
        )}

        {/* Stats */}
        <div
          style={{
            display: "grid",
            gridTemplateColumns: "repeat(4, 1fr)",
            gap: "1rem",
            marginBottom: "1rem"
          }}
        >
          <StatCard
            label="Articles Generated"
            value={state.articlesGenerated}
          />
          <StatCard label="Articles Failed" value={state.articlesFailed} />
          <StatCard label="Categories Done" value={state.categoriesCompleted} />
          <StatCard
            label="Avg SEO Score"
            value={Number.isFinite(state.avgSeoScore) ? state.avgSeoScore : "—"}
          />
        </div>

        {/* External-provider health banner — multi-provider derivation
            from the live activity log. Surfaces OpenRouter credit
            exhaustion (#4780) and the DataForSEO HTTP 402 quota wall.
            Hidden during normal
            operation. Per-provider remediation link makes the operator
            action one click away. */}
        <ExternalProviderHealthBanner state={state} />

        {/* Editorial rewrite-loop counters — mirrored from KV per
            editorial-stats.ts. Source of truth for "is the post-publish
            self-improvement loop actually doing anything?" so the
            operator doesn't need to curl /api/admin/editorial-stats. */}
        <EditorialStatsRow state={state} />

        {/* Controls */}
        <div
          style={{
            display: "flex",
            gap: "0.75rem",
            marginBottom: "1.5rem"
          }}
        >
          <button
            onClick={() =>
              agent.stub.start().catch((error: unknown) => {
                logDashboardControlError("start", error);
              })
            }
            disabled={
              state.status === "generating" || state.status === "scouting"
            }
            style={{
              padding: "0.625rem 1.25rem",
              background: "#059669",
              color: "#fff",
              borderRadius: "0.5rem",
              fontWeight: 500,
              border: "none",
              cursor: "pointer",
              opacity:
                state.status === "generating" || state.status === "scouting"
                  ? 0.5
                  : 1
            }}
          >
            ▶ Start
          </button>
          <button
            onClick={() =>
              agent.stub.stop().catch((error: unknown) => {
                logDashboardControlError("stop", error);
              })
            }
            disabled={state.status === "idle" || state.status === "paused"}
            style={{
              padding: "0.625rem 1.25rem",
              background: "#dc2626",
              color: "#fff",
              borderRadius: "0.5rem",
              fontWeight: 500,
              border: "none",
              cursor: "pointer",
              opacity:
                state.status === "idle" || state.status === "paused" ? 0.5 : 1
            }}
          >
            ■ Stop
          </button>
          <button
            onClick={() =>
              agent.stub.scoutNow().catch((error: unknown) => {
                logDashboardControlError("scoutNow", error);
              })
            }
            disabled={state.status === "scouting"}
            style={{
              padding: "0.625rem 1.25rem",
              background: "#2563eb",
              color: "#fff",
              borderRadius: "0.5rem",
              fontWeight: 500,
              border: "none",
              cursor: "pointer",
              opacity: state.status === "scouting" ? 0.5 : 1
            }}
          >
            🔍 Scout Now
          </button>
        </div>

        {/* ── Generate 1 Article & Audit ─────────────────────────────────── */}
        <div
          style={{
            background: "#fff",
            borderRadius: "0.75rem",
            border: "1px solid #e5e7eb",
            padding: "1.25rem",
            marginBottom: "1.5rem"
          }}
        >
          <div
            style={{
              display: "flex",
              alignItems: "center",
              justifyContent: "space-between",
              flexWrap: "wrap",
              gap: "0.75rem",
              marginBottom: auditMessages.length > 0 ? "1rem" : "0"
            }}
          >
            <div>
              <h2
                style={{
                  fontSize: "1rem",
                  fontWeight: 700,
                  color: "#111827",
                  margin: 0
                }}
              >
                ✨ Generate 1 Article &amp; Audit
              </h2>
              <p
                style={{
                  fontSize: "0.8rem",
                  color: "#6b7280",
                  margin: "0.25rem 0 0"
                }}
              >
                Picks the next pending keyword, runs the full publishing
                pipeline, then shows a 100-point SEO audit.
              </p>
            </div>
            <button
              disabled={
                generating ||
                state.status === "generating" ||
                state.status === "scouting"
              }
              onClick={async () => {
                setGenerating(true);
                setAuditResult(null);
                setAuditMessages([
                  {
                    role: "assistant",
                    text: "⏳ Generating article… this usually takes 2–4 minutes. I'll show the full audit once done."
                  }
                ]);
                try {
                  const resp = await fetch("/api/generate-one", {
                    method: "POST",
                    headers: { "Content-Type": "application/json" },
                    body: JSON.stringify({})
                  });
                  const data = (await resp.json()) as GenerateOneResult;
                  setAuditResult(data);
                  setAuditMessages((prev) => [
                    ...prev,
                    {
                      role: "assistant",
                      text: data.ok
                        ? `✅ Article generated! SEO score: **${data.seoScore ?? "—"}/100** · ${data.wordCount ?? "?"} words · See full audit below.`
                        : `❌ Generation failed: ${data.error ?? "Unknown error"}`
                    }
                  ]);
                } catch (err: unknown) {
                  setAuditMessages((prev) => [
                    ...prev,
                    {
                      role: "assistant",
                      text: `❌ Request failed: ${errMsg(err)}`
                    }
                  ]);
                } finally {
                  setGenerating(false);
                }
              }}
              style={{
                padding: "0.625rem 1.25rem",
                background: generating ? "#6b7280" : "#7c3aed",
                color: "#fff",
                borderRadius: "0.5rem",
                fontWeight: 600,
                border: "none",
                cursor: generating ? "not-allowed" : "pointer",
                fontSize: "0.875rem",
                display: "flex",
                alignItems: "center",
                gap: "0.5rem",
                whiteSpace: "nowrap"
              }}
            >
              {generating ? (
                <>
                  <span
                    style={{
                      display: "inline-block",
                      width: "0.875rem",
                      height: "0.875rem",
                      border: "2px solid rgba(255,255,255,0.4)",
                      borderTopColor: "#fff",
                      borderRadius: "50%",
                      animation: "spin 0.7s linear infinite"
                    }}
                  />
                  Generating…
                </>
              ) : (
                "✨ Generate 1 Article & Audit"
              )}
            </button>
          </div>

          {/* Chat messages */}
          {auditMessages.length > 0 && (
            <div
              style={{
                display: "flex",
                flexDirection: "column",
                gap: "0.625rem"
              }}
            >
              {auditMessages.map((m, i) => (
                <div
                  key={i}
                  style={{
                    display: "flex",
                    gap: "0.625rem",
                    alignItems: "flex-start"
                  }}
                >
                  <div
                    style={{
                      width: "1.75rem",
                      height: "1.75rem",
                      borderRadius: "50%",
                      background:
                        m.role === "assistant" ? "#2563eb" : "#6b7280",
                      display: "flex",
                      alignItems: "center",
                      justifyContent: "center",
                      color: "#fff",
                      fontSize: "0.65rem",
                      fontWeight: 700,
                      flexShrink: 0,
                      marginTop: "0.125rem"
                    }}
                  >
                    {m.role === "assistant" ? "AI" : "You"}
                  </div>
                  <div
                    style={{
                      background:
                        m.role === "assistant" ? "#f0f9ff" : "#f9fafb",
                      border: `1px solid ${m.role === "assistant" ? "#bae6fd" : "#e5e7eb"}`,
                      borderRadius: "0.5rem",
                      padding: "0.5rem 0.75rem",
                      fontSize: "0.875rem",
                      color: "#111827",
                      lineHeight: 1.5,
                      flex: 1
                    }}
                  >
                    {m.text}
                  </div>
                </div>
              ))}

              {/* Full audit panel */}
              {auditResult && <AuditPanel result={auditResult} />}
            </div>
          )}
        </div>
        {/* CSS for spinner */}
        <style>{`@keyframes spin { to { transform: rotate(360deg); } }`}</style>

        {/* Published Article Log — structured table of last 50 published articles */}
        <PublishedArticleLogPanel state={state} />

        {/* Activity Log Errors — pinned filtered view of every level=error
            entry. Reads from state.activityLogErrors (a separate longer-
            retained buffer) so errors don't get evicted from the rolling
            200-row main activity log when info/warning traffic spikes. */}
        <LevelLogPanel
          state={state}
          level="error"
          title="Activity Log Errors"
          icon="❌"
          accentColor="#dc2626"
          emptyMessage="No errors yet — everything's healthy."
        />

        {/* Warnings — pinned filtered view of every level=warning entry. */}
        <LevelLogPanel
          state={state}
          level="warning"
          title="Warnings"
          icon="⚠️"
          accentColor="#d97706"
          emptyMessage="No warnings yet."
        />

        {/* Pipeline Diagrams */}
        <PipelineDiagrams state={state} />

        {/* Infrastructure Activity Monitor — live GitHub / OpenAI / Milvus feeds */}
        <InfrastructureActivityMonitorPanel />

        {/* GitHub Repo Agent — owns the gap between "merged to main" and "running in production" */}
        <GithubRepoAgentPanel state={state} />

        {/* Top Seller Scout — daily real-bestseller sweep (src/pipeline/top-seller-scout.ts) */}
        <TopSellerScoutPanel state={state} />

        {/* Legacy Scout — DataForSEO/AI/pool/variant category discovery (src/pipeline/scout.ts) */}
        <LegacyScoutPanel state={state} />

        {/* Coding Agent — autonomous repair loop (src/pipeline/escalate-to-claude.ts) */}
        <CodingAgentPanel state={state} />

        {/* Text Editor Agent — pipeline step 9.5, mechanical quality pass */}
        <TextEditorAgentPanel state={state} />

        {/* Editorial Agent — autonomous post-publish audit + rewrite loop (src/pipeline/editorial-agent.ts) */}
        <EditorialAgentPanel state={state} />

        {/* AI Observer — Kimi narrates worker state every 15 min (src/pipeline/observer-agent.ts) */}
        <ObserverAgentPanel state={state} />

        {/* Rankings — DataForSEO Labs ranked-keywords feedback loop. Data refreshes weekly per article; panel polls every 5 min. */}
        <RankingsPanel />

        {/* Improvement Agent — autonomous self-improvement loop (src/pipeline/improvement-agent.ts) */}
        <ImprovementAgentPanel state={state} />

        {/* API Activity Log — every outbound fetch the Worker makes (src/pipeline/api-logger.ts) */}
        <ApiActivityPanel state={state} />

        {/* n8n Workflow — outbound publish webhook + inbound /api/n8n/log status feed */}
        <N8nAgentPanel state={state} />

        {/* Activity Log */}
        <div
          style={{
            background: "#fff",
            borderRadius: "0.75rem",
            border: "1px solid #e5e7eb",
            padding: "1rem"
          }}
        >
          <div
            style={{
              display: "flex",
              alignItems: "center",
              justifyContent: "space-between",
              marginBottom: "0.75rem"
            }}
          >
            <h2
              style={{
                fontSize: "1.125rem",
                fontWeight: 600,
                color: "#111827",
                margin: 0
              }}
            >
              Activity Log
            </h2>
            <button
              onClick={() => {
                const entries = getActivityLogEntries(state)
                  .map(formatActivityEntry)
                  .join("\n");
                const legend =
                  getActivityLogSheetColumnLegendLines().join("\n");
                const text = `${entries}\n\n--- GOOGLE SHEET COLUMN MAP (same as row 1 headers) ---\n${legend}`;
                const writeText = navigator.clipboard?.writeText;
                if (!writeText) {
                  activityLogCopyButton.showStatus("Clipboard unavailable");
                  return;
                }
                void writeText(text)
                  .then(() => {
                    activityLogCopyButton.showStatus("Copied!");
                  })
                  .catch(() => {
                    activityLogCopyButton.showStatus("Copy failed");
                  });
              }}
              style={{
                padding: "0.375rem 0.75rem",
                background: "#f3f4f6",
                color: "#374151",
                borderRadius: "0.375rem",
                fontWeight: 500,
                fontSize: "0.8rem",
                border: "1px solid #e5e7eb",
                cursor: "pointer"
              }}
            >
              {activityLogCopyButton.label}
            </button>
          </div>
          <details
            style={{
              marginBottom: "0.75rem",
              fontSize: "0.75rem",
              color: "#6b7280",
              border: "1px solid #f3f4f6",
              borderRadius: "0.375rem",
              padding: "0.5rem 0.625rem",
              background: "#fafafa"
            }}
          >
            <summary
              style={{
                cursor: "pointer",
                userSelect: "none",
                fontWeight: 500,
                color: "#4b5563"
              }}
            >
              Google Sheet column map (read-only, same as row 1 headers)
            </summary>
            <pre
              style={{
                margin: "0.5rem 0 0",
                whiteSpace: "pre-wrap",
                fontFamily:
                  'ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, "Liberation Mono", "Courier New", monospace',
                fontSize: "0.7rem",
                lineHeight: 1.45,
                color: "#374151"
              }}
            >
              {getActivityLogSheetColumnLegendLines().join("\n")}
            </pre>
          </details>
          <div
            role="log"
            aria-live="polite"
            aria-relevant="additions"
            aria-atomic="false"
            aria-label="Pipeline activity log"
            style={{ maxHeight: "32rem", overflowY: "auto" }}
          >
            {activityLog.length === 0 && (
              <p
                style={{
                  fontSize: "0.875rem",
                  color: "#6b7280",
                  padding: "1rem",
                  textAlign: "center"
                }}
              >
                No activity yet. Click Start to begin.
              </p>
            )}
            {[...activityLog].reverse().map((entry) => (
              <ActivityLogRow key={entry.logRef} entry={entry} />
            ))}
          </div>
        </div>

        {/* Google Sheet */}
        <div
          style={{
            background: "#fff",
            borderRadius: "0.75rem",
            border: "1px solid #e5e7eb",
            padding: "1rem",
            marginTop: "1.5rem"
          }}
        >
          <div
            style={{
              display: "flex",
              alignItems: "center",
              justifyContent: "space-between",
              marginBottom: "0.75rem"
            }}
          >
            <h2
              style={{
                fontSize: "1.125rem",
                fontWeight: 600,
                color: "#111827",
                margin: 0
              }}
            >
              Shared Google Sheet
            </h2>
            {state.googleSheetUrl && (
              <a
                href={state.googleSheetUrl}
                target="_blank"
                rel="noopener noreferrer"
                style={{
                  fontSize: "0.8rem",
                  color: "#2563eb",
                  textDecoration: "underline"
                }}
              >
                Open in new tab
              </a>
            )}
          </div>

          <div
            style={{
              display: "flex",
              gap: "0.5rem",
              marginBottom: "0.75rem",
              flexWrap: "wrap"
            }}
          >
            <input
              value={sheetInput}
              onChange={(e) => setSheetInput(e.target.value)}
              placeholder="Paste Google Sheet URL"
              style={{
                flex: 1,
                minWidth: "18rem",
                padding: "0.5rem 0.625rem",
                border: "1px solid #d1d5db",
                borderRadius: "0.375rem",
                fontSize: "0.875rem"
              }}
            />
            <button
              onClick={() =>
                agent.stub
                  .setGoogleSheet({ url: sheetInput })
                  .then((result) =>
                    logDashboardControlResultError("setGoogleSheet", result)
                  )
                  .catch((error) =>
                    logDashboardControlError("setGoogleSheet", error)
                  )
              }
              style={{
                padding: "0.5rem 0.9rem",
                border: "none",
                borderRadius: "0.375rem",
                background: "#2563eb",
                color: "#fff",
                fontWeight: 600,
                cursor: "pointer",
                fontSize: "0.85rem"
              }}
            >
              Save Sheet
            </button>
            <button
              type="button"
              title="Rewrite row 1 headers for columns A–M and BU–BV to match the activity log layout"
              onClick={() =>
                agent.stub
                  .syncActivityLogSheetHeaders()
                  .then((r) => {
                    const errorMessage = getResultErrorMessage(r);
                    if (errorMessage) {
                      logDashboardControlError(
                        "syncActivityLogSheetHeaders",
                        errorMessage
                      );
                    }
                  })
                  .catch((error) =>
                    logDashboardControlError(
                      "syncActivityLogSheetHeaders",
                      error
                    )
                  )
              }
              disabled={!state.googleSheetUrl}
              style={{
                padding: "0.5rem 0.9rem",
                border: "1px solid #d1d5db",
                borderRadius: "0.375rem",
                background: "#fff",
                color: "#374151",
                fontWeight: 600,
                cursor: state.googleSheetUrl ? "pointer" : "not-allowed",
                fontSize: "0.85rem",
                opacity: state.googleSheetUrl ? 1 : 0.5
              }}
            >
              Sync headers
            </button>
            <button
              type="button"
              title='Creates tab "Scout keyword ROI" if needed and writes A1:L1 plus ROI formulas in G2, J2, K2'
              onClick={() =>
                agent.stub
                  .syncScoutKeywordRoiSheet()
                  .then((r) => {
                    const errorMessage = getResultErrorMessage(r);
                    if (errorMessage) {
                      logDashboardControlError(
                        "syncScoutKeywordRoiSheet",
                        errorMessage
                      );
                    }
                  })
                  .catch((error) =>
                    logDashboardControlError("syncScoutKeywordRoiSheet", error)
                  )
              }
              disabled={!state.googleSheetUrl}
              style={{
                padding: "0.5rem 0.9rem",
                border: "1px solid #d1d5db",
                borderRadius: "0.375rem",
                background: "#fff",
                color: "#374151",
                fontWeight: 600,
                cursor: state.googleSheetUrl ? "pointer" : "not-allowed",
                fontSize: "0.85rem",
                opacity: state.googleSheetUrl ? 1 : 0.5
              }}
            >
              Scout ROI tab
            </button>
          </div>

          {(state.recentGoogleSheets || []).length > 0 && (
            <div style={{ marginBottom: "0.75rem" }}>
              <div
                style={{
                  fontSize: "0.8rem",
                  color: "#6b7280",
                  marginBottom: "0.4rem"
                }}
              >
                Recent Google Sheets
              </div>
              <div style={{ display: "grid", gap: "0.4rem" }}>
                {(state.recentGoogleSheets || []).map((sheet) => (
                  <div
                    key={sheet.url}
                    style={{
                      display: "flex",
                      alignItems: "center",
                      gap: "0.5rem",
                      padding: "0.35rem 0.5rem",
                      background: "#f9fafb",
                      border: "1px solid #f3f4f6",
                      borderRadius: "0.375rem"
                    }}
                  >
                    <button
                      onClick={() =>
                        agent.stub
                          .useRecentGoogleSheet({
                            url: sheet.url
                          })
                          .then((result) =>
                            logDashboardControlResultError(
                              "useRecentGoogleSheet",
                              result
                            )
                          )
                          .catch((error) =>
                            logDashboardControlError(
                              "useRecentGoogleSheet",
                              error
                            )
                          )
                      }
                      style={{
                        border: "none",
                        background: "transparent",
                        color: "#2563eb",
                        textDecoration: "underline",
                        cursor: "pointer",
                        padding: 0,
                        fontSize: "0.8rem",
                        textAlign: "left",
                        flex: 1,
                        overflow: "hidden",
                        textOverflow: "ellipsis",
                        whiteSpace: "nowrap"
                      }}
                      title={sheet.url}
                    >
                      {sheet.url}
                    </button>
                    <button
                      onClick={() =>
                        agent.stub
                          .removeRecentGoogleSheet({ url: sheet.url })
                          .then((result) =>
                            logDashboardControlResultError(
                              "removeRecentGoogleSheet",
                              result
                            )
                          )
                          .catch((error) =>
                            logDashboardControlError(
                              "removeRecentGoogleSheet",
                              error
                            )
                          )
                      }
                      style={{
                        border: "1px solid #e5e7eb",
                        background: "#fff",
                        color: "#6b7280",
                        borderRadius: "0.3rem",
                        cursor: "pointer",
                        fontSize: "0.75rem",
                        padding: "0.2rem 0.4rem"
                      }}
                    >
                      Remove
                    </button>
                  </div>
                ))}
              </div>
            </div>
          )}

          {state.googleSheetUrl ? (
            <SheetEmbed url={state.googleSheetUrl} />
          ) : (
            <p
              style={{
                margin: 0,
                color: "#6b7280",
                fontSize: "0.875rem",
                lineHeight: 1.5
              }}
            >
              Add a Google Sheet URL above and click <b>Save Sheet</b>. It will
              be persisted and shown in your recent sheets list.
            </p>
          )}

          {/* Sheet Bridge Activity */}
          <div
            style={{
              marginTop: "1rem",
              border: "1px solid #e5e7eb",
              borderRadius: "0.5rem",
              padding: "0.75rem",
              background: "#fff"
            }}
          >
            <div
              style={{
                display: "flex",
                alignItems: "center",
                justifyContent: "space-between",
                marginBottom: "0.5rem"
              }}
            >
              <h3
                style={{
                  margin: 0,
                  fontSize: "0.95rem",
                  fontWeight: 600,
                  color: "#111827"
                }}
              >
                Sheet Bridge Activity
              </h3>
              <button
                onClick={() => {
                  const text = (state.sheetBridgeLog || [])
                    .map(
                      (e, idx) =>
                        `${String(idx + 1).padStart(3, " ")}. [${e.time}] [${e.status.toUpperCase()}] ${e.msg}`
                    )
                    .join("\n");
                  const writeText = navigator.clipboard?.writeText;
                  if (!writeText) {
                    sheetBridgeCopyButton.showStatus("Clipboard unavailable");
                    return;
                  }
                  void writeText(text)
                    .then(() => {
                      sheetBridgeCopyButton.showStatus("Copied!");
                    })
                    .catch(() => {
                      sheetBridgeCopyButton.showStatus("Copy failed");
                    });
                }}
                style={{
                  padding: "0.3rem 0.6rem",
                  background: "#f3f4f6",
                  color: "#374151",
                  borderRadius: "0.375rem",
                  fontWeight: 500,
                  fontSize: "0.75rem",
                  border: "1px solid #e5e7eb",
                  cursor: "pointer"
                }}
              >
                {sheetBridgeCopyButton.label}
              </button>
            </div>
            <div
              style={{
                maxHeight: "12rem",
                overflowY: "auto",
                fontSize: "0.8rem"
              }}
            >
              {(state.sheetBridgeLog || []).length === 0 && (
                <p
                  style={{
                    margin: 0,
                    color: "#9ca3af",
                    padding: "0.5rem 0.25rem"
                  }}
                >
                  No sheet bridge activity yet.
                </p>
              )}
              {[...(state.sheetBridgeLog || [])]
                .reverse()
                .map((entry, i, entries) => {
                  const originalIndex = entries.length - 1 - i;
                  return (
                    <div
                      key={`${entry.time}:${originalIndex}`}
                      style={{
                        display: "flex",
                        gap: "0.5rem",
                        padding: "0.3rem 0",
                        borderBottom: "1px solid #f9fafb"
                      }}
                    >
                      <span
                        style={{
                          color: "#9ca3af",
                          fontFamily: "monospace",
                          whiteSpace: "nowrap"
                        }}
                      >
                        {entry.time}
                      </span>
                      <span
                        style={{
                          color:
                            entry.status === "success"
                              ? "#059669"
                              : entry.status === "skipped"
                                ? "#d97706"
                                : "#dc2626",
                          fontWeight: 600,
                          textTransform: "uppercase",
                          whiteSpace: "nowrap"
                        }}
                      >
                        {entry.status}
                      </span>
                      <span style={{ color: "#374151" }}>{entry.msg}</span>
                    </div>
                  );
                })}
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

function linkify(text: string) {
  const parts = text.split(/(https?:\/\/[^\s)]+)/g);
  if (parts.length === 1) return text;
  return parts.map((part, i) =>
    /^https?:\/\//.test(part) ? (
      <a
        key={i}
        href={part}
        target="_blank"
        rel="noopener noreferrer"
        style={{ color: "#2563eb", textDecoration: "underline" }}
      >
        {part}
      </a>
    ) : (
      part
    )
  );
}

function StatCard({ label, value }: { label: string; value: number | string }) {
  return (
    <div
      style={{
        background: "#fff",
        borderRadius: "0.75rem",
        border: "1px solid #e5e7eb",
        padding: "1rem"
      }}
    >
      <div
        style={{
          fontSize: "1.5rem",
          fontWeight: 700,
          color: "#111827"
        }}
      >
        {value}
      </div>
      <div
        style={{
          fontSize: "0.875rem",
          color: "#6b7280",
          marginTop: "0.25rem"
        }}
      >
        {label}
      </div>
    </div>
  );
}

// Editorial rewrite-loop row — surfaces "is the post-publish self-
// improvement loop actually working?" without curl. Mirrored from KV
// into DO state by `incrementEditorialStat` in
// src/pipeline/editorial-stats.ts; counters are lifetime since the
// current DO instance started (resetAt). Same StatCard styling as the
// row above for visual continuity.
// ExternalProviderHealthBanner — multi-provider derivation from the
// live activity log. One card per degraded provider, hidden when
// everything is OK. Each row carries an operator-actionable remediation
// link (top-up, credential rotation, etc.) keyed to the specific
// failure pattern detected. Pure derivation — no new state, endpoint,
// or scheduled tick. Computation tested in
// src/__tests__/external-provider-health.test.ts.
function ExternalProviderHealthBanner({ state }: { state: SEOAgentState }) {
  const log = getActivityLogEntries(state);
  const degraded = degradedProviders(log);
  if (degraded.length === 0) return null;
  return (
    <div style={{ marginBottom: "1rem" }}>
      {degraded.map((p) => {
        const exhausted = p.tier === "exhausted";
        const palette = exhausted
          ? { bg: "#fee2e2", border: "#fca5a5", fg: "#7f1d1d", emoji: "🚨" }
          : { bg: "#fef3c7", border: "#fcd34d", fg: "#78350f", emoji: "⚠️" };
        return (
          <div
            key={p.id}
            style={{
              background: palette.bg,
              border: `1px solid ${palette.border}`,
              color: palette.fg,
              borderRadius: "0.5rem",
              padding: "0.75rem 1rem",
              marginBottom: "0.5rem",
              fontSize: "0.875rem",
              display: "flex",
              alignItems: "center",
              gap: "0.75rem",
              lineHeight: 1.4
            }}
            role="status"
          >
            <span style={{ fontSize: "1.25rem", flexShrink: 0 }}>
              {palette.emoji}
            </span>
            <div>
              <div style={{ fontWeight: 600 }}>
                {p.label} — {exhausted ? "exhausted" : "degraded"}
              </div>
              <div style={{ fontSize: "0.8125rem", marginTop: "0.125rem" }}>
                {p.evidence}. {p.remediation}
                {p.remediationUrl ? (
                  <>
                    {" — "}
                    <a
                      href={p.remediationUrl}
                      target="_blank"
                      rel="noopener"
                      style={{
                        color: palette.fg,
                        textDecoration: "underline"
                      }}
                    >
                      {p.remediationUrl.replace(/^https?:\/\//, "")}
                    </a>
                  </>
                ) : (
                  ""
                )}
                .
              </div>
            </div>
          </div>
        );
      })}
    </div>
  );
}

function EditorialStatsRow({ state }: { state: SEOAgentState }) {
  const s = state.editorialStats;
  // Hide the row entirely until the DO instance has hydrated the
  // counters at least once — avoids showing meaningless zeros on a
  // brand-new isolate while the first article is still mid-publish.
  if (!s) return null;
  const attempted = s.success + s.fail;
  const successRate =
    attempted > 0 ? Math.round((s.success / attempted) * 100) : null;
  const topReasons = Object.entries(s.reasons)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 3);
  // Count Kimi calls in the rolling activity log as a cost proxy.
  // Real $ figures need the OpenRouter / AI Gateway billing API —
  // separate PR. The proxy is meaningful: each call is roughly the
  // same cost band.
  const kimiCalls = (state.activityLog ?? []).filter((e) => {
    const msg = e.msg ?? "";
    return (
      msg.includes("[kimi-model]") ||
      msg.includes("rewriting article to address") ||
      msg.includes("retrying rewrite")
    );
  }).length;
  return (
    <div style={{ marginBottom: "1.5rem" }}>
      <div
        style={{
          display: "grid",
          gridTemplateColumns: "repeat(4, 1fr)",
          gap: "1rem",
          marginBottom: topReasons.length > 0 ? "0.5rem" : 0
        }}
      >
        <StatCard label="Editorial Success" value={s.success} />
        <StatCard label="Editorial Rejected" value={s.fail} />
        <StatCard
          label="Editorial Success %"
          value={successRate !== null ? `${successRate}%` : "—"}
        />
        <StatCard label="Kimi calls (live buffer)" value={kimiCalls} />
      </div>
      {topReasons.length > 0 && (
        <div
          style={{
            background: "#fff",
            borderRadius: "0.5rem",
            border: "1px solid #e5e7eb",
            padding: "0.5rem 0.75rem",
            fontSize: "0.8125rem",
            color: "#6b7280"
          }}
        >
          <span style={{ fontWeight: 600, color: "#374151" }}>
            Top editorial rejection reasons:
          </span>{" "}
          {topReasons.map(([reason, count], i) => (
            <span key={reason}>
              <code style={{ color: "#111827" }}>{reason}</code>{" "}
              <span style={{ color: "#9ca3af" }}>×{count}</span>
              {i < topReasons.length - 1 ? " · " : ""}
            </span>
          ))}
        </div>
      )}
      {/*
        Skip-reason breakdown. Without this row, a clean skip
        (`no-actionable-fixes`) was indistinguishable on the panel from
        a degraded run (`kimi-audit-partial-fail`). The latter is
        operationally important — it means the audit lane is degrading
        but not yet at the full-failure threshold that flips outcomes to
        `fail`. Empty histogram → nothing renders (typical first hours
        after a DO restart).
      */}
      {(() => {
        const topSkipReasons = Object.entries(s.skipReasons ?? {})
          .sort((a, b) => b[1] - a[1])
          .slice(0, 3);
        if (topSkipReasons.length === 0) return null;
        return (
          <div
            style={{
              background: "#fff",
              borderRadius: "0.5rem",
              border: "1px solid #e5e7eb",
              padding: "0.5rem 0.75rem",
              fontSize: "0.8125rem",
              color: "#6b7280",
              marginTop: "0.5rem"
            }}
          >
            <span style={{ fontWeight: 600, color: "#374151" }}>
              Top editorial skip reasons:
            </span>{" "}
            {topSkipReasons.map(([reason, count], i) => (
              <span key={reason}>
                <code style={{ color: "#111827" }}>{reason}</code>{" "}
                <span style={{ color: "#9ca3af" }}>×{count}</span>
                {i < topSkipReasons.length - 1 ? " · " : ""}
              </span>
            ))}
          </div>
        );
      })()}
    </div>
  );
}

// ── Pipeline Diagrams ────────────────────────────────────────────────────────

function buildPipelineFlowDiagram(currentStep: string | null): string {
  // Mark the active step with a highlight style
  const step = currentStep || "";
  const active = (label: string) =>
    step.toLowerCase().includes(label.toLowerCase()) ? ":::active" : "";

  return `flowchart TD
    classDef active fill:#2563eb,color:#fff,stroke:#1d4ed8
    classDef fail fill:#dc2626,color:#fff,stroke:#b91c1c
    classDef done fill:#059669,color:#fff,stroke:#047857

    A([🔍 Scout Keywords])${active("scout")}
    B([🛒 Amazon Products])${active("amazon")}
    C([🤖 AI Writing])${active("writing")}
    D([📊 SEO Score])${active("seo score")}
    E([🎨 Design Audit])${active("design")}
    F([🔎 QC Agent])${active("qc")}
    G([✨ Polish Agent])${active("polish")}
    H([🌐 Live SEO])${active("live seo")}
    I([🗺️ Sitemap])${active("sitemap")}
    J([📡 IndexNow])${active("indexnow")}
    K([💾 KV Save])${active("kv")}
    GATE{Word Count Gate}
    FAIL([❌ Failed]):::fail
    PUB([✅ Published]):::done

    A --> B --> C --> GATE
    GATE -->|Pass| D
    GATE -->|Fail| FAIL
    D --> E --> F --> G --> H --> I --> J --> K --> PUB`;
}

function buildStatusDiagram(status: string): string {
  const isIdle = status === "idle";
  const isScouting = status === "scouting";
  const isGenerating = status === "generating";
  const isPaused = status === "paused";

  const style = (active: boolean, color: string) =>
    active
      ? `fill:${color},color:#fff,stroke:none`
      : "fill:#f3f4f6,color:#374151,stroke:#e5e7eb";

  return `flowchart LR
    IDLE([💤 Idle])
    SCOUT([🔍 Scouting])
    GEN([⚙️ Generating])
    PAUSE([⏸️ Paused])

    IDLE --> |Start| SCOUT
    SCOUT --> |Keywords ready| GEN
    GEN --> |Stop| PAUSE
    PAUSE --> |Start| GEN
    GEN --> |All done| IDLE

    style IDLE ${style(isIdle, "#6b7280")}
    style SCOUT ${style(isScouting, "#d97706")}
    style GEN ${style(isGenerating, "#2563eb")}
    style PAUSE ${style(isPaused, "#7c3aed")}`;
}

function buildProgressDiagram(
  articlesGenerated: number,
  articlesFailed: number,
  categoriesCompleted: number,
  avgSeoScore: number
): string {
  // xychart-beta is available in mermaid v10+
  return `xychart-beta
    title "Article Outcomes"
    x-axis ["Published", "Failed", "Categories", "Avg SEO"]
    bar [${articlesGenerated}, ${articlesFailed}, ${categoriesCompleted}, ${avgSeoScore}]`;
}

// ── Coding Agent Panel ────────────────────────────────────────────────────────
//
// Surfaces the autonomous repair loop's activity in a distinct dashboard
// window. The worker escalates every failed-article failure mode through
// `src/pipeline/escalate-to-claude.ts`, which logs under activeRole
// "codingAgent" AND opens a GitHub issue labeled `claude-fix`. The worker
// then assigns Copilot Coding Agent on that issue, which opens the fix PR.
//
// The panel shows the last 20 `codingAgent` log entries, newest first:
//   ✅ "opened issue #…" — parsed into structured row with clickable link
//   ℹ️ "deduped …"      — secondary row
//   ⚠️ "issue POST …"   — warnings/errors, kept verbatim so operators see
//                          when the escalation itself failed
//
// Reads `state.activityLog` which is already synced to the client via the
// Agents SDK — no extra RPC or API call.

const JSON_STRING_RE = '"(?:\\\\.|[^"\\\\])*"';
const CODING_AGENT_OPEN_RE = new RegExp(
  `^Coding Agent: opened issue (?:#(\\d+)|\\(unknown #\\)) for ([\\w-]+) on (${JSON_STRING_RE})(?:\\s+—\\s+(https?:\\/\\/\\S+))?$`
);
function parseActivityLogKeyword(rawKeywordJson: string): string {
  const normalizeKeywordForDisplay = (value: string): string => {
    const normalized = normalizeSingleLine(value);
    return normalized || "(empty keyword)";
  };
  const decodeJsonStringEscapes = (value: string): string =>
    value
      .replace(/\\u([0-9a-fA-F]{4})/g, (_, hex: string) =>
        String.fromCharCode(Number.parseInt(hex, 16))
      )
      .replace(
        /\\(["\\/bfnrt])/g,
        (_, token: string) =>
          (
            ({
              '"': '"',
              "\\": "\\",
              "/": "/",
              b: "\b",
              f: "\f",
              n: "\n",
              r: "\r",
              t: "\t"
            }) as const
          )[token] ?? token
      );
  const parsed = parseJsonStringValue(rawKeywordJson);
  if (typeof parsed === "string") {
    return normalizeKeywordForDisplay(parsed);
  }
  if (
    rawKeywordJson.startsWith('"') &&
    rawKeywordJson.endsWith('"') &&
    rawKeywordJson.length >= 2
  ) {
    return normalizeKeywordForDisplay(
      decodeJsonStringEscapes(rawKeywordJson.slice(1, -1))
    );
  }
  return normalizeKeywordForDisplay(rawKeywordJson);
}

// ── GitHub Repo Agent Panel ───────────────────────────────────────────────────
//
// Owns the gap between "Copilot PR merged to main" and "new code is running
// in production with no regression". Runs as a GitHub Action
// (`.github/workflows/repo-agent.yml`) on 4 triggers:
//
//   1. workflow_run: Deploy completed — verify success, fix failures.
//   2. schedule: every 15 min — post-deploy regression watchdog, stale-PR
//      sweep, cross-issue duplicate consolidation.
//   3. issues.opened — cross-keyword dedup within same errorCategory.
//   4. workflow_dispatch — manual kick.
//
// Every action the workflow takes POSTs to /api/admin/log-repo-agent on the
// live worker with a bearer token, so the run shows up here under role
// `repoAgent`. Messages look like:
//   "Deploy ok 0c94fb8 — no regression in 10min (#145)"
//   "Deploy failed 3be84d7 — route conflict, Copilot assigned to #156"
//   "Closed #133 #134 as duplicate of #143"
//   "Regression detected on 0c94fb8 — failure rate 8→34/hr, opened #160"
//   "Secret rotation needed: ANTHROPIC_API_KEY (401 in logs)"
//
// Mirror of CodingAgentPanel: native <details>, scrollable list, clickable
// links parsed out of structured messages.
const REPO_AGENT_MSG_RE =
  /(?:Deploy (?:ok|failed)|Closed|Regression|Secret rotation|Stale PR|PR merged|PR closed)\b/i;
const REPO_AGENT_PR_REF_RE = /#(\d+)\b/;
const REPO_AGENT_SHA_RE = /\b([0-9a-f]{7,40})\b/;
function GithubRepoAgentPanel({ state }: { state: SEOAgentState }) {
  const entries = [...getActivityLogEntries(state)]
    .filter((e) => e.activeRole === "repoAgent")
    .reverse()
    .slice(0, 50);

  const actionCount = entries.filter(
    (e) =>
      REPO_AGENT_MSG_RE.test(e.msg ?? "") && !isActivityLogErrorLevel(e.level)
  ).length;

  return (
    <details
      open
      style={{
        background: "#fff",
        borderRadius: "0.75rem",
        border: "1px solid #e5e7eb",
        padding: "1rem",
        marginBottom: "1rem"
      }}
    >
      <summary
        style={{
          cursor: "pointer",
          userSelect: "none",
          listStyle: "none",
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
          gap: "0.75rem"
        }}
      >
        <div>
          <h2
            style={{
              fontSize: "1.125rem",
              fontWeight: 600,
              color: "#111827",
              margin: 0,
              display: "flex",
              alignItems: "center",
              gap: "0.5rem"
            }}
          >
            <span>🐙</span>
            <span>GitHub Repo Agent</span>
          </h2>
          <p
            style={{
              margin: "0.25rem 0 0",
              fontSize: "0.8125rem",
              color: "#6b7280"
            }}
          >
            Verifies that commits merged to{" "}
            <code
              style={{
                background: "#f3f4f6",
                padding: "0 0.25rem",
                borderRadius: "0.25rem"
              }}
            >
              main
            </code>{" "}
            actually deploy + stay green. Fixes failed deploys, closes duplicate
            Copilot PRs, watches for post-deploy regressions, and sweeps stale
            branches. Fires on{" "}
            <code
              style={{
                background: "#f3f4f6",
                padding: "0 0.25rem",
                borderRadius: "0.25rem"
              }}
            >
              workflow_run: Deploy
            </code>{" "}
            + 15-min cron.
          </p>
        </div>
        <div
          style={{
            fontSize: "0.75rem",
            color: "#6b7280",
            whiteSpace: "nowrap",
            display: "flex",
            flexDirection: "column",
            alignItems: "flex-end",
            gap: "0.125rem"
          }}
        >
          <span>
            {actionCount > 0
              ? `${actionCount} recent action${actionCount === 1 ? "" : "s"}`
              : "idle"}
          </span>
          <span style={{ color: "#9ca3af" }}>click to collapse</span>
        </div>
      </summary>

      <div
        style={{
          marginTop: "0.75rem",
          height: "360px",
          overflowY: "auto",
          paddingRight: "0.25rem",
          background: "#fafafa",
          borderRadius: "0.5rem"
        }}
      >
        {entries.length === 0 ? (
          <div
            style={{
              height: "100%",
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              padding: "1.25rem",
              color: "#6b7280",
              fontSize: "0.875rem",
              textAlign: "center"
            }}
          >
            <span>
              Repo Agent is idle — no deploys to verify yet. First activity
              appears after the next{" "}
              <code
                style={{
                  background: "#f3f4f6",
                  padding: "0 0.25rem",
                  borderRadius: "0.25rem"
                }}
              >
                Deploy
              </code>{" "}
              workflow completes.
            </span>
          </div>
        ) : (
          <div
            style={{
              display: "flex",
              flexDirection: "column",
              gap: "0.5rem",
              padding: "0.5rem"
            }}
          >
            {entries.map((entry) => {
              const msg = entry.msg ?? "";
              const isError = isActivityLogErrorLevel(entry.level);
              const isWarning = isActivityLogWarningLevel(entry.level);
              const accent = isError
                ? "#dc2626"
                : isWarning
                  ? "#d97706"
                  : /Deploy ok|merged/i.test(msg)
                    ? "#059669"
                    : "#6b7280";
              const prMatch = REPO_AGENT_PR_REF_RE.exec(msg);
              const shaMatch = REPO_AGENT_SHA_RE.exec(msg);
              return (
                <div
                  key={entry.logRef}
                  style={{
                    padding: "0.625rem 0.75rem",
                    background: "#f9fafb",
                    borderLeft: `3px solid ${accent}`,
                    borderRadius: "0.25rem",
                    fontSize: "0.8125rem",
                    color: "#111827"
                  }}
                >
                  <div
                    style={{
                      display: "flex",
                      gap: "0.75rem",
                      alignItems: "baseline",
                      flexWrap: "wrap"
                    }}
                  >
                    <span
                      style={{
                        fontFamily: "ui-monospace, monospace",
                        fontSize: "0.75rem",
                        color: "#6b7280"
                      }}
                    >
                      {entry.timeDate} {entry.timeTime}
                    </span>
                    <span
                      style={{
                        color: isError
                          ? "#b91c1c"
                          : isWarning
                            ? "#92400e"
                            : "#111827"
                      }}
                    >
                      {msg}
                    </span>
                  </div>
                  {(prMatch || shaMatch) && (
                    <div
                      style={{
                        marginTop: "0.25rem",
                        fontSize: "0.75rem",
                        color: "#6b7280",
                        display: "flex",
                        gap: "0.75rem"
                      }}
                    >
                      {prMatch && (
                        <a
                          href={`https://github.com/techfundoffice/cats-seo-aiagent-cloudflare/pull/${prMatch[1]}`}
                          target="_blank"
                          rel="noopener noreferrer"
                          style={{
                            color: "#2563eb",
                            textDecoration: "underline",
                            fontFamily: "ui-monospace, monospace"
                          }}
                        >
                          PR #{prMatch[1]} ↗
                        </a>
                      )}
                      {shaMatch && (
                        <a
                          href={`https://github.com/techfundoffice/cats-seo-aiagent-cloudflare/commit/${shaMatch[1]}`}
                          target="_blank"
                          rel="noopener noreferrer"
                          style={{
                            color: "#2563eb",
                            textDecoration: "underline",
                            fontFamily: "ui-monospace, monospace"
                          }}
                        >
                          {shaMatch[1].slice(0, 7)} ↗
                        </a>
                      )}
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        )}
      </div>
    </details>
  );
}

// ── Role-filtered activity panel (shared) ───────────────────────────────────
//
// Generic version of GithubRepoAgentPanel's structure, without the
// PR-number/commit-SHA link parsing that panel needs and these two don't.
// Backs both TopSellerScoutPanel and LegacyScoutPanel below — same
// `activityLog.filter((e) => e.activeRole === role)` pattern used by every
// other role-scoped dashboard panel (repoAgent, codingAgent, textEditorAgent,
// improvementAgent, apiCall, editorialAgent, n8n).
function RoleActivityPanel({
  state,
  activeRole,
  icon,
  title,
  description,
  emptyMessage
}: {
  state: SEOAgentState;
  activeRole: AgentRole;
  icon: string;
  title: string;
  description: ReactNode;
  emptyMessage: string;
}) {
  const entries = [...getActivityLogEntries(state)]
    .filter((e) => e.activeRole === activeRole)
    .reverse()
    .slice(0, 50);

  const actionCount = entries.filter(
    (e) => !isActivityLogErrorLevel(e.level)
  ).length;

  return (
    <details
      open
      style={{
        background: "#fff",
        borderRadius: "0.75rem",
        border: "1px solid #e5e7eb",
        padding: "1rem",
        marginBottom: "1rem"
      }}
    >
      <summary
        style={{
          cursor: "pointer",
          userSelect: "none",
          listStyle: "none",
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
          gap: "0.75rem"
        }}
      >
        <div>
          <h2
            style={{
              fontSize: "1.125rem",
              fontWeight: 600,
              color: "#111827",
              margin: 0,
              display: "flex",
              alignItems: "center",
              gap: "0.5rem"
            }}
          >
            <span>{icon}</span>
            <span>{title}</span>
          </h2>
          <p
            style={{
              margin: "0.25rem 0 0",
              fontSize: "0.8125rem",
              color: "#6b7280"
            }}
          >
            {description}
          </p>
        </div>
        <div
          style={{
            fontSize: "0.75rem",
            color: "#6b7280",
            whiteSpace: "nowrap",
            display: "flex",
            flexDirection: "column",
            alignItems: "flex-end",
            gap: "0.125rem"
          }}
        >
          <span>
            {actionCount > 0
              ? `${actionCount} recent action${actionCount === 1 ? "" : "s"}`
              : "idle"}
          </span>
          <span style={{ color: "#9ca3af" }}>click to collapse</span>
        </div>
      </summary>

      <div
        style={{
          marginTop: "0.75rem",
          height: "360px",
          overflowY: "auto",
          paddingRight: "0.25rem",
          background: "#fafafa",
          borderRadius: "0.5rem"
        }}
      >
        {entries.length === 0 ? (
          <div
            style={{
              height: "100%",
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              padding: "1.25rem",
              color: "#6b7280",
              fontSize: "0.875rem",
              textAlign: "center"
            }}
          >
            <span>{emptyMessage}</span>
          </div>
        ) : (
          <div
            style={{
              display: "flex",
              flexDirection: "column",
              gap: "0.5rem",
              padding: "0.5rem"
            }}
          >
            {entries.map((entry) => {
              const msg = entry.msg ?? "";
              const isError = isActivityLogErrorLevel(entry.level);
              const isWarning = isActivityLogWarningLevel(entry.level);
              const accent = isError
                ? "#dc2626"
                : isWarning
                  ? "#d97706"
                  : "#6b7280";
              return (
                <div
                  key={entry.logRef}
                  style={{
                    padding: "0.625rem 0.75rem",
                    background: "#f9fafb",
                    borderLeft: `3px solid ${accent}`,
                    borderRadius: "0.25rem",
                    fontSize: "0.8125rem",
                    color: "#111827"
                  }}
                >
                  <div
                    style={{
                      display: "flex",
                      gap: "0.75rem",
                      alignItems: "baseline",
                      flexWrap: "wrap"
                    }}
                  >
                    <span
                      style={{
                        fontFamily: "ui-monospace, monospace",
                        fontSize: "0.75rem",
                        color: "#6b7280"
                      }}
                    >
                      {entry.timeDate} {entry.timeTime}
                    </span>
                    <span
                      style={{
                        color: isError
                          ? "#b91c1c"
                          : isWarning
                            ? "#92400e"
                            : "#111827"
                      }}
                    >
                      {msg}
                    </span>
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </div>
    </details>
  );
}

// Top Seller Scout — daily sweep of the 18 fixed Amazon browse-node
// categories for real bestsellers (src/pipeline/top-seller-scout.ts).
// Separate panel from Legacy Scout below so an operator can tell at a
// glance which of the two scouting mechanisms produced a given category —
// they previously shared the generic "orchestrator"/"analyst" roles with
// unrelated pipeline messages and weren't distinguishable at all.
function TopSellerScoutPanel({ state }: { state: SEOAgentState }) {
  return (
    <RoleActivityPanel
      state={state}
      activeRole="topSellerScout"
      icon="🏆"
      title="Top Seller Scout"
      description={
        <>
          Daily sweep of 18 fixed Amazon Pet Supplies &gt; Cats browse-node
          categories via real PA API bestseller data — grounds category
          selection in actual Amazon demand instead of guessed ROI scoring. Only
          acts on genuinely new/changed bestsellers day over day.
        </>
      }
      emptyMessage="Top Seller Scout is idle — first activity appears after the next daily sweep runs."
    />
  );
}

// Legacy Scout — the original DataForSEO / AI / hardcoded-pool / slug-
// variant category discovery chain (src/pipeline/scout.ts,
// scoutHighTicketCategory). Continues running unconditionally in the gaps
// between Top Seller Scout's daily sweeps.
function LegacyScoutPanel({ state }: { state: SEOAgentState }) {
  return (
    <RoleActivityPanel
      state={state}
      activeRole="legacyScout"
      icon="🧭"
      title="Legacy Scout"
      description={
        <>
          Original category-discovery chain: DataForSEO Labs keyword volume →
          Workers AI ROI scoring → hardcoded pool → slug-variant expansion.
          Fills the gaps between Top Seller Scout's daily sweeps.
        </>
      }
      emptyMessage="Legacy Scout is idle — no category discovery activity yet."
    />
  );
}

// Entry age from the log timestamps ("07/22/2026" + "12:01:00"); null when
// unparseable so callers can skip age treatment rather than mislabel.
function activityEntryAgeMs(entry: {
  timeDate?: string;
  timeTime?: string;
}): number | null {
  const parsed = Date.parse(
    `${entry.timeDate ?? ""} ${entry.timeTime ?? ""}`.trim()
  );
  return Number.isFinite(parsed) ? Math.max(0, Date.now() - parsed) : null;
}

function formatActivityAge(ms: number): string {
  const hours = ms / 3_600_000;
  if (hours < 1) return `${Math.max(1, Math.round(ms / 60_000))}m`;
  if (hours < 24) return `${Math.round(hours)}h`;
  return `${Math.round(hours / 24)}d`;
}

// Filtered slice of the activity log for one severity level. Reuses
// <ActivityLogRow> so per-row copy buttons + memoization come for free, and
// guarantees zero drift from the main Activity Log's row format. One
// component drives both Warnings and Errors panels.
function LevelLogPanel({
  state,
  level,
  title,
  icon,
  accentColor,
  emptyMessage
}: {
  state: SEOAgentState;
  level: "warning" | "error";
  title: string;
  icon: string;
  accentColor: string;
  emptyMessage: string;
}) {
  // Errors panel reads from the dedicated `activityLogErrors` buffer (200-
  // entry FIFO retained independently of the rolling 200-row main log) so
  // real failures stay visible after info/warning chatter pushes their
  // originals out of `activityLog`. Warnings panel reads the live main log
  // as before (warnings are noisy and don't need long-term retention).
  // Entries older than 24h render dimmed (server also expires errors after
  // 7 days), and the errors panel has a Clear button so a fixed incident
  // doesn't haunt the dashboard until 200 newer errors evict it.
  const source =
    level === "error"
      ? sanitizeActivityLogEntries(state.activityLogErrors)
      : getActivityLogEntries(state);
  const entries = [...source]
    .filter((e) =>
      level === "warning"
        ? isActivityLogWarningLevel(e.level)
        : isActivityLogErrorLevel(e.level)
    )
    .reverse()
    .slice(0, 100);

  return (
    <details
      open
      style={{
        background: "#fff",
        borderRadius: "0.75rem",
        border: "1px solid #e5e7eb",
        borderLeft: `3px solid ${accentColor}`,
        padding: "1rem",
        marginBottom: "1rem"
      }}
    >
      <summary
        style={{
          cursor: "pointer",
          userSelect: "none",
          listStyle: "none",
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
          gap: "0.75rem"
        }}
      >
        <h2
          style={{
            fontSize: "1.125rem",
            fontWeight: 600,
            color: "#111827",
            margin: 0,
            display: "flex",
            alignItems: "center",
            gap: "0.5rem"
          }}
        >
          <span aria-hidden="true">{icon}</span>
          <span>{title}</span>
          <span
            aria-label={`${entries.length} ${level} entries`}
            style={{
              fontSize: "0.75rem",
              fontWeight: 500,
              color: entries.length > 0 ? "#fff" : "#6b7280",
              background: entries.length > 0 ? accentColor : "#f3f4f6",
              padding: "0.125rem 0.5rem",
              borderRadius: "9999px"
            }}
          >
            {entries.length}
          </span>
        </h2>
        <div style={{ display: "flex", gap: "0.5rem", alignItems: "center" }}>
          <button
            type="button"
            onClick={(e) => {
              e.preventDefault();
              const endpoint =
                level === "error"
                  ? "/api/dashboard/clear-errors"
                  : "/api/dashboard/clear-warnings";
              fetch(endpoint, { method: "POST" }).catch((err) => {
                console.warn(
                  `${level} panel clear failed (${entries.length} entries): ${errMsg(err)}`
                );
              });
            }}
            disabled={entries.length === 0}
            title={`Clear all ${level} entries (state refreshes via live sync)`}
            aria-label={`Clear all ${level} entries`}
            style={{
              padding: "0.25rem 0.625rem",
              background: level === "error" ? "#fef2f2" : "#fffbeb",
              color: level === "error" ? "#b91c1c" : "#b45309",
              borderRadius: "0.375rem",
              fontWeight: 500,
              fontSize: "0.75rem",
              border:
                level === "error" ? "1px solid #fecaca" : "1px solid #fde68a",
              cursor: entries.length === 0 ? "not-allowed" : "pointer",
              opacity: entries.length === 0 ? 0.5 : 1
            }}
          >
            🧹 Clear
          </button>
          <button
            type="button"
            onClick={(e) => {
              e.preventDefault();
              const clipboard = navigator.clipboard;
              if (!clipboard?.writeText) {
                console.warn(
                  `Activity panel copy unavailable for ${level} (${entries.length} entries): Clipboard API missing`
                );
                return;
              }
              const text = entries.map(formatActivityEntry).join("\n");
              clipboard.writeText(text).catch((err) => {
                const errorMessage = errMsg(err);
                console.warn(
                  `Activity panel copy failed for ${level} (${entries.length} entries): ${errorMessage}`,
                  { level, entryCount: entries.length, error: err }
                );
              });
            }}
            disabled={entries.length === 0}
            title={`Copy all ${level} entries`}
            aria-label={`Copy all ${level} entries`}
            style={{
              padding: "0.25rem 0.625rem",
              background: "#f3f4f6",
              color: "#374151",
              borderRadius: "0.375rem",
              fontWeight: 500,
              fontSize: "0.75rem",
              border: "1px solid #e5e7eb",
              cursor: entries.length === 0 ? "not-allowed" : "pointer",
              opacity: entries.length === 0 ? 0.5 : 1
            }}
          >
            📋 Copy all
          </button>
        </div>
      </summary>
      <div
        role="log"
        aria-live="polite"
        aria-relevant="additions"
        aria-atomic="false"
        aria-label={`${title} log`}
        style={{
          maxHeight: "20rem",
          overflowY: "auto",
          marginTop: "0.75rem"
        }}
      >
        {entries.length === 0 ? (
          <p
            style={{
              fontSize: "0.875rem",
              color: "#6b7280",
              padding: "1rem",
              textAlign: "center"
            }}
          >
            {emptyMessage}
          </p>
        ) : (
          entries.map((entry) => {
            const ageMs = activityEntryAgeMs(entry);
            const stale = ageMs !== null && ageMs > 24 * 3_600_000;
            return (
              <div
                key={entry.logRef}
                title={
                  ageMs !== null ? `${formatActivityAge(ageMs)} ago` : undefined
                }
                style={stale ? { opacity: 0.55 } : undefined}
              >
                <ActivityLogRow entry={entry} />
              </div>
            );
          })
        )}
      </div>
    </details>
  );
}

function CodingAgentPanel({ state }: { state: SEOAgentState }) {
  const entries = [...getActivityLogEntries(state)]
    .filter((e) => e.activeRole === "codingAgent")
    .reverse()
    .slice(0, 50);

  const issueCount = entries.filter((e) =>
    CODING_AGENT_OPEN_RE.test(e.msg ?? "")
  ).length;

  return (
    <details
      open
      style={{
        background: "#fff",
        borderRadius: "0.75rem",
        border: "1px solid #e5e7eb",
        padding: "1rem",
        marginBottom: "1rem"
      }}
    >
      <summary
        style={{
          cursor: "pointer",
          userSelect: "none",
          listStyle: "none",
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
          gap: "0.75rem"
        }}
      >
        <div>
          <h2
            style={{
              fontSize: "1.125rem",
              fontWeight: 600,
              color: "#111827",
              margin: 0,
              display: "flex",
              alignItems: "center",
              gap: "0.5rem"
            }}
          >
            <span>🛠️</span>
            <span>Coding Agent</span>
          </h2>
          <p
            style={{
              margin: "0.25rem 0 0",
              fontSize: "0.8125rem",
              color: "#6b7280"
            }}
          >
            Autonomous repair loop — opens a GitHub issue labeled{" "}
            <code
              style={{
                background: "#f3f4f6",
                padding: "0 0.25rem",
                borderRadius: "0.25rem"
              }}
            >
              claude-fix
            </code>{" "}
            whenever an article fails and assigns GitHub Copilot Coding Agent to
            open a fix PR.
          </p>
        </div>
        <div
          style={{
            fontSize: "0.75rem",
            color: "#6b7280",
            whiteSpace: "nowrap",
            display: "flex",
            flexDirection: "column",
            alignItems: "flex-end",
            gap: "0.125rem"
          }}
        >
          <span>
            {issueCount > 0
              ? `${issueCount} recent issue${issueCount === 1 ? "" : "s"}`
              : "idle"}
          </span>
          <span style={{ color: "#9ca3af" }}>click to collapse</span>
        </div>
      </summary>

      <div
        style={{
          marginTop: "0.75rem",
          height: "360px",
          overflowY: "auto",
          paddingRight: "0.25rem",
          background: "#fafafa",
          borderRadius: "0.5rem"
        }}
      >
        {entries.length === 0 ? (
          <div
            style={{
              height: "100%",
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              padding: "1.25rem",
              color: "#6b7280",
              fontSize: "0.875rem",
              textAlign: "center"
            }}
          >
            Coding Agent is idle — no pipeline failures needing repair.
          </div>
        ) : (
          <div
            style={{
              display: "flex",
              flexDirection: "column",
              gap: "0.5rem",
              padding: "0.5rem"
            }}
          >
            {entries.map((entry) => {
              const match = CODING_AGENT_OPEN_RE.exec(entry.msg ?? "");
              const keyword = match ? parseActivityLogKeyword(match[3]) : null;
              const isError = isActivityLogErrorLevel(entry.level);
              const isWarning = isActivityLogWarningLevel(entry.level);
              const accent = match
                ? "#2563eb"
                : isError
                  ? "#dc2626"
                  : isWarning
                    ? "#d97706"
                    : "#6b7280";
              return (
                <div
                  key={entry.logRef}
                  style={{
                    padding: "0.625rem 0.75rem",
                    background: "#f9fafb",
                    borderLeft: `3px solid ${accent}`,
                    borderRadius: "0.25rem",
                    fontSize: "0.8125rem",
                    color: "#111827"
                  }}
                >
                  <div
                    style={{
                      display: "flex",
                      gap: "0.75rem",
                      alignItems: "baseline",
                      flexWrap: "wrap"
                    }}
                  >
                    <span
                      style={{
                        fontFamily: "ui-monospace, monospace",
                        fontSize: "0.75rem",
                        color: "#6b7280"
                      }}
                    >
                      {entry.timeDate} {entry.timeTime}
                    </span>
                    {match ? (
                      <>
                        <span
                          style={{
                            fontWeight: 600,
                            color: "#2563eb"
                          }}
                        >
                          {match[2]}
                        </span>
                        <span style={{ color: "#111827" }}>
                          keyword:{" "}
                          <code
                            style={{
                              background: "#f3f4f6",
                              padding: "0 0.25rem",
                              borderRadius: "0.25rem"
                            }}
                          >
                            {keyword}
                          </code>
                        </span>
                        {match[1] ? (
                          match[4] ? (
                            <a
                              href={match[4]}
                              target="_blank"
                              rel="noopener noreferrer"
                              style={{
                                color: "#2563eb",
                                textDecoration: "underline",
                                fontFamily: "ui-monospace, monospace"
                              }}
                            >
                              issue #{match[1]} ↗
                            </a>
                          ) : (
                            <span
                              style={{
                                color: "#6b7280",
                                fontFamily: "ui-monospace, monospace"
                              }}
                            >
                              issue #{match[1]}
                            </span>
                          )
                        ) : (
                          <span
                            style={{
                              color: "#6b7280",
                              fontFamily: "ui-monospace, monospace"
                            }}
                          >
                            issue (unknown #)
                          </span>
                        )}
                      </>
                    ) : (
                      <span
                        style={{
                          color: isError
                            ? "#b91c1c"
                            : isWarning
                              ? "#92400e"
                              : "#374151"
                        }}
                      >
                        {entry.msg}
                      </span>
                    )}
                  </div>
                  {match && entry.keyword && (
                    <div
                      style={{
                        marginTop: "0.25rem",
                        fontSize: "0.75rem",
                        color: "#6b7280"
                      }}
                    >
                      Category: {entry.categorySlug || "—"}
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        )}
      </div>
    </details>
  );
}

// Published Article Text Editor panel — pipeline step 9.5.
// Fires for every article generated. Filters activity log entries by
// role=textEditorAgent and shows start/scan/fix/done events so the
// operator can monitor the mechanical quality pass live.
function TextEditorAgentPanel({ state }: { state: SEOAgentState }) {
  const entries = [...getActivityLogEntries(state)]
    .filter((e) => e.activeRole === "textEditorAgent")
    .reverse()
    .slice(0, 50);

  const fixCount = entries.filter((e) => /\[fix\]/.test(e.msg ?? "")).length;

  return (
    <details
      open
      style={{
        background: "#fff",
        borderRadius: "0.75rem",
        border: "1px solid #e5e7eb",
        padding: "1rem",
        marginBottom: "1rem"
      }}
    >
      <summary
        style={{
          cursor: "pointer",
          userSelect: "none",
          listStyle: "none",
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
          gap: "0.75rem"
        }}
      >
        <div>
          <h2
            style={{
              fontSize: "1.125rem",
              fontWeight: 600,
              color: "#111827",
              margin: 0,
              display: "flex",
              alignItems: "center",
              gap: "0.5rem"
            }}
          >
            <span>✏️</span>
            <span>Published Article Text Editor</span>
          </h2>
          <p
            style={{
              margin: "0.25rem 0 0",
              fontSize: "0.8125rem",
              color: "#6b7280"
            }}
          >
            Pipeline step 9.5 — runs for every article. Scans for truncation,
            empty sections, leaked model tokens, and duplicate content; applies
            minimal surgical fixes via Kimi K2.5.
          </p>
        </div>
        <div
          style={{
            fontSize: "0.75rem",
            color: "#6b7280",
            whiteSpace: "nowrap",
            display: "flex",
            flexDirection: "column",
            alignItems: "flex-end",
            gap: "0.125rem"
          }}
        >
          <span>
            {fixCount > 0
              ? `${fixCount} fix event${fixCount === 1 ? "" : "s"}`
              : "idle"}
          </span>
          <span style={{ color: "#9ca3af" }}>click to collapse</span>
        </div>
      </summary>

      <div
        style={{
          marginTop: "0.75rem",
          height: "360px",
          overflowY: "auto",
          paddingRight: "0.25rem",
          background: "#fafafa",
          borderRadius: "0.5rem"
        }}
      >
        {entries.length === 0 ? (
          <div
            style={{
              height: "100%",
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              padding: "1.25rem",
              color: "#6b7280",
              fontSize: "0.875rem",
              textAlign: "center"
            }}
          >
            Text Editor is idle — no articles have run through step 9.5 yet.
          </div>
        ) : (
          <div
            style={{
              display: "flex",
              flexDirection: "column",
              gap: "0.5rem",
              padding: "0.5rem"
            }}
          >
            {entries.map((entry) => {
              const isError = isActivityLogErrorLevel(entry.level);
              const isWarning = isActivityLogWarningLevel(entry.level);
              const accent = isError
                ? "#dc2626"
                : isWarning
                  ? "#d97706"
                  : "#2563eb";
              return (
                <div
                  key={entry.logRef}
                  style={{
                    padding: "0.625rem 0.75rem",
                    background: "#f9fafb",
                    borderLeft: `3px solid ${accent}`,
                    borderRadius: "0.25rem",
                    fontSize: "0.8125rem",
                    color: "#111827"
                  }}
                >
                  <div
                    style={{
                      display: "flex",
                      gap: "0.75rem",
                      alignItems: "baseline",
                      flexWrap: "wrap"
                    }}
                  >
                    <span
                      style={{
                        fontFamily: "ui-monospace, monospace",
                        fontSize: "0.75rem",
                        color: "#6b7280"
                      }}
                    >
                      {entry.timeDate} {entry.timeTime}
                    </span>
                    <span
                      style={{
                        color: isError
                          ? "#b91c1c"
                          : isWarning
                            ? "#92400e"
                            : "#374151"
                      }}
                    >
                      {entry.msg}
                    </span>
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </div>
    </details>
  );
}

// Improvement Agent panel — autonomous self-improvement loop.
// Fires once per successful article publish (src/pipeline/improvement-agent.ts).
// Opens a GitHub issue + assigns Copilot Coding Agent, which picks one
// codebase improvement, reads the relevant `.claude/skills/<slug>/SKILL.md`,
// and opens a PR titled `improve(auto): …`. The existing
// `auto-merge-copilot.yml` squash-merges once `check (ubuntu-24.04)` passes.
//
// Filters activity log entries by role=improvementAgent and parses the
// "opened issue #N for "<keyword>" — <html_url>" structured line into a
// row. URL is optional to handle "(unknown #)" fallback logs.
const IMPROVEMENT_OPEN_RE = new RegExp(
  `^Improvement Agent: opened issue (?:#(\\d+)|\\(unknown #\\)) for (${JSON_STRING_RE})(?:\\s+—\\s+(https?:\\/\\/\\S+))?$`
);

function ImprovementAgentPanel({ state }: { state: SEOAgentState }) {
  const activityLog = getActivityLogEntries(state);
  const entries = [...activityLog]
    .filter((e) => e.activeRole === "improvementAgent")
    .reverse()
    .slice(0, 50);
  const parsedEntries = entries.map((entry) => ({
    entry,
    opened: IMPROVEMENT_OPEN_RE.exec(entry.msg ?? "")
  }));

  const openedCount = parsedEntries.filter((item) => item.opened).length;
  const summaryLabel =
    openedCount > 0
      ? `${openedCount} issue${openedCount === 1 ? "" : "s"} opened`
      : entries.length > 0
        ? `${entries.length} event${entries.length === 1 ? "" : "s"} logged`
        : "idle";

  return (
    <details
      open
      style={{
        background: "#fff",
        borderRadius: "0.75rem",
        border: "1px solid #e5e7eb",
        padding: "1rem",
        marginBottom: "1rem"
      }}
    >
      <summary
        style={{
          cursor: "pointer",
          userSelect: "none",
          listStyle: "none",
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
          gap: "0.75rem"
        }}
      >
        <div>
          <h2
            style={{
              fontSize: "1.125rem",
              fontWeight: 600,
              color: "#111827",
              margin: 0,
              display: "flex",
              alignItems: "center",
              gap: "0.5rem"
            }}
          >
            <span>🔧</span>
            <span>Improvement Activity Log</span>
          </h2>
          <p
            style={{
              margin: "0.25rem 0 0",
              fontSize: "0.8125rem",
              color: "#6b7280"
            }}
          >
            Fires once per published article. Copilot Coding Agent picks one
            codebase improvement, reads the relevant skill docs, and opens an{" "}
            <code>improve(auto):</code> PR. 24h KV dedup per kvKey.
          </p>
        </div>
        <div
          style={{
            fontSize: "0.75rem",
            color: "#6b7280",
            whiteSpace: "nowrap",
            display: "flex",
            flexDirection: "column",
            alignItems: "flex-end",
            gap: "0.125rem"
          }}
        >
          <span>{summaryLabel}</span>
          <span style={{ color: "#9ca3af" }}>click to collapse</span>
        </div>
      </summary>

      <div
        style={{
          marginTop: "0.75rem",
          height: "360px",
          overflowY: "auto",
          paddingRight: "0.25rem",
          background: "#fafafa",
          borderRadius: "0.5rem"
        }}
      >
        {entries.length === 0 ? (
          <div
            style={{
              height: "100%",
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              padding: "1.25rem",
              color: "#6b7280",
              fontSize: "0.875rem",
              textAlign: "center"
            }}
          >
            Improvement Agent is idle — no articles have published since the
            loop went live.
          </div>
        ) : (
          <div
            style={{
              display: "flex",
              flexDirection: "column",
              gap: "0.5rem",
              padding: "0.5rem"
            }}
          >
            {parsedEntries.map(({ entry, opened }) => {
              const isError = isActivityLogErrorLevel(entry.level);
              const isWarning = isActivityLogWarningLevel(entry.level);
              const accent = isError
                ? "#dc2626"
                : isWarning
                  ? "#d97706"
                  : "#2563eb";
              const keyword = opened
                ? parseActivityLogKeyword(opened[2])
                : null;
              const issueNumber = opened?.[1] ?? null;
              const issueUrl = opened?.[3] ?? null;
              return (
                <div
                  key={entry.logRef}
                  style={{
                    padding: "0.625rem 0.75rem",
                    background: "#f9fafb",
                    borderLeft: `3px solid ${accent}`,
                    borderRadius: "0.25rem",
                    fontSize: "0.8125rem",
                    color: "#111827"
                  }}
                >
                  <div
                    style={{
                      display: "flex",
                      gap: "0.75rem",
                      alignItems: "baseline",
                      flexWrap: "wrap"
                    }}
                  >
                    <span
                      style={{
                        fontFamily: "ui-monospace, monospace",
                        fontSize: "0.75rem",
                        color: "#6b7280"
                      }}
                    >
                      {entry.timeDate} {entry.timeTime}
                    </span>
                    {opened ? (
                      <span style={{ color: "#374151" }}>
                        Opened issue{" "}
                        {issueUrl ? (
                          <a
                            href={issueUrl}
                            target="_blank"
                            rel="noopener noreferrer"
                            style={{
                              color: "#2563eb",
                              textDecoration: "underline"
                            }}
                          >
                            {issueNumber ? `#${issueNumber}` : "(unknown #)"}
                          </a>
                        ) : issueNumber ? (
                          "#" + issueNumber
                        ) : (
                          "(unknown #)"
                        )}{" "}
                        for &quot;{keyword}&quot;
                      </span>
                    ) : (
                      <span
                        style={{
                          color: isError
                            ? "#b91c1c"
                            : isWarning
                              ? "#92400e"
                              : "#374151"
                        }}
                      >
                        {entry.msg}
                      </span>
                    )}
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </div>
    </details>
  );
}

// API Activity Log panel — surfaces every external `fetch()` the Worker
// makes, wrapped in `loggedFetch()` (src/pipeline/api-logger.ts). Reads
// activity log entries with role=apiCall and parses the canonical line
// format `[<api>] <op?> <METHOD> <host><path> → <status> (<ms>ms)` into
// structured columns. Status drives the level (5xx=error, 4xx=warning,
// 2xx/3xx=info), which the panel color-codes via a left-border accent.
const API_ACTIVITY_RE =
  /^\[([^\]]+)\](?:\s+([^\s][^]*?))?\s+([A-Z-]+)\s+(\S+?)(\/\S*)?\s+→\s+(\d{3}|network error)\s+\((\d+)ms\)(?::\s+(.+))?$/;

function ApiActivityPanel({ state }: { state: SEOAgentState }) {
  const [errorsOnly, setErrorsOnly] = useState(false);
  const activityLog = getActivityLogEntries(state);
  const all = [...activityLog]
    .filter((e) => e.activeRole === "apiCall")
    .reverse();
  const entries = (
    errorsOnly
      ? all.filter((e) => isActivityLogWarningOrErrorLevel(e.level))
      : all
  ).slice(0, 80);
  const emptyMessage = errorsOnly
    ? all.length === 0
      ? "No API activity yet — calls will appear here as the Worker hits external services."
      : "No API warnings/errors in the current activity window."
    : "No API activity yet — calls will appear here as the Worker hits external services.";

  const errorCount = all.filter((e) => isActivityLogErrorLevel(e.level)).length;
  const warnCount = all.filter((e) =>
    isActivityLogWarningLevel(e.level)
  ).length;

  return (
    <details
      open
      style={{
        background: "#fff",
        borderRadius: "0.75rem",
        border: "1px solid #e5e7eb",
        padding: "1rem",
        marginBottom: "1rem"
      }}
    >
      <summary
        style={{
          cursor: "pointer",
          userSelect: "none",
          listStyle: "none",
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
          gap: "0.75rem"
        }}
      >
        <div>
          <h2
            style={{
              fontSize: "1.125rem",
              fontWeight: 600,
              color: "#111827",
              margin: 0,
              display: "flex",
              alignItems: "center",
              gap: "0.5rem"
            }}
          >
            <span>📡</span>
            <span>API Activity Log</span>
          </h2>
          <p
            style={{
              margin: "0.25rem 0 0",
              fontSize: "0.8125rem",
              color: "#6b7280"
            }}
          >
            Every outbound API call the Worker makes — host, status, latency.
            Color-coded by status (green 2xx · yellow 4xx · red 5xx/network).
          </p>
        </div>
        <div
          style={{
            fontSize: "0.75rem",
            color: "#6b7280",
            whiteSpace: "nowrap",
            display: "flex",
            flexDirection: "column",
            alignItems: "flex-end",
            gap: "0.125rem"
          }}
        >
          <span>
            {all.length} call{all.length === 1 ? "" : "s"}
            {errorCount > 0 ? ` · ${errorCount} err` : ""}
            {warnCount > 0 ? ` · ${warnCount} warn` : ""}
          </span>
          <span style={{ color: "#6b7280" }}>click to collapse</span>
        </div>
      </summary>

      <div
        style={{
          marginTop: "0.5rem",
          display: "flex",
          alignItems: "center",
          gap: "0.5rem"
        }}
      >
        <label
          style={{
            display: "inline-flex",
            alignItems: "center",
            gap: "0.375rem",
            fontSize: "0.8125rem",
            color: "#374151",
            cursor: "pointer"
          }}
        >
          <input
            type="checkbox"
            checked={errorsOnly}
            onChange={(e) => setErrorsOnly(e.target.checked)}
          />
          Errors / warnings only
        </label>
      </div>

      <div
        style={{
          marginTop: "0.5rem",
          height: "360px",
          overflowY: "auto",
          paddingRight: "0.25rem",
          background: "#fafafa",
          borderRadius: "0.5rem"
        }}
      >
        {entries.length === 0 ? (
          <div
            style={{
              height: "100%",
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              padding: "1.25rem",
              color: "#6b7280",
              fontSize: "0.875rem",
              textAlign: "center"
            }}
          >
            {emptyMessage}
          </div>
        ) : (
          <div
            style={{
              display: "flex",
              flexDirection: "column",
              gap: "0.375rem",
              padding: "0.5rem"
            }}
          >
            {entries.map((entry) => {
              const isError = isActivityLogErrorLevel(entry.level);
              const isWarning = isActivityLogWarningLevel(entry.level);
              const accent = isError
                ? "#dc2626"
                : isWarning
                  ? "#d97706"
                  : "#059669";
              const m = API_ACTIVITY_RE.exec(entry.msg ?? "");
              const api = m?.[1];
              const op = m?.[2];
              const method = m?.[3];
              const host = m?.[4];
              const path = m?.[5] ?? "";
              const status = m?.[6];
              const ms = m?.[7];
              const detail = m?.[8];
              return (
                <div
                  key={entry.logRef}
                  style={{
                    padding: "0.5rem 0.625rem",
                    background: "#fff",
                    borderLeft: `3px solid ${accent}`,
                    borderRadius: "0.25rem",
                    fontSize: "0.8125rem",
                    color: "#111827",
                    fontFamily: "ui-monospace, monospace"
                  }}
                >
                  {m ? (
                    <>
                      <div
                        style={{
                          display: "grid",
                          gridTemplateColumns: "auto 80px 60px 1fr 60px 60px",
                          gap: "0.5rem",
                          alignItems: "baseline"
                        }}
                      >
                        <span style={{ color: "#6b7280", fontSize: "0.75rem" }}>
                          {entry.timeTime}
                        </span>
                        <span
                          style={{
                            color: "#7c3aed",
                            fontWeight: 600,
                            overflow: "hidden",
                            textOverflow: "ellipsis"
                          }}
                          title={api}
                        >
                          {api}
                        </span>
                        <span style={{ color: "#374151", fontWeight: 600 }}>
                          {method}
                        </span>
                        <span
                          style={{
                            color: "#374151",
                            overflow: "hidden",
                            textOverflow: "ellipsis",
                            whiteSpace: "nowrap"
                          }}
                          title={`${host}${path}${op ? ` (${op})` : ""}`}
                        >
                          {host}
                          <span style={{ color: "#6b7280" }}>{path}</span>
                          {op ? (
                            <span style={{ color: "#9ca3af" }}> · {op}</span>
                          ) : null}
                        </span>
                        <span
                          style={{
                            color: accent,
                            fontWeight: 600,
                            textAlign: "right"
                          }}
                          title={detail}
                        >
                          {status}
                        </span>
                        <span style={{ color: "#6b7280", textAlign: "right" }}>
                          {ms}ms
                        </span>
                      </div>
                      {detail ? (
                        <div
                          style={{
                            marginTop: "0.375rem",
                            color: "#6b7280",
                            whiteSpace: "normal",
                            wordBreak: "break-word"
                          }}
                        >
                          {detail}
                        </div>
                      ) : null}
                    </>
                  ) : (
                    <span style={{ color: "#374151" }}>{entry.msg}</span>
                  )}
                </div>
              );
            })}
          </div>
        )}
      </div>
    </details>
  );
}

// Published Article Editorial Agent panel — autonomous. Fires itself
// automatically after every successful article publish (see
// `runEditorialAgent` wired into the success block in server.ts). Each
// publish event streams 4 step log lines here under role=editorialAgent.
// Manual-trigger admin endpoint (POST /api/admin/editorial-review) still
// exists for debugging but the dashboard surface is read-only.
function EditorialAgentPanel({ state }: { state: SEOAgentState }) {
  const entries = [...getActivityLogEntries(state)]
    .filter((e) => e.activeRole === "editorialAgent")
    .reverse()
    .slice(0, 50);

  const activeCount = entries.filter((e) =>
    /\[step \d\/\d\]/i.test(e.msg ?? "")
  ).length;

  return (
    <details
      open
      style={{
        background: "#fff",
        borderRadius: "0.75rem",
        border: "1px solid #e5e7eb",
        padding: "1rem",
        marginBottom: "1rem"
      }}
    >
      <summary
        style={{
          cursor: "pointer",
          userSelect: "none",
          listStyle: "none",
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
          gap: "0.75rem"
        }}
      >
        <div>
          <h2
            style={{
              fontSize: "1.125rem",
              fontWeight: 600,
              color: "#111827",
              margin: 0,
              display: "flex",
              alignItems: "center",
              gap: "0.5rem"
            }}
          >
            <span>📝</span>
            <span>Published Article Editorial Agent</span>
          </h2>
          <p
            style={{
              margin: "0.25rem 0 0",
              fontSize: "0.8125rem",
              color: "#6b7280"
            }}
          >
            Fires automatically after every published article. Reads the KV
            HTML, drives Cloudflare Browser Rendering to screenshot the live
            page, audits vs a per-category editorial benchmark (defaults to NYT
            Wirecutter), rewrites and republishes when findings warrant.
          </p>
        </div>
        <div
          style={{
            fontSize: "0.75rem",
            color: "#6b7280",
            whiteSpace: "nowrap",
            display: "flex",
            flexDirection: "column",
            alignItems: "flex-end",
            gap: "0.125rem"
          }}
        >
          <span>
            {activeCount > 0
              ? `${activeCount} step event${activeCount === 1 ? "" : "s"}`
              : "idle"}
          </span>
          <span style={{ color: "#9ca3af" }}>click to collapse</span>
        </div>
      </summary>

      <div
        style={{
          marginTop: "0.75rem",
          height: "360px",
          overflowY: "auto",
          paddingRight: "0.25rem",
          background: "#fafafa",
          borderRadius: "0.5rem"
        }}
      >
        {entries.length === 0 ? (
          <div
            style={{
              height: "100%",
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              padding: "1.25rem",
              color: "#6b7280",
              fontSize: "0.875rem",
              textAlign: "center"
            }}
          >
            Editorial Agent is idle — it will run automatically after the next
            published article.
          </div>
        ) : (
          <div
            style={{
              display: "flex",
              flexDirection: "column",
              gap: "0.5rem",
              padding: "0.5rem"
            }}
          >
            {entries.map((entry) => {
              const isError = isActivityLogErrorLevel(entry.level);
              const isWarning = isActivityLogWarningLevel(entry.level);
              const accent = isError
                ? "#dc2626"
                : isWarning
                  ? "#d97706"
                  : "#2563eb";
              return (
                <div
                  key={entry.logRef}
                  style={{
                    padding: "0.625rem 0.75rem",
                    background: "#f9fafb",
                    borderLeft: `3px solid ${accent}`,
                    borderRadius: "0.25rem",
                    fontSize: "0.8125rem",
                    color: "#111827"
                  }}
                >
                  <div
                    style={{
                      display: "flex",
                      gap: "0.75rem",
                      alignItems: "baseline",
                      flexWrap: "wrap"
                    }}
                  >
                    <span
                      style={{
                        fontFamily: "ui-monospace, monospace",
                        fontSize: "0.75rem",
                        color: "#6b7280"
                      }}
                    >
                      {entry.timeDate} {entry.timeTime}
                    </span>
                    <span
                      style={{
                        color: isError
                          ? "#b91c1c"
                          : isWarning
                            ? "#92400e"
                            : "#374151"
                      }}
                    >
                      {entry.msg}
                    </span>
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </div>
    </details>
  );
}

// Rankings panel — DataForSEO Labs ranked-keywords summary for every
// published article. Fetches /api/analytics-summary every 5 min; one row per
// kvKey showing the top-traffic keyword, its current position, the 28-day
// position delta, estimated traffic, search volume, and any SERP features
// (featured snippet, AI Overview, etc.). Drives the closed feedback loop:
// operator sees what's actually ranking and which articles are decaying.
//
// Population: every-minute scheduled() handler in src/server.ts calls the
// SEOArticleAgent.runAnalyticsTick() DO method which pulls a small batch of
// stale articles from DataForSEO Labs and writes article_rankings rows.
interface RankingsRow {
  kvKey: string;
  /** The article's TARGET keyword (from articles.keyword) — what it was written to rank for. */
  keyword: string;
  /** Date of the latest article_rankings snapshot (null = never pulled). */
  date: string | null;
  /** Latest position for the target keyword (null = not in DataForSEO top 100). */
  position: number | null;
  priorPosition: number | null;
  positionDelta: number | null;
  searchVolume: number;
  estTraffic: number;
  serpFeatures: string;
}
interface RankingsResponse {
  ok: boolean;
  count: number;
  rows: RankingsRow[];
  articlesTracked: number;
  articlesTotal: number;
}

function RankingsPanel() {
  const [data, setData] = useState<RankingsResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;
    const load = async () => {
      try {
        const resp = await fetch("/api/analytics-summary?limit=100", {
          credentials: "same-origin"
        });
        if (!resp.ok) {
          if (!cancelled) {
            setError(`HTTP ${resp.status}`);
            setLoading(false);
          }
          return;
        }
        const json = (await resp.json()) as RankingsResponse;
        if (!cancelled) {
          setData(json);
          setError(null);
          setLoading(false);
        }
      } catch (err: unknown) {
        if (!cancelled) {
          setError(errMsg(err));
          setLoading(false);
        }
      }
    };
    void load();
    // 5-minute refresh (was 60s). The underlying analytics-tick refreshes
    // each article weekly, so polling every minute was wasted DO traffic
    // for data that hasn't changed.
    const interval = setInterval(() => void load(), 300_000);
    return () => {
      cancelled = true;
      clearInterval(interval);
    };
  }, []);

  const rows = data?.rows ?? [];
  const tracked = data?.articlesTracked ?? 0;
  const total = data?.articlesTotal ?? 0;

  return (
    <details
      open
      style={{
        background: "#fff",
        borderRadius: "0.75rem",
        border: "1px solid #e5e7eb",
        padding: "1rem",
        marginBottom: "1rem"
      }}
    >
      <summary
        style={{
          cursor: "pointer",
          userSelect: "none",
          listStyle: "none",
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
          gap: "0.75rem"
        }}
      >
        <div>
          <h2
            style={{
              fontSize: "1.125rem",
              fontWeight: 600,
              color: "#111827",
              margin: 0,
              display: "flex",
              alignItems: "center",
              gap: "0.5rem"
            }}
          >
            <span>📈</span>
            <span>Rankings</span>
          </h2>
          <p
            style={{
              margin: "0.25rem 0 0",
              fontSize: "0.8125rem",
              color: "#6b7280"
            }}
          >
            Each article's TARGET keyword (what it was written to rank for) and
            its current Google position via DataForSEO Labs ranked_keywords.
            Articles with position "—" aren't in the top 100 for their target.
            28-day delta in green (rising) or red (decaying). Underlying data
            refreshes weekly per article; panel polls every 5 min.
          </p>
        </div>
        <div
          style={{
            fontSize: "0.75rem",
            color: "#6b7280",
            whiteSpace: "nowrap",
            display: "flex",
            flexDirection: "column",
            alignItems: "flex-end",
            gap: "0.125rem"
          }}
        >
          <span>
            {tracked} / {total} tracked
          </span>
          <span style={{ color: "#9ca3af" }}>
            {error ? `error: ${error}` : `${rows.length} rows`}
          </span>
        </div>
      </summary>

      <div
        style={{
          marginTop: "0.75rem",
          maxHeight: "480px",
          overflowY: "auto",
          background: "#fafafa",
          borderRadius: "0.5rem"
        }}
      >
        {loading ? (
          <div
            style={{
              padding: "1.25rem",
              color: "#6b7280",
              fontSize: "0.875rem",
              textAlign: "center"
            }}
          >
            Loading rankings…
          </div>
        ) : error ? (
          <div
            style={{
              padding: "1.25rem",
              color: "#dc2626",
              fontSize: "0.875rem",
              textAlign: "center"
            }}
          >
            Couldn't load rankings: {error}
          </div>
        ) : rows.length === 0 ? (
          <div
            style={{
              padding: "1.25rem",
              color: "#6b7280",
              fontSize: "0.875rem",
              textAlign: "center"
            }}
          >
            {total === 0
              ? "No articles published yet."
              : tracked === 0
                ? "Analytics tick hasn't pulled any rankings yet — first pull happens within a minute of cron uptime once DATAFORSEO_LOGIN/PASSWORD secrets are set."
                : "Articles tracked but none currently ranking in the top 100."}
          </div>
        ) : (
          <table
            style={{
              width: "100%",
              borderCollapse: "collapse",
              fontSize: "0.8125rem",
              tableLayout: "fixed"
            }}
          >
            <thead>
              <tr
                style={{
                  background: "#f3f4f6",
                  color: "#374151",
                  textAlign: "left",
                  position: "sticky",
                  top: 0
                }}
              >
                <th style={{ padding: "0.5rem 0.625rem", width: "30%" }}>
                  Target Keyword
                </th>
                <th style={{ padding: "0.5rem 0.625rem", width: "28%" }}>
                  Article
                </th>
                <th
                  style={{
                    padding: "0.5rem 0.625rem",
                    width: "8%",
                    textAlign: "right"
                  }}
                >
                  Pos
                </th>
                <th
                  style={{
                    padding: "0.5rem 0.625rem",
                    width: "8%",
                    textAlign: "right"
                  }}
                >
                  Δ 28d
                </th>
                <th
                  style={{
                    padding: "0.5rem 0.625rem",
                    width: "10%",
                    textAlign: "right"
                  }}
                >
                  Volume
                </th>
                <th
                  style={{
                    padding: "0.5rem 0.625rem",
                    width: "8%",
                    textAlign: "right"
                  }}
                >
                  Traffic
                </th>
                <th style={{ padding: "0.5rem 0.625rem", width: "8%" }}>
                  Features
                </th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => {
                const delta = r.positionDelta;
                let deltaText = "—";
                let deltaColor = "#9ca3af";
                if (delta !== null) {
                  if (delta > 0) {
                    deltaText = `▲${delta}`;
                    deltaColor = "#059669";
                  } else if (delta < 0) {
                    deltaText = `▼${Math.abs(delta)}`;
                    deltaColor = "#dc2626";
                  } else {
                    deltaText = "·";
                    deltaColor = "#6b7280";
                  }
                }
                const articleHref = `/${r.kvKey.replace(":", "/")}`;
                const features = r.serpFeatures
                  ? r.serpFeatures
                      .split(",")
                      .filter(Boolean)
                      .map((f) =>
                        f
                          .replace("featured_snippet", "FS")
                          .replace("ai_overview", "AI")
                      )
                      .join(" ")
                  : "";
                return (
                  <tr key={r.kvKey} style={{ borderTop: "1px solid #e5e7eb" }}>
                    <td
                      style={{
                        padding: "0.5rem 0.625rem",
                        color: "#111827",
                        overflow: "hidden",
                        textOverflow: "ellipsis",
                        whiteSpace: "nowrap"
                      }}
                      title={r.keyword}
                    >
                      {r.keyword}
                    </td>
                    <td
                      style={{
                        padding: "0.5rem 0.625rem",
                        overflow: "hidden",
                        textOverflow: "ellipsis",
                        whiteSpace: "nowrap"
                      }}
                      title={r.kvKey}
                    >
                      <a
                        href={articleHref}
                        target="_blank"
                        rel="noreferrer noopener"
                        style={{ color: "#2563eb" }}
                      >
                        {r.kvKey}
                      </a>
                    </td>
                    <td
                      style={{
                        padding: "0.5rem 0.625rem",
                        color:
                          r.position === null
                            ? "#9ca3af"
                            : r.position <= 3
                              ? "#059669"
                              : r.position <= 10
                                ? "#0891b2"
                                : r.position <= 20
                                  ? "#d97706"
                                  : "#6b7280",
                        fontWeight: 600,
                        textAlign: "right"
                      }}
                      title={
                        r.position === null
                          ? "Target keyword not in DataForSEO top 100 (not ranking)"
                          : `Position #${r.position} for target keyword`
                      }
                    >
                      {r.position === null ? "—" : r.position}
                    </td>
                    <td
                      style={{
                        padding: "0.5rem 0.625rem",
                        color: deltaColor,
                        fontWeight: 600,
                        textAlign: "right"
                      }}
                      title={
                        r.priorPosition !== null
                          ? `28d ago: pos ${r.priorPosition}`
                          : "no prior data"
                      }
                    >
                      {deltaText}
                    </td>
                    <td
                      style={{
                        padding: "0.5rem 0.625rem",
                        color: "#374151",
                        textAlign: "right"
                      }}
                    >
                      {r.searchVolume.toLocaleString()}
                    </td>
                    <td
                      style={{
                        padding: "0.5rem 0.625rem",
                        color: "#374151",
                        textAlign: "right"
                      }}
                    >
                      {Math.round(r.estTraffic).toLocaleString()}
                    </td>
                    <td
                      style={{
                        padding: "0.5rem 0.625rem",
                        color: "#7c3aed",
                        fontSize: "0.75rem",
                        whiteSpace: "nowrap"
                      }}
                    >
                      {features}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        )}
      </div>
    </details>
  );
}

// ObserverAgentPanel — surfaces the AI Observer's 15-minute Kimi narrative
// in a readable card. The observer writes one activity-log entry per tick
// under activeRole="observerAgent" with format:
//   "Observer (Kimi): HEADLINE: ... | STATUS: ... | WHAT'S HAPPENING: ...
//      | WHAT'S NOT HAPPENING (but should be): ... | RECOMMENDED ACTION: ..."
// This panel parses that one-liner back into its five sections and renders
// each with appropriate weight + color so the operator can read it without
// hunting through the raw log table.
type ObserverTick = {
  ranAt: string;
  headline: string;
  status: "green" | "yellow" | "red" | "unknown";
  whatsHappening: string;
  whatsNot: string;
  recommendedAction: string;
  raw: string;
};

function parseObserverEntry(entry: ActivityLogEntry): ObserverTick {
  const raw = entry.msg ?? "";
  const body = raw.replace(/^Observer \(Kimi\):\s*/i, "");
  const sections = body.split(/\s*\|\s*/);

  const lookup = (label: RegExp): string => {
    for (const s of sections) {
      const m = s.match(label);
      if (m)
        return s
          .replace(label, "")
          .replace(/^\s*:?\s*/, "")
          .trim();
    }
    return "";
  };

  const headline = lookup(/^HEADLINE\b/i);
  const statusRaw = lookup(/^STATUS\b/i).toLowerCase();
  const status: ObserverTick["status"] =
    statusRaw === "green" || statusRaw === "yellow" || statusRaw === "red"
      ? statusRaw
      : "unknown";
  const whatsHappening = lookup(/^WHAT['’]S HAPPENING\b/i);
  const whatsNot = lookup(/^WHAT['’]S NOT HAPPENING\b[^:]*/i);
  const recommendedAction = lookup(/^RECOMMENDED ACTION\b/i);

  const ranAt = `${entry.timeDate ?? ""} ${entry.timeTime ?? ""}`.trim();
  return {
    ranAt,
    headline: headline || "(no headline)",
    status,
    whatsHappening,
    whatsNot,
    recommendedAction,
    raw
  };
}

function statusBadge(status: ObserverTick["status"]) {
  const color =
    status === "green"
      ? { bg: "#dcfce7", fg: "#15803d", label: "Green" }
      : status === "yellow"
        ? { bg: "#fef9c3", fg: "#a16207", label: "Yellow" }
        : status === "red"
          ? { bg: "#fee2e2", fg: "#b91c1c", label: "Red" }
          : { bg: "#e5e7eb", fg: "#374151", label: "Unknown" };
  return (
    <span
      style={{
        background: color.bg,
        color: color.fg,
        padding: "0.125rem 0.5rem",
        borderRadius: "9999px",
        fontSize: "0.75rem",
        fontWeight: 600,
        textTransform: "uppercase",
        letterSpacing: "0.05em"
      }}
    >
      {color.label}
    </span>
  );
}

type ObserverHistoryRecord = {
  ts: string;
  narrative: string;
};

function tickFromHistoryRecord(rec: ObserverHistoryRecord): ObserverTick {
  // The KV record stores the same one-line narrative `agent.log()` emits,
  // so reuse the same parser by synthesising an ActivityLogEntry shape.
  // `ts` is a full ISO string; the parser only needs a printable label
  // for `ranAt` — splitting on "T" gives the same shape the activity-log
  // formatter produces (date space time).
  const [date = "", timeWithMs = ""] = rec.ts.split("T");
  const time = timeWithMs.replace(/\.\d+Z?$/, "Z");
  return parseObserverEntry({
    msg: rec.narrative,
    timeDate: date,
    timeTime: time,
    level: "info",
    activeRole: "observerAgent"
  } as unknown as ActivityLogEntry);
}

function ObserverAgentPanel({ state }: { state: SEOAgentState }) {
  // The panel draws from two complementary sources:
  //
  //   1. `state.observerLog` — the in-memory ring (40 entries) pushed via
  //      the agent's WebSocket state sync. Real-time but evicted under
  //      sustained pipeline bursts.
  //   2. `/api/observer-history` — KV-backed durable history (7-day TTL,
  //      seeded inside `runObserverTick`). Survives DO eviction, restarts,
  //      and stale-bundle WebSocket-state mismatches; polled every 60s.
  //
  // Merge by `ranAt`, dedup, take newest 20. If both are empty the panel
  // shows the existing "no observations yet" placeholder.
  const observerLog = sanitizeActivityLogEntries(state.observerLog);
  const stateTicks = [...observerLog].reverse().map(parseObserverEntry);

  const [historyTicks, setHistoryTicks] = useState<ObserverTick[]>([]);
  useEffect(() => {
    let cancelled = false;
    async function fetchHistory() {
      try {
        const res = await fetch("/api/observer-history?limit=20", {
          credentials: "same-origin"
        });
        if (!res.ok) return;
        const body = (await res.json()) as {
          ok?: boolean;
          ticks?: ObserverHistoryRecord[];
        };
        if (cancelled || !body.ok || !Array.isArray(body.ticks)) return;
        setHistoryTicks(body.ticks.map(tickFromHistoryRecord));
      } catch {
        // Network blip — keep last known ticks; next poll will retry.
      }
    }
    fetchHistory();
    const id = setInterval(fetchHistory, 60_000);
    return () => {
      cancelled = true;
      clearInterval(id);
    };
  }, []);

  const ticks: ObserverTick[] = (() => {
    const seen = new Set<string>();
    const merged: ObserverTick[] = [];
    for (const t of [...stateTicks, ...historyTicks]) {
      const key = t.ranAt || t.raw.slice(0, 80);
      if (seen.has(key)) continue;
      seen.add(key);
      merged.push(t);
    }
    // Sort newest-first by ranAt (lexicographic over ISO/space-separated
    // timestamps matches chronological order for both sources).
    merged.sort((a, b) => (a.ranAt < b.ranAt ? 1 : a.ranAt > b.ranAt ? -1 : 0));
    return merged.slice(0, 20);
  })();

  const latest = ticks[0];
  const history = ticks.slice(1);

  // Compute age + tier from the latest tick. Both `latest.ranAt` and
  // `state.lastActivity` come from the same `agent.log()` formatter, so
  // the diff is timezone-independent. Boundary semantics and defensive
  // cases (missing timestamps, future ticks) are unit-tested in
  // src/__tests__/observer-health.test.ts.
  const observerHealth = computeObserverHealth(
    latest?.ranAt ?? null,
    state.lastActivity ?? null
  );
  const observerHealthColor = {
    green: "#15803d",
    yellow: "#a16207",
    red: "#b91c1c",
    unknown: "#6b7280"
  }[observerHealth.tier];
  const observerHealthLine =
    observerHealth.ageMinutes === null || !latest
      ? null
      : `Last observer tick: ${observerHealth.ageMinutes} min ago (${latest.ranAt})`;

  return (
    <details
      open
      style={{
        background: "#fff",
        borderRadius: "0.75rem",
        border: "1px solid #e5e7eb",
        padding: "1rem",
        marginBottom: "1rem"
      }}
    >
      <summary
        style={{
          cursor: "pointer",
          userSelect: "none",
          listStyle: "none",
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
          gap: "0.75rem"
        }}
      >
        <div>
          <h2
            style={{
              fontSize: "1.125rem",
              fontWeight: 600,
              color: "#111827",
              margin: 0,
              display: "flex",
              alignItems: "center",
              gap: "0.5rem"
            }}
          >
            <span>👁️</span>
            <span>AI Observer (every 15 min)</span>
          </h2>
          <p
            style={{
              margin: "0.25rem 0 0",
              fontSize: "0.8125rem",
              color: "#6b7280"
            }}
          >
            Kimi K2.5 (via OpenRouter) watches the worker's own state every 15
            minutes and writes a plain-English status report. Read-only — takes
            no actions. Falls back to deterministic counters when the model is
            unavailable.
          </p>
        </div>
        <div
          style={{
            fontSize: "0.75rem",
            color: "#6b7280",
            whiteSpace: "nowrap",
            display: "flex",
            flexDirection: "column",
            alignItems: "flex-end",
            gap: "0.125rem"
          }}
        >
          <span>
            {ticks.length === 0
              ? "no observations yet"
              : `${ticks.length} recent tick${ticks.length === 1 ? "" : "s"}`}
          </span>
          {observerHealthLine && (
            <span style={{ color: observerHealthColor, fontWeight: 600 }}>
              {observerHealthLine}
            </span>
          )}
          <span style={{ color: "#9ca3af" }}>click to collapse</span>
        </div>
      </summary>

      {!latest && (
        <div
          style={{
            marginTop: "0.75rem",
            padding: "1rem",
            background: "#f9fafb",
            borderRadius: "0.5rem",
            fontSize: "0.875rem",
            color: "#6b7280",
            textAlign: "center"
          }}
        >
          No observer ticks yet. First tick fires within a minute of autonomous
          mode starting; subsequent ticks every 15 min.
        </div>
      )}

      {latest && (
        <div
          style={{
            marginTop: "0.75rem",
            padding: "1rem",
            background: "#f9fafb",
            borderRadius: "0.5rem",
            border: "1px solid #e5e7eb"
          }}
        >
          <div
            style={{
              display: "flex",
              alignItems: "center",
              justifyContent: "space-between",
              gap: "0.75rem",
              marginBottom: "0.75rem"
            }}
          >
            <div
              style={{
                fontSize: "1rem",
                fontWeight: 600,
                color: "#111827"
              }}
            >
              {latest.headline}
            </div>
            <div
              style={{
                display: "flex",
                alignItems: "center",
                gap: "0.5rem"
              }}
            >
              {statusBadge(latest.status)}
              <span style={{ fontSize: "0.75rem", color: "#6b7280" }}>
                {latest.ranAt}
              </span>
            </div>
          </div>

          {latest.whatsHappening && (
            <div style={{ marginBottom: "0.625rem" }}>
              <div
                style={{
                  fontSize: "0.6875rem",
                  fontWeight: 700,
                  letterSpacing: "0.05em",
                  textTransform: "uppercase",
                  color: "#6b7280",
                  marginBottom: "0.125rem"
                }}
              >
                What's happening
              </div>
              <div
                style={{
                  fontSize: "0.875rem",
                  color: "#374151",
                  lineHeight: 1.5
                }}
              >
                {latest.whatsHappening}
              </div>
            </div>
          )}

          {latest.whatsNot && (
            <div
              style={{
                marginBottom: "0.625rem",
                padding: "0.5rem 0.75rem",
                background: "#fef3c7",
                borderLeft: "3px solid #f59e0b",
                borderRadius: "0.25rem"
              }}
            >
              <div
                style={{
                  fontSize: "0.6875rem",
                  fontWeight: 700,
                  letterSpacing: "0.05em",
                  textTransform: "uppercase",
                  color: "#92400e",
                  marginBottom: "0.125rem"
                }}
              >
                What's not happening (but should be)
              </div>
              <div
                style={{
                  fontSize: "0.875rem",
                  color: "#78350f",
                  lineHeight: 1.5
                }}
              >
                {latest.whatsNot}
              </div>
            </div>
          )}

          {latest.recommendedAction && (
            <div
              style={{
                padding: "0.5rem 0.75rem",
                background: "#dbeafe",
                borderLeft: "3px solid #2563eb",
                borderRadius: "0.25rem"
              }}
            >
              <div
                style={{
                  fontSize: "0.6875rem",
                  fontWeight: 700,
                  letterSpacing: "0.05em",
                  textTransform: "uppercase",
                  color: "#1e40af",
                  marginBottom: "0.125rem"
                }}
              >
                Recommended action
              </div>
              <div
                style={{
                  fontSize: "0.875rem",
                  color: "#1e3a8a",
                  lineHeight: 1.5
                }}
              >
                {latest.recommendedAction}
              </div>
            </div>
          )}
        </div>
      )}

      {history.length > 0 && (
        <details
          style={{
            marginTop: "0.75rem",
            padding: "0.5rem 0.75rem",
            background: "#f9fafb",
            borderRadius: "0.5rem",
            border: "1px solid #e5e7eb"
          }}
        >
          <summary
            style={{
              cursor: "pointer",
              fontSize: "0.8125rem",
              fontWeight: 600,
              color: "#374151"
            }}
          >
            Previous {history.length} tick{history.length === 1 ? "" : "s"}
          </summary>
          <ul
            style={{
              listStyle: "none",
              padding: 0,
              margin: "0.5rem 0 0",
              display: "flex",
              flexDirection: "column",
              gap: "0.375rem"
            }}
          >
            {history.map((t, i) => (
              <li
                key={i}
                style={{
                  fontSize: "0.8125rem",
                  color: "#374151",
                  padding: "0.375rem 0.5rem",
                  background: "#fff",
                  borderRadius: "0.25rem",
                  border: "1px solid #e5e7eb",
                  display: "flex",
                  gap: "0.5rem",
                  alignItems: "baseline"
                }}
              >
                {statusBadge(t.status)}
                <span style={{ color: "#9ca3af", fontSize: "0.6875rem" }}>
                  {t.ranAt}
                </span>
                <span style={{ flex: 1 }}>{t.headline}</span>
              </li>
            ))}
          </ul>
        </details>
      )}
    </details>
  );
}

// Published Article Log panel — structured table of the last 50 published
// articles, newest first. Reads `state.recentPublishedArticles`, populated
// from the success block in server.ts where `articlesGenerated` increments.
// One row per article: keyword, category, SEO score, word count, published
// timestamp, and direct links to the live page + KV admin endpoint.
function PublishedArticleLogPanel({ state }: { state: SEOAgentState }) {
  const rows = state.recentPublishedArticles ?? [];

  return (
    <details
      open
      style={{
        background: "#fff",
        borderRadius: "0.75rem",
        border: "1px solid #e5e7eb",
        padding: "1rem",
        marginBottom: "1rem"
      }}
    >
      <summary
        style={{
          cursor: "pointer",
          userSelect: "none",
          listStyle: "none",
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
          gap: "0.75rem"
        }}
      >
        <div>
          <h2
            style={{
              fontSize: "1.125rem",
              fontWeight: 600,
              color: "#111827",
              margin: 0,
              display: "flex",
              alignItems: "center",
              gap: "0.5rem"
            }}
          >
            <span>📰</span>
            <span>Published Article Log</span>
          </h2>
          <p
            style={{
              margin: "0.25rem 0 0",
              fontSize: "0.8125rem",
              color: "#6b7280"
            }}
          >
            Last {rows.length === 0 ? "50" : rows.length} published articles,
            newest first. SEO score ≥70 is a pass; click the URL to load the
            live page or the kvKey to fetch the raw HTML via /api/admin/kv.
          </p>
        </div>
        <div
          style={{
            fontSize: "0.75rem",
            color: "#6b7280",
            whiteSpace: "nowrap",
            display: "flex",
            flexDirection: "column",
            alignItems: "flex-end",
            gap: "0.125rem"
          }}
        >
          <span>
            {rows.length === 0
              ? "no articles yet"
              : `${rows.length} article${rows.length === 1 ? "" : "s"}`}
          </span>
          <span style={{ color: "#9ca3af" }}>click to collapse</span>
        </div>
      </summary>

      <div
        style={{
          marginTop: "0.75rem",
          maxHeight: "420px",
          overflowY: "auto",
          scrollbarGutter: "stable",
          background: "#fafafa",
          borderRadius: "0.5rem"
        }}
      >
        {rows.length === 0 ? (
          <div
            style={{
              padding: "1.25rem",
              color: "#6b7280",
              fontSize: "0.875rem",
              textAlign: "center"
            }}
          >
            No articles published yet — once the pipeline ships its first
            article, rows will appear here newest first.
          </div>
        ) : (
          <table
            style={{
              width: "100%",
              borderCollapse: "collapse",
              fontSize: "0.8125rem",
              tableLayout: "fixed"
            }}
          >
            <thead>
              <tr
                style={{
                  background: "#f3f4f6",
                  color: "#374151",
                  textAlign: "left",
                  position: "sticky",
                  top: 0
                }}
              >
                <th style={{ padding: "0.5rem 0.625rem", width: "28%" }}>
                  Keyword
                </th>
                <th style={{ padding: "0.5rem 0.625rem", width: "18%" }}>
                  Category
                </th>
                <th
                  style={{
                    padding: "0.5rem 0.625rem",
                    width: "8%",
                    textAlign: "right"
                  }}
                >
                  SEO
                </th>
                <th
                  style={{
                    padding: "0.5rem 0.625rem",
                    width: "8%",
                    textAlign: "right"
                  }}
                >
                  Words
                </th>
                <th style={{ padding: "0.5rem 0.625rem", width: "20%" }}>
                  Published
                </th>
                <th
                  style={{
                    padding: "0.5rem 1.25rem 0.5rem 0.625rem",
                    width: "18%"
                  }}
                >
                  Links
                </th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => {
                const seoPass = r.seoScore >= 70;
                const seoColor = seoPass ? "#059669" : "#dc2626";
                const ts = r.publishedAt
                  ? new Date(r.publishedAt).toLocaleString()
                  : "—";
                return (
                  <tr
                    key={`${r.kvKey || r.url}-${r.publishedAt}`}
                    style={{ borderTop: "1px solid #e5e7eb" }}
                  >
                    <td
                      style={{
                        padding: "0.5rem 0.625rem",
                        color: "#111827",
                        overflow: "hidden",
                        textOverflow: "ellipsis",
                        whiteSpace: "nowrap"
                      }}
                      title={r.keyword}
                    >
                      {r.keyword || "(unknown)"}
                    </td>
                    <td
                      style={{
                        padding: "0.5rem 0.625rem",
                        color: "#6b7280",
                        overflow: "hidden",
                        textOverflow: "ellipsis",
                        whiteSpace: "nowrap"
                      }}
                      title={r.categorySlug}
                    >
                      {r.categorySlug || "—"}
                    </td>
                    <td
                      style={{
                        padding: "0.5rem 0.625rem",
                        color: seoColor,
                        fontWeight: 600,
                        textAlign: "right"
                      }}
                    >
                      {r.seoScore || 0}
                    </td>
                    <td
                      style={{
                        padding: "0.5rem 0.625rem",
                        color: "#374151",
                        textAlign: "right"
                      }}
                    >
                      {r.wordCount || 0}
                    </td>
                    <td
                      style={{
                        padding: "0.5rem 0.625rem",
                        color: "#6b7280",
                        overflow: "hidden",
                        textOverflow: "ellipsis",
                        whiteSpace: "nowrap"
                      }}
                      title={ts}
                    >
                      {ts}
                    </td>
                    <td
                      style={{
                        padding: "0.5rem 1.25rem 0.5rem 0.625rem",
                        whiteSpace: "nowrap"
                      }}
                    >
                      {r.url ? (
                        <a
                          href={r.url}
                          target="_blank"
                          rel="noreferrer noopener"
                          style={{
                            color: "#2563eb",
                            marginRight: "0.75rem"
                          }}
                        >
                          live
                        </a>
                      ) : null}
                      {r.kvKey ? (
                        <a
                          href={`/api/admin/kv/${encodeURIComponent(r.kvKey)}`}
                          target="_blank"
                          rel="noreferrer noopener"
                          style={{ color: "#6b7280" }}
                        >
                          kv
                        </a>
                      ) : null}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        )}
      </div>
    </details>
  );
}

// n8n Workflow panel — surfaces every activity-log entry written under
// role "n8n", which covers both directions of the n8n bridge:
//   - Outbound: notifyN8nPublishSuccess() in src/pipeline/n8n-webhook.ts
//     logs an entry after every successful publish webhook fire/skip/fail.
//   - Inbound: POST /api/n8n/log (bearer-protected with N8N_WEBHOOK_SECRET)
//     lets n8n itself write status entries back into the dashboard.
const N8N_WORKFLOW_URL =
  "https://n8n.srv828840.hstgr.cloud/workflow/uNEW9VwdSTSTVdsR?projectId=5zmgEWZkx85HpsbT";

// ── Infrastructure Activity Monitor ──────────────────────────────────────────
// Three live feeds (GitHub / OpenAI / Milvus) for engineering observability.
// Polls every 10s. Status-dot summary at the top. Each section scrollable,
// newest-first, capped at 50 rows.

interface InfraGithubResp {
  ok: boolean;
  available?: boolean;
  reason?: string;
  workflowRuns?: Array<{
    id: number;
    name: string;
    status: string;
    conclusion: string | null;
    headBranch: string;
    event: string;
    createdAt: string;
    htmlUrl: string;
  }>;
  pullRequests?: Array<{
    number: number;
    title: string;
    state: string;
    user: string;
    headRef: string;
    updatedAt: string;
    htmlUrl: string;
    merged: boolean;
  }>;
}
interface InfraOpenAiResp {
  ok: boolean;
  rows?: Array<{
    timestamp: string;
    model: string;
    promptTokens: number;
    completionTokens: number;
    latencyMs: number;
    status: "ok" | "error";
    errorReason?: string;
  }>;
  stats?: {
    calls: number;
    errorCalls: number;
    totalPromptTokens: number;
    totalCompletionTokens: number;
    estimatedUsdTotal: number;
    estimatedUsdTotalFormatted: string;
  };
}
interface InfraMilvusResp {
  ok: boolean;
  rows?: Array<{
    timestamp: string;
    collection: string;
    hits: number;
    latencyMs: number;
    status: "ok" | "error";
    errorReason?: string;
  }>;
  collection?: {
    name: string;
    vectorCount: number | null;
    ok: boolean;
    reason?: string;
  } | null;
}

function StatusDot({
  status
}: {
  status: "green" | "yellow" | "red" | "unknown";
}) {
  const color =
    status === "green"
      ? "#10b981"
      : status === "yellow"
        ? "#f59e0b"
        : status === "red"
          ? "#ef4444"
          : "#9ca3af";
  return (
    <span
      style={{
        display: "inline-block",
        width: "0.625rem",
        height: "0.625rem",
        borderRadius: "50%",
        background: color,
        marginRight: "0.375rem"
      }}
      title={status}
    />
  );
}

function dotFromRowTimestamp(
  newestRow: { timestamp?: string; isError: boolean } | null
): "green" | "yellow" | "red" | "unknown" {
  if (!newestRow) return "unknown";
  if (newestRow.isError) return "red";
  if (!newestRow.timestamp) return "unknown";
  const t = Date.parse(newestRow.timestamp);
  if (!Number.isFinite(t)) return "unknown";
  const age = Date.now() - t;
  return age <= 5 * 60 * 1000 ? "green" : "yellow";
}

function InfrastructureActivityMonitorPanel() {
  const [gh, setGh] = useState<InfraGithubResp | null>(null);
  const [oa, setOa] = useState<InfraOpenAiResp | null>(null);
  const [mv, setMv] = useState<InfraMilvusResp | null>(null);
  const [lastFetch, setLastFetch] = useState<number>(0);

  useEffect(() => {
    let cancelled = false;
    const fetchAll = async () => {
      try {
        // /api/dashboard/* — cookie-auth protected; browser sends the
        // dashboard cookie automatically. Previous /api/admin/* paths
        // were bearer-gated and 401'd in the browser (Copilot review
        // feedback on #5480).
        const [r1, r2, r3] = await Promise.all([
          fetch("/api/dashboard/github-events?limit=25").then((r) =>
            r.ok ? (r.json() as Promise<InfraGithubResp>) : null
          ),
          fetch("/api/dashboard/openai-activity?limit=50").then((r) =>
            r.ok ? (r.json() as Promise<InfraOpenAiResp>) : null
          ),
          fetch("/api/dashboard/milvus-activity?limit=50").then((r) =>
            r.ok ? (r.json() as Promise<InfraMilvusResp>) : null
          )
        ]);
        if (cancelled) return;
        if (r1) setGh(r1);
        if (r2) setOa(r2);
        if (r3) setMv(r3);
        setLastFetch(Date.now());
      } catch {
        /* swallow — next tick retries */
      }
    };
    fetchAll();
    const t = setInterval(fetchAll, 10_000);
    return () => {
      cancelled = true;
      clearInterval(t);
    };
  }, []);

  // Status-dot logic per feed (newest row in each feed).
  const ghNewest = gh?.workflowRuns?.[0];
  const ghDot = dotFromRowTimestamp(
    ghNewest
      ? {
          timestamp: ghNewest.createdAt,
          isError: ghNewest.conclusion === "failure"
        }
      : null
  );
  const oaNewest = oa?.rows?.[0];
  const oaDot = dotFromRowTimestamp(
    oaNewest
      ? { timestamp: oaNewest.timestamp, isError: oaNewest.status === "error" }
      : null
  );
  const mvNewest = mv?.rows?.[0];
  const mvDot = dotFromRowTimestamp(
    mvNewest
      ? { timestamp: mvNewest.timestamp, isError: mvNewest.status === "error" }
      : null
  );

  const headerStyle: React.CSSProperties = {
    fontSize: "0.875rem",
    fontWeight: 600,
    color: "#374151",
    marginBottom: "0.375rem",
    display: "flex",
    alignItems: "center",
    gap: "0.5rem"
  };
  const sectionStyle: React.CSSProperties = {
    background: "#f9fafb",
    border: "1px solid #e5e7eb",
    borderRadius: "0.5rem",
    padding: "0.75rem",
    maxHeight: "20rem",
    overflowY: "auto"
  };
  const rowStyle: React.CSSProperties = {
    fontSize: "0.75rem",
    padding: "0.25rem 0",
    borderBottom: "1px solid #e5e7eb",
    fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace",
    color: "#374151"
  };
  const errorRowStyle: React.CSSProperties = {
    ...rowStyle,
    color: "#b91c1c",
    background: "#fef2f2"
  };

  return (
    <details
      open
      style={{
        background: "#fff",
        borderRadius: "0.75rem",
        border: "1px solid #e5e7eb",
        padding: "1rem",
        marginBottom: "1rem"
      }}
    >
      <summary
        style={{
          cursor: "pointer",
          userSelect: "none",
          listStyle: "none"
        }}
      >
        <h2
          style={{
            fontSize: "1.125rem",
            fontWeight: 600,
            color: "#111827",
            margin: 0,
            display: "flex",
            alignItems: "center",
            gap: "0.5rem"
          }}
        >
          cats-seo-aiagent-cloudflare Activity Monitor
          <span
            style={{
              marginLeft: "0.5rem",
              fontSize: "0.75rem",
              color: "#6b7280"
            }}
          >
            <StatusDot status={ghDot} />
            GitHub
            <span style={{ margin: "0 0.5rem" }} />
            <StatusDot status={oaDot} />
            OpenAI
            <span style={{ margin: "0 0.5rem" }} />
            <StatusDot status={mvDot} />
            Milvus
          </span>
        </h2>
        <div
          style={{
            fontSize: "0.75rem",
            color: "#6b7280",
            marginTop: "0.25rem"
          }}
        >
          Auto-refresh every 10s.{" "}
          {lastFetch
            ? `Last fetch ${new Date(lastFetch).toLocaleTimeString()}`
            : "Loading…"}
        </div>
      </summary>

      <div
        style={{
          display: "grid",
          gridTemplateColumns: "repeat(auto-fit, minmax(20rem, 1fr))",
          gap: "1rem",
          marginTop: "0.75rem"
        }}
      >
        {/* GITHUB */}
        <div>
          <div style={headerStyle}>
            <StatusDot status={ghDot} />
            GitHub — cats-seo-aiagent-cloudflare
          </div>
          <div style={sectionStyle}>
            {gh?.available === false ? (
              <div style={{ fontSize: "0.75rem", color: "#6b7280" }}>
                Not configured: {gh.reason ?? "GITHUB_TOKEN_SECRET missing"}
              </div>
            ) : !gh ? (
              <div style={{ fontSize: "0.75rem", color: "#6b7280" }}>
                Loading…
              </div>
            ) : (
              <>
                {(gh.workflowRuns ?? []).slice(0, 25).map((r) => {
                  const isErr = r.conclusion === "failure";
                  const badge =
                    r.conclusion === "success"
                      ? "🟢"
                      : isErr
                        ? "🔴"
                        : r.conclusion === "cancelled" ||
                            r.conclusion === "skipped"
                          ? "⚪️"
                          : "🟡";
                  return (
                    <div
                      key={`run-${r.id}`}
                      style={isErr ? errorRowStyle : rowStyle}
                    >
                      {badge}{" "}
                      <a
                        href={r.htmlUrl}
                        target="_blank"
                        rel="noopener noreferrer"
                        style={{
                          color: "inherit",
                          textDecoration: "underline"
                        }}
                      >
                        {r.name}
                      </a>{" "}
                      [{r.headBranch}] {r.status}/{r.conclusion ?? "—"} ·{" "}
                      {r.createdAt.slice(0, 19).replace("T", " ")}
                    </div>
                  );
                })}
                {(gh.pullRequests ?? []).slice(0, 10).map((p) => (
                  <div key={`pr-${p.number}`} style={rowStyle}>
                    {p.merged ? "🟣" : p.state === "open" ? "🔵" : "⚪️"}{" "}
                    <a
                      href={p.htmlUrl}
                      target="_blank"
                      rel="noopener noreferrer"
                      style={{ color: "inherit", textDecoration: "underline" }}
                    >
                      #{p.number} {p.title}
                    </a>{" "}
                    by {p.user} · {p.headRef} ·{" "}
                    {p.updatedAt.slice(0, 19).replace("T", " ")}
                  </div>
                ))}
              </>
            )}
          </div>
        </div>

        {/* OPENAI */}
        <div>
          <div style={headerStyle}>
            <StatusDot status={oaDot} />
            OpenAI — Embedding & API Health
          </div>
          <div style={{ ...sectionStyle, maxHeight: "20rem" }}>
            {!oa ? (
              <div style={{ fontSize: "0.75rem", color: "#6b7280" }}>
                Loading…
              </div>
            ) : oa.stats && oa.stats.calls === 0 ? (
              <div style={{ fontSize: "0.75rem", color: "#6b7280" }}>
                No OpenAI calls yet in the window.
              </div>
            ) : (
              <>
                <div
                  style={{
                    fontSize: "0.75rem",
                    color: "#374151",
                    marginBottom: "0.5rem",
                    fontWeight: 600
                  }}
                >
                  {oa.stats?.calls ?? 0} calls · {oa.stats?.errorCalls ?? 0}{" "}
                  errors · {oa.stats?.totalPromptTokens ?? 0} prompt tokens ·{" "}
                  cost ≈ {oa.stats?.estimatedUsdTotalFormatted ?? "$0.0000"}
                </div>
                {(oa.rows ?? []).map((r, i) => (
                  <div
                    key={`oa-${i}`}
                    style={r.status === "error" ? errorRowStyle : rowStyle}
                  >
                    {r.timestamp} · {r.model} · tokens={r.promptTokens} ·{" "}
                    {r.latencyMs}ms · {r.status}
                    {r.errorReason ? ` · ${r.errorReason}` : ""}
                  </div>
                ))}
              </>
            )}
          </div>
        </div>

        {/* MILVUS */}
        <div>
          <div style={headerStyle}>
            <StatusDot status={mvDot} />
            Milvus / Zilliz — Vector DB Health
          </div>
          <div style={sectionStyle}>
            {!mv ? (
              <div style={{ fontSize: "0.75rem", color: "#6b7280" }}>
                Loading…
              </div>
            ) : (
              <>
                {mv.collection ? (
                  <div
                    style={{
                      fontSize: "0.75rem",
                      color: mv.collection.ok ? "#374151" : "#b91c1c",
                      marginBottom: "0.5rem",
                      fontWeight: 600
                    }}
                  >
                    Collection: {mv.collection.name} · vectors=
                    {mv.collection.vectorCount ?? "—"}
                    {mv.collection.reason ? ` · ${mv.collection.reason}` : ""}
                  </div>
                ) : null}
                {(mv.rows ?? []).length === 0 ? (
                  <div style={{ fontSize: "0.75rem", color: "#6b7280" }}>
                    No Milvus calls yet in the window.
                  </div>
                ) : (
                  (mv.rows ?? []).map((r, i) => (
                    <div
                      key={`mv-${i}`}
                      style={r.status === "error" ? errorRowStyle : rowStyle}
                    >
                      {r.timestamp} · {r.collection} · hits={r.hits} ·{" "}
                      {r.latencyMs}ms · {r.status}
                      {r.errorReason ? ` · ${r.errorReason}` : ""}
                    </div>
                  ))
                )}
              </>
            )}
          </div>
        </div>
      </div>
    </details>
  );
}

function N8nAgentPanel({ state }: { state: SEOAgentState }) {
  const entries = [...getActivityLogEntries(state)]
    .filter((e) => e.activeRole === "n8n")
    .reverse()
    .slice(0, 50);

  return (
    <details
      open
      style={{
        background: "#fff",
        borderRadius: "0.75rem",
        border: "1px solid #e5e7eb",
        padding: "1rem",
        marginBottom: "1rem"
      }}
    >
      <summary
        style={{
          cursor: "pointer",
          userSelect: "none",
          listStyle: "none",
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
          gap: "0.75rem"
        }}
      >
        <div>
          <h2
            style={{
              fontSize: "1.125rem",
              fontWeight: 600,
              color: "#111827",
              margin: 0,
              display: "flex",
              alignItems: "center",
              gap: "0.5rem"
            }}
          >
            <img
              src="/n8n-logo.svg"
              alt="n8n"
              width={20}
              height={20}
              style={{ display: "block" }}
            />
            <span>n8n Workflow</span>
          </h2>
          <p
            style={{
              margin: "0.25rem 0 0",
              fontSize: "0.8125rem",
              color: "#6b7280"
            }}
          >
            Webhooks fired from this pipeline to your n8n instance after every
            successful publish. n8n posts status back here via /api/n8n/log.{" "}
            <a
              href={N8N_WORKFLOW_URL}
              target="_blank"
              rel="noopener noreferrer"
              style={{ color: "#ea4b71", fontWeight: 500 }}
              onClick={(e) => e.stopPropagation()}
            >
              Open workflow in n8n →
            </a>
          </p>
        </div>
        <div
          style={{
            fontSize: "0.75rem",
            color: "#6b7280",
            whiteSpace: "nowrap",
            display: "flex",
            flexDirection: "column",
            alignItems: "flex-end",
            gap: "0.125rem"
          }}
        >
          <span>
            {entries.length > 0
              ? `${entries.length} event${entries.length === 1 ? "" : "s"}`
              : "idle"}
          </span>
          <span style={{ color: "#9ca3af" }}>click to collapse</span>
        </div>
      </summary>

      <div
        style={{
          marginTop: "0.75rem",
          height: "360px",
          overflowY: "auto",
          paddingRight: "0.25rem",
          background: "#fafafa",
          borderRadius: "0.5rem"
        }}
      >
        {entries.length === 0 ? (
          <div
            style={{
              height: "100%",
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              padding: "1.25rem",
              color: "#6b7280",
              fontSize: "0.875rem",
              textAlign: "center"
            }}
          >
            n8n is idle — events appear here after a publish fires the webhook
            or when n8n posts back to /api/n8n/log.
          </div>
        ) : (
          <div
            style={{
              display: "flex",
              flexDirection: "column",
              gap: "0.5rem",
              padding: "0.5rem"
            }}
          >
            {entries.map((entry) => {
              const isError = isActivityLogErrorLevel(entry.level);
              const isWarning = isActivityLogWarningLevel(entry.level);
              const accent = isError
                ? "#dc2626"
                : isWarning
                  ? "#d97706"
                  : "#ea4b71";
              return (
                <div
                  key={entry.logRef}
                  style={{
                    padding: "0.625rem 0.75rem",
                    background: "#f9fafb",
                    borderLeft: `3px solid ${accent}`,
                    borderRadius: "0.25rem",
                    fontSize: "0.8125rem",
                    color: "#111827"
                  }}
                >
                  <div
                    style={{
                      display: "flex",
                      gap: "0.75rem",
                      alignItems: "baseline",
                      flexWrap: "wrap"
                    }}
                  >
                    <span
                      style={{
                        fontFamily: "ui-monospace, monospace",
                        fontSize: "0.75rem",
                        color: "#6b7280"
                      }}
                    >
                      {entry.timeDate} {entry.timeTime}
                    </span>
                    <span
                      style={{
                        color: isError
                          ? "#b91c1c"
                          : isWarning
                            ? "#92400e"
                            : "#374151"
                      }}
                    >
                      {entry.msg}
                    </span>
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </div>
    </details>
  );
}

function PipelineDiagrams({ state }: { state: SEOAgentState }) {
  const flowDiagram = buildPipelineFlowDiagram(state.currentStep);
  const statusDiagram = buildStatusDiagram(state.status);
  const progressDiagram = buildProgressDiagram(
    state.articlesGenerated,
    state.articlesFailed,
    state.categoriesCompleted,
    state.avgSeoScore
  );

  return (
    <details
      style={{
        background: "#fff",
        borderRadius: "0.75rem",
        border: "1px solid #e5e7eb",
        padding: "1rem",
        marginBottom: "1.5rem"
      }}
    >
      <summary
        style={{
          cursor: "pointer",
          fontWeight: 600,
          fontSize: "1rem",
          color: "#111827",
          userSelect: "none",
          listStyle: "none",
          display: "flex",
          alignItems: "center",
          gap: "0.5rem"
        }}
      >
        <span>📊</span>
        <span>Pipeline Diagrams</span>
        <span
          style={{
            marginLeft: "auto",
            fontSize: "0.75rem",
            color: "#6b7280",
            fontWeight: 400
          }}
        >
          click to expand
        </span>
      </summary>

      <div
        style={{
          marginTop: "1rem",
          display: "grid",
          gridTemplateColumns: "1fr 1fr",
          gap: "1rem"
        }}
      >
        {/* Pipeline Flow */}
        <div>
          <h3
            style={{
              fontSize: "0.875rem",
              fontWeight: 600,
              color: "#374151",
              marginBottom: "0.5rem",
              marginTop: 0
            }}
          >
            Pipeline Steps
          </h3>
          <MermaidChart
            key={state.currentStep || "idle"}
            diagram={flowDiagram}
          />
        </div>

        {/* Status Machine */}
        <div>
          <h3
            style={{
              fontSize: "0.875rem",
              fontWeight: 600,
              color: "#374151",
              marginBottom: "0.5rem",
              marginTop: 0
            }}
          >
            Status Machine
          </h3>
          <MermaidChart key={state.status} diagram={statusDiagram} />

          {/* Progress Chart */}
          <h3
            style={{
              fontSize: "0.875rem",
              fontWeight: 600,
              color: "#374151",
              marginBottom: "0.5rem",
              marginTop: "1rem"
            }}
          >
            Article Progress
          </h3>
          <MermaidChart
            key={`${state.articlesGenerated}-${state.articlesFailed}`}
            diagram={progressDiagram}
          />
        </div>
      </div>
    </details>
  );
}
