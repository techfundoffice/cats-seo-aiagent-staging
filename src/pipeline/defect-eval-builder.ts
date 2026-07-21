/**
 * defect-eval-builder.ts — Stage 3 of the per-defect-class
 * self-improving loop.
 *
 * What this module adds:
 *
 *   Given a defect class with N captured findings (Stage 1) that has
 *   crossed the pattern trigger (Stage 2), build an `EvalSpec`: a
 *   bounded sample set + a mechanical success criterion that a
 *   downstream Copilot fix must satisfy *before* opening its PR.
 *
 * The OpenAI/Thrive piece names this as the load-bearing piece of
 * the loop:
 *
 *   "Repeated findings become clear eval targets for Codex to improve…
 *    Codex isn't working solely with a sub-par final output. It inspects
 *    the trace, eval, repo, and skills together."
 *
 * Without the eval, Stage 4's `claude-fix` issue is just a bug
 * report. With the eval, it's a bounded task with a measurable
 * success condition — the difference between "Copilot please fix
 * this" and "Copilot's fix is accepted iff `passed >= 3 of 3`."
 *
 * Scope: one defect class per call. `buildEvalSet(agent,
 * 'rewrite-fragment-not-document')` produces an `EvalSpec` keyed off
 * a runId; `readEvalSet(agent, runId)` retrieves it for the runner
 * (Stage 5) and the escalation runbook (Stage 4).
 */

import { errMsg } from "./http-utils";
import type { SEOArticleAgent } from "../server";
import { readFindings, type DefectClass } from "./defect-findings";

/**
 * Number of representative samples baked into each eval. Three is the
 * sweet spot: enough for the success criterion to require Copilot's
 * fix to generalise (not pass by overfitting to one case), few enough
 * that the Stage 5 runner can evaluate all three within Workers' CPU
 * budget. The OpenAI piece uses "representative source packages" — 3
 * is the implicit count their examples imply.
 */
const SAMPLES_PER_EVAL = 3;

/**
 * One mechanical check on the candidate rewrite output. Either a
 * regex pattern that must (or must not) match, or a computed
 * comparison (e.g. JSON-LD block count >= baseline). The Stage 5
 * runner evaluates each check per-sample; aggregate pass requires
 * `samplesPassed >= passThreshold.samplesPassed of passThreshold.of`.
 */
export type EvalCheck =
  | {
      kind: "regex-must-match";
      id: string;
      pattern: string;
      flags?: string;
    }
  | {
      kind: "regex-must-not-match";
      id: string;
      pattern: string;
      flags?: string;
    }
  | {
      kind: "jsonld-block-count-gte-original";
      id: string;
    }
  | {
      kind: "seo-score-delta-gte";
      id: string;
      threshold: number;
    };

export interface EvalSpec {
  /** Canonical handle for this finding-to-fix cycle. */
  runId: string;
  defectClass: DefectClass;
  /** UTC ISO. */
  createdAt: string;
  /**
   * Representative kvKeys + pointers to their production traces.
   * Sample selection: take the N most recent distinct kvKeys from the
   * findings blob; "distinct" prevents one bad article retried 5x
   * from monopolising the eval set.
   */
  samples: Array<{
    kvKey: string;
    /** When this sample's finding was captured. */
    findingTimestamp: string;
    /**
     * Snapshot key that holds the pre-rewrite original HTML. This is
     * the "expected document shape" reference for checks that compare
     * the candidate's output against the original.
     */
    snapshotKey: string | null;
  }>;
  /**
   * Per-sample success criteria. The Stage 5 runner applies these
   * mechanically; no LLM in the loop. The OpenAI piece's "refine the
   * grader" path matches: when an eval is too lax or too strict, edit
   * the checks here in a follow-up cycle.
   */
  successCriterion: {
    perSample: EvalCheck[];
    passThreshold: {
      samplesPassed: number;
      of: number;
    };
  };
  /**
   * Human-readable rationale for each check. Surfaced in the Stage 4
   * `claude-fix` issue body so Copilot understands WHY each criterion
   * exists — not just what it checks.
   */
  rationale: Record<string, string>;
}

function runIdFor(defectClass: DefectClass): string {
  return `${defectClass}:${new Date().toISOString().replace(/[:.]/g, "-")}`;
}

function evalSpecKey(runId: string): string {
  return `eval-set:${runId}`;
}

/**
 * Regex source string for the `no-fabricated-testing-claim` eval check
 * used by the `prepub-fabricated-testing-claim` defect class.
 *
 * Alternation groups (all case-insensitive via the `"i"` flag):
 *   (1) first-person-test  — "we tested/tried/evaluated/reviewed …"
 *   (2) first-person-team  — "our team tested/evaluated/reviewed …"
 *   (3) first-person-gerund — "our testing …"
 *   (4) hands-on-framing   — "hands-on [up to 3 adj] testing/evaluation …"
 *   (5) self-endorsement-verb — "personally tested/reviewed/vetted …"
 *   (6) self-endorsement-stand — "stands behind every/each/all product …"
 *
 * Mirrors the highest-signal triggers from `detectFabricatedTestingClaims`
 * (fabricated-testing-claims.ts) so the eval runner agrees with the Step
 * 14.7 publish gate when deciding whether the defect is resolved.
 */
const PREPUB_FABRICATED_TESTING_CLAIM_PATTERN = [
  // (1) first-person-test
  "\\bwe\\s+(?:tested|tried|trialled|trialed|evaluated|reviewed|compared|assessed|measured|benchmarked)\\b",
  // (2) first-person-team
  "\\bour\\s+team\\s+(?:tested|tried|evaluated|trialled|trialed|reviewed|assessed)\\b",
  // (3) first-person-gerund
  "\\bour\\s+testing\\b",
  // (4) hands-on-framing (allows up to 3 intervening adjective tokens)
  "\\bhands[-\\s]?on\\s+(?:\\w+\\s+){0,3}(?:testing|evaluation|review|trial|tested|reviewed|evaluated)\\b",
  // (5) self-endorsement-verb
  "\\bpersonally\\s+(?:tested|tried|reviews?|reviewed|vets?|vetted|evaluates?|evaluated)\\b",
  // (6) self-endorsement-stand
  "\\bstands?\\s+behind\\s+(?:every|each|all)\\s+(?:product|recommendation|pick|review)\\b"
].join("|");

/**
 * Map a defect class to its success-criterion template. Each entry
 * encodes the *type* of failure the class represents and the
 * mechanical checks that must pass for a candidate fix to be
 * considered effective.
 *
 * Exported so the test suite can pin every wired defect class against
 * its expected check count and check IDs without going through the
 * async `buildEvalSet` path.
 */
export function templateForDefectClass(defectClass: DefectClass): {
  checks: EvalCheck[];
  rationale: Record<string, string>;
} {
  switch (defectClass) {
    case "rewrite-fragment-not-document":
      return {
        checks: [
          {
            kind: "regex-must-match",
            id: "starts-with-doctype",
            pattern: "^\\s*<!DOCTYPE\\s+html",
            flags: "i"
          },
          {
            kind: "regex-must-match",
            id: "has-html-element",
            pattern: "<html\\b",
            flags: "i"
          },
          {
            kind: "regex-must-match",
            id: "has-head-element",
            pattern: "<head\\b",
            flags: "i"
          },
          {
            kind: "regex-must-match",
            id: "has-body-element",
            pattern: "<body\\b",
            flags: "i"
          },
          { kind: "jsonld-block-count-gte-original", id: "jsonld-preserved" },
          {
            kind: "seo-score-delta-gte",
            id: "seo-not-regressed",
            threshold: -5
          }
        ],
        rationale: {
          "starts-with-doctype":
            "The KV-stored article is a full HTML document; rewrite that doesn't start with <!DOCTYPE html> means Kimi returned a fragment.",
          "has-html-element": "Full document requires the <html> root.",
          "has-head-element":
            "Without <head>, the live page loses <title>, meta tags, og:image, JSON-LD — every SEO/social signal.",
          "has-body-element":
            "Without <body>, no rendered content reaches the reader.",
          "jsonld-preserved":
            "Rich Results eligibility depends on the JSON-LD block count being preserved.",
          "seo-not-regressed":
            "Even with all of the above, the 100-point SEO score must not drop more than 5 points (existing regression-guard threshold)."
        }
      };
    case "itemlist-doubled-best":
      return {
        checks: [
          {
            kind: "regex-must-not-match",
            id: "no-doubled-best-in-itemlist-name",
            pattern: '"name"\\s*:\\s*"Best best\\b',
            flags: "i"
          },
          {
            kind: "regex-must-not-match",
            id: "no-doubled-best-anywhere-in-html",
            pattern: "\\bBest best\\b",
            flags: ""
          }
        ],
        rationale: {
          "no-doubled-best-in-itemlist-name":
            'JSON-LD ItemList.name with "Best best ..." is a doubled-prefix bug — Schema.org markup is crawler-visible and Google may penalize the rich-results card. Root cause: the ItemList builder unconditionally prepends "Best " even when the keyword already starts with "best".',
          "no-doubled-best-anywhere-in-html":
            'Belt-and-suspenders: even outside JSON-LD, a literal "Best best" anywhere in the rendered HTML is a content-fingerprint bug that hurts perceived quality.'
        }
      };
    case "product-name-truncation":
      return {
        checks: [
          {
            kind: "regex-must-not-match",
            id: "no-product-name-mid-name-truncation",
            pattern:
              "\\w\\s*\\.{3,}\\s+(?:provides|ranks|offers|features|delivers|comes|works|stands|gives|brings|includes)",
            flags: "i"
          }
        ],
        rationale: {
          "no-product-name-mid-name-truncation":
            "Product names ending in `...` followed by a sentence verb (provides, ranks, offers, etc.) indicate the product name was truncated mid-token and concatenated awkwardly with prose. Real example: 'Wellness Monitoring for... provides superior...' — visible to readers as broken-looking content."
        }
      };
    case "missing-why-we-like-blurb":
      return {
        checks: [
          {
            kind: "regex-must-match",
            id: "has-why-we-like-this-pick-marker",
            pattern: "Why we like this pick",
            flags: "i"
          }
        ],
        rationale: {
          "has-why-we-like-this-pick-marker":
            "Every product pick in an Our-Top-Picks block must end with 'Why we like this pick:' followed by the rationale. The marker's complete absence means the product-blurb template skipped its closing line — readers see a pick with no editorial endorsement."
        }
      };
    case "faq-near-duplicate-questions":
      return {
        checks: [
          {
            kind: "regex-must-not-match",
            id: "no-trivial-noun-shuffle-faq-duplicates",
            pattern:
              "What is the best cat (?:tracker|GPS|GPS collar)\\?[\\s\\S]{0,2000}?What is the best cat (?:tracker|GPS|GPS collar)\\?",
            flags: "i"
          }
        ],
        rationale: {
          "no-trivial-noun-shuffle-faq-duplicates":
            "FAQ generation must not emit three near-identical questions distinguished only by one swapped noun ('best cat tracker' / 'best cat GPS' / 'best cat GPS collar'). Real example shipped 2026-05-28; this is a content-fingerprint defect that hurts perceived quality and Google's helpful-content scoring."
        }
      };
    case "duplicate-top-picks-headings":
      return {
        checks: [
          {
            kind: "regex-must-not-match",
            id: "no-duplicate-top-picks-h2",
            pattern:
              "<h2[^>]*>(?:Our )?Top Picks</h2>[\\s\\S]{0,8000}?<h2[^>]*>(?:Our )?Top Picks</h2>",
            flags: "i"
          }
        ],
        rationale: {
          "no-duplicate-top-picks-h2":
            "Only one H2 section heading matching `^(Our )?Top Picks$` is allowed per article. Two distinct H2s ('Top Picks' AND 'Our Top Picks') confuse readers and split the section anchor — duplicate-section bug from the page-assembly path."
        }
      };
    case "unsourced-ymyl-claim":
      return {
        checks: [
          {
            kind: "regex-must-not-match",
            id: "no-benefit-eligibility-trigger",
            pattern:
              "\\b(?:TRICARE|Medicaid|VDC|VR&E|[Vv]eteran[-\\s][Dd]irected [Cc]are|durable medical equipment|FSA[-\\s]eligible|HSA[-\\s]eligible|reimbursable|pre-?authoriz(?:e|ed|ation|ing))\\b",
            flags: "i"
          },
          {
            kind: "regex-must-not-match",
            id: "no-fabricated-clinical-research",
            pattern:
              "\\bclinically (?:proven|tested|validated)\\b|\\bveterinary[-\\s]?grade\\b",
            flags: "i"
          },
          {
            kind: "seo-score-delta-gte",
            id: "seo-not-regressed",
            threshold: -5
          }
        ],
        rationale: {
          "no-benefit-eligibility-trigger":
            "writer.ts Step 14.6 fires this defect when the body text asserts benefit-eligibility claims (TRICARE, VDC, VR&E, DME reimbursement, FSA/HSA eligibility) with no attribution marker. These terms essentially never appear on a legitimate cat-product page; their presence always indicates fabricated copy. A fix (tighter writer prompt / system instruction) must prevent them in regenerated articles.",
          "no-fabricated-clinical-research":
            '"Clinically proven/tested/validated" and "veterinary-grade" invoke medical authority for products that have no such certification and can mislead a reader into a purchase decision based on false credentials. The fix must prevent these phrases appearing without a real attribution marker.',
          "seo-not-regressed":
            "Removing YMYL claims must not drop the SEO score by more than 5 points. If the writer-prompt change over-constrains Kimi, article quality suffers even if the defect is gone."
        }
      };
    case "prepub-fabricated-testing-claim":
      return {
        checks: [
          {
            kind: "regex-must-not-match",
            id: "no-fabricated-testing-claim",
            // Union of the highest-signal trigger categories from
            // detectFabricatedTestingClaims (fabricated-testing-claims.ts).
            // Alternation groups by category:
            //   (1) first-person-test — "we tested/evaluated/reviewed …"
            //   (2) first-person-team — "our team tested/evaluated …"
            //   (3) first-person-gerund — "our testing …"
            //   (4) hands-on-framing — "hands-on [adj*] testing/evaluation …"
            //   (5) self-endorsement-verb — "personally tested/reviewed …"
            //   (6) self-endorsement-stand — "stands behind every product …"
            // Mirrors TESTING_CLAIM_RE's core terms so the eval runner
            // agrees with the Step 14.7 publish gate on whether the defect
            // is resolved.
            pattern: PREPUB_FABRICATED_TESTING_CLAIM_PATTERN,
            flags: "i"
          },
          {
            kind: "seo-score-delta-gte",
            id: "seo-not-regressed",
            threshold: -5
          }
        ],
        rationale: {
          "no-fabricated-testing-claim":
            "catsluvus.com does not physically test products. Phrases like 'we tested', 'our testing', 'hands-on evaluation', and 'personally reviewed' are FTC 16 CFR Part 255 false-endorsement risks detected by writer.ts Step 14.7 (detectFabricatedTestingClaims). The writer-prompt tightening or Polish-Agent instruction must prevent all these forms in regenerated articles.",
          "seo-not-regressed":
            "Removing fabricated testing language must not drop the SEO score by more than 5 points. If the writer-prompt change over-constrains Kimi, article quality suffers even if the defect is gone."
        }
      };
    // Other classes get added here as they get wired in subsequent PRs.
    // Returning a minimal default ensures the function is total.
    default:
      return {
        checks: [],
        rationale: {}
      };
  }
}

/**
 * Build an eval spec from the current findings for `defectClass`,
 * persist it under `eval-set:<runId>`, return the runId.
 *
 * Sample selection rule: take the N most recent findings with
 * distinct `kvKey` values. Distinct prevents one stuck article from
 * monopolising every slot.
 *
 * Returns `null` when there aren't enough distinct samples — caller
 * should not escalate yet.
 */
export async function buildEvalSet(
  agent: SEOArticleAgent,
  defectClass: DefectClass
): Promise<string | null> {
  try {
    const findings = await readFindings(agent, defectClass);
    if (findings.length === 0) return null;
    // Newest first, distinct kvKey, take N.
    const seen = new Set<string>();
    const samples: EvalSpec["samples"] = [];
    const newestFirst = [...findings].sort((a, b) =>
      a.timestamp < b.timestamp ? 1 : -1
    );
    for (const f of newestFirst) {
      if (seen.has(f.kvKey)) continue;
      seen.add(f.kvKey);
      // Find the matching pre-editorial snapshot key. We don't enumerate
      // KV here (too expensive); we record a "best-known" prefix and
      // the Stage 5 runner resolves it via list-by-prefix.
      const snapshotKey = `${f.kvKey}-pre-editorial:`;
      samples.push({
        kvKey: f.kvKey,
        findingTimestamp: f.timestamp,
        snapshotKey
      });
      if (samples.length >= SAMPLES_PER_EVAL) break;
    }
    if (samples.length < SAMPLES_PER_EVAL) return null;
    const template = templateForDefectClass(defectClass);
    const runId = runIdFor(defectClass);
    const spec: EvalSpec = {
      runId,
      defectClass,
      createdAt: new Date().toISOString(),
      samples,
      successCriterion: {
        perSample: template.checks,
        passThreshold: { samplesPassed: SAMPLES_PER_EVAL, of: SAMPLES_PER_EVAL }
      },
      rationale: template.rationale
    };
    await agent.envBindings.ARTICLES_KV.put(
      evalSpecKey(runId),
      JSON.stringify(spec)
    );
    const sampleKvKeys = samples
      .map((s) => s.kvKey)
      .slice(0, 5)
      .join(", ");
    agent.log(
      "info",
      `Defect eval-set built: runId=${runId} samples=${samples.length} checks=${template.checks.length} sampleKvKeys=[${sampleKvKeys}]`,
      "editorialAgent",
      { kanbanStage: "debug" }
    );
    return runId;
  } catch (err: unknown) {
    agent.log(
      "info",
      `Defect eval-builder: buildEvalSet(${defectClass}) failed silently: ${errMsg(err)}`,
      "editorialAgent"
    );
    return null;
  }
}

/** Read a previously-built eval spec. Returns null if missing/malformed. */
export async function readEvalSet(
  agent: SEOArticleAgent,
  runId: string
): Promise<EvalSpec | null> {
  try {
    const raw = await agent.envBindings.ARTICLES_KV.get(evalSpecKey(runId));
    if (!raw) return null;
    return JSON.parse(raw) as EvalSpec;
  } catch {
    return null;
  }
}
