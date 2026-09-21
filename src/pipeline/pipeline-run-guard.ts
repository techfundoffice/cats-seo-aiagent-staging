/**
 * Pure state transitions for an article run that is aborted or interrupted.
 *
 * Cloudflare can kill the isolate mid-Claude-write (CPU, wall clock, deploy
 * eviction) without running a catch block. The Durable Object then comes back
 * with `status: "idle"` (or `"generating"`) while `currentStep` is still
 * "7/24: AI Writing", and the red Claude banner never appears. These helpers
 * are the single place that turns that stuck snapshot into a paused run with
 * the banner set and the step cleared. `SEOArticleAgent` applies the result.
 */

export const PIPELINE_ABORT_HOW_TO_FIX =
  "Worker timed out during Claude writing — retry generate-one; if it keeps happening, shorten the article or raise limits.";

/** SQL key in `pipeline_secrets` for the in-flight article run. */
export const PIPELINE_RUN_SECRET_KEY = "article_pipeline_run";

export type PipelineAbortReason =
  | "timeout"
  | "cancel"
  | "isolate-recycle"
  | "unhandled";

export type PipelineRunSnapshot = {
  status: "idle" | "scouting" | "generating" | "paused";
  currentCategory: string | null;
  currentKeyword: string | null;
  currentArticleSlug: string | null;
  currentStep: string | null;
  currentCompetitorUrl: string | null;
  lastSheetStepLabel: string;
  articlesFailed: number;
  claudeChatFailure?: {
    message: string;
    howToFix: string;
    at: string;
  } | null;
};

export type PipelineAbortNotice = {
  message: string;
  howToFix: string;
};

export type PipelineRunRecord = {
  keyword: string;
  category: string;
  slug: string;
  startedAtMs: number;
};

const DEFAULT_TIMEOUT_MESSAGE = "Worker timed out during Claude writing.";
const DEFAULT_CANCEL_MESSAGE =
  "Article generation was cancelled before it finished.";
const DEFAULT_RECYCLE_MESSAGE =
  "Worker restarted during Claude writing and the in-flight article was lost.";
const DEFAULT_UNHANDLED_MESSAGE =
  "Article generation stopped because of an unexpected error.";

function clip(text: string): string {
  return text.replace(/\s+/g, " ").trim().slice(0, 500);
}

/**
 * Banner copy for a pipeline abort. The how-to-fix line is the operator
 * action for a Worker kill during Claude writing.
 */
export function describePipelineAbort(
  reason: PipelineAbortReason,
  detail?: string
): PipelineAbortNotice {
  const raw = clip(detail ?? "");
  switch (reason) {
    case "timeout":
      return {
        message: raw || DEFAULT_TIMEOUT_MESSAGE,
        howToFix: PIPELINE_ABORT_HOW_TO_FIX
      };
    case "cancel":
      return {
        message: raw || DEFAULT_CANCEL_MESSAGE,
        howToFix: PIPELINE_ABORT_HOW_TO_FIX
      };
    case "isolate-recycle":
      return {
        message: raw || DEFAULT_RECYCLE_MESSAGE,
        howToFix: PIPELINE_ABORT_HOW_TO_FIX
      };
    case "unhandled":
      return {
        message: raw || DEFAULT_UNHANDLED_MESSAGE,
        howToFix: PIPELINE_ABORT_HOW_TO_FIX
      };
    default: {
      const exhaustive: never = reason;
      return exhaustive;
    }
  }
}

/** Map a thrown message onto an abort reason. Matching is case-insensitive. */
export function classifyPipelineAbortReason(
  message: string
): PipelineAbortReason {
  const lower = message.toLowerCase();
  if (
    lower.includes("durable object reset") ||
    lower.includes("code was updated") ||
    lower.includes("exceeded cpu") ||
    lower.includes("cpu time limit") ||
    lower.includes("exceeded memory") ||
    lower.includes("network connection lost") ||
    lower.includes("isolate")
  ) {
    return "isolate-recycle";
  }
  if (/timed out|timeout|wall-clock|deadline exceeded|etimedout/.test(lower)) {
    return "timeout";
  }
  if (/abort|cancelled|canceled/.test(lower)) {
    return "cancel";
  }
  return "unhandled";
}

/**
 * True when persisted state still names a pipeline step. "Complete" is the
 * writer's terminal label and is cleared without counting a failure.
 */
export function pipelineRunLooksInterrupted(
  state: PipelineRunSnapshot
): boolean {
  const step = (state.currentStep ?? "").trim();
  if (step === "") return false;
  return !/^complete$/i.test(step);
}

export function applyPipelineAbort<T extends PipelineRunSnapshot>(
  state: T,
  reason: PipelineAbortReason,
  detail: string | undefined,
  nowIso: string,
  options?: { incrementFailed?: boolean }
): T {
  const notice = describePipelineAbort(reason, detail);
  const increment = options?.incrementFailed !== false;
  return {
    ...state,
    status: "paused",
    currentCategory: null,
    currentKeyword: null,
    currentArticleSlug: null,
    currentStep: null,
    currentCompetitorUrl: null,
    lastSheetStepLabel: "",
    articlesFailed: state.articlesFailed + (increment ? 1 : 0),
    claudeChatFailure: {
      message: notice.message,
      howToFix: notice.howToFix,
      at: nowIso
    }
  };
}

/**
 * End of a run that returned normally. Clears the in-flight step. A Claude
 * banner already on the state keeps the loop paused; otherwise the worker
 * is idle. Does not change failure or success counters.
 */
export function settleSuccessfulPipeline<T extends PipelineRunSnapshot>(
  state: T
): T {
  const banner = state.claudeChatFailure?.message;
  return {
    ...state,
    status: banner ? "paused" : "idle",
    currentCategory: null,
    currentKeyword: null,
    currentArticleSlug: null,
    currentStep: null,
    currentCompetitorUrl: null
  };
}

function clearStuckRunFields<T extends PipelineRunSnapshot>(
  state: T,
  status: T["status"]
): T {
  return {
    ...state,
    status,
    currentCategory: null,
    currentKeyword: null,
    currentArticleSlug: null,
    currentStep: null,
    currentCompetitorUrl: null,
    lastSheetStepLabel: ""
  };
}

/**
 * Startup heal. A new isolate means any in-flight article await is gone.
 * A non-null step (or a leftover run record) becomes a paused failure with
 * the red banner. A clean idle worker, and a generating loop between
 * articles (no step, no record), is unchanged.
 */
export function healInterruptedPipeline<T extends PipelineRunSnapshot>(
  state: T,
  nowIso: string,
  hasRunRecord: boolean
): { state: T; healed: boolean; stuckStep: string | null } {
  const step = (state.currentStep ?? "").trim();
  if (/^complete$/i.test(step)) {
    const status = state.claudeChatFailure
      ? "paused"
      : state.status === "generating"
        ? "idle"
        : state.status;
    return {
      state: clearStuckRunFields(state, status),
      healed: true,
      stuckStep: step
    };
  }

  const stuckStep = pipelineRunLooksInterrupted(state);
  if (!stuckStep && !hasRunRecord) {
    return { state, healed: false, stuckStep: null };
  }

  const alreadyBanner =
    state.status === "paused" && Boolean(state.claudeChatFailure?.message);
  if (!stuckStep && hasRunRecord && alreadyBanner) {
    return { state, healed: false, stuckStep: null };
  }
  if (stuckStep && alreadyBanner) {
    return {
      state: clearStuckRunFields(state, "paused"),
      healed: true,
      stuckStep: step
    };
  }

  return {
    state: applyPipelineAbort(state, "isolate-recycle", undefined, nowIso),
    healed: true,
    stuckStep: step || null
  };
}

export function parsePipelineRunRecord(
  raw: string | null | undefined
): PipelineRunRecord | null {
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as Partial<PipelineRunRecord>;
    if (
      typeof parsed.keyword !== "string" ||
      typeof parsed.category !== "string" ||
      typeof parsed.slug !== "string" ||
      typeof parsed.startedAtMs !== "number" ||
      !Number.isFinite(parsed.startedAtMs)
    ) {
      return null;
    }
    return {
      keyword: parsed.keyword,
      category: parsed.category,
      slug: parsed.slug,
      startedAtMs: parsed.startedAtMs
    };
  } catch {
    return null;
  }
}

export type PipelineRace<T> =
  | { status: "ok"; value: T }
  | { status: "timeout" }
  | { status: "cancelled" }
  | { status: "threw"; error: unknown };

export type DeadlineTimers = {
  setTimeout: (fn: () => void, ms: number) => unknown;
  clearTimeout: (handle: unknown) => void;
};

const defaultTimers: DeadlineTimers = {
  setTimeout: (fn, ms) => setTimeout(fn, ms),
  clearTimeout: (handle) => {
    clearTimeout(handle as ReturnType<typeof setTimeout>);
  }
};

/**
 * Bound a pipeline promise so the HTTP handler can return. A timeout or
 * client abort resolves this race; it does not by itself cancel `work`.
 * The caller aborts the Claude signal and ignores a late result.
 */
export function racePipelineWork<T>(
  work: Promise<T>,
  timeoutMs: number,
  clientSignal?: AbortSignal | null,
  timers: DeadlineTimers = defaultTimers
): Promise<PipelineRace<T>> {
  if (clientSignal?.aborted) {
    return Promise.resolve({ status: "cancelled" });
  }
  return new Promise((resolve) => {
    let settled = false;
    let handle: unknown;
    const finish = (outcome: PipelineRace<T>) => {
      if (settled) return;
      settled = true;
      if (handle !== undefined) timers.clearTimeout(handle);
      clientSignal?.removeEventListener("abort", onCancel);
      resolve(outcome);
    };
    const onCancel = () => finish({ status: "cancelled" });
    handle = timers.setTimeout(() => finish({ status: "timeout" }), timeoutMs);
    clientSignal?.addEventListener("abort", onCancel);
    work.then(
      (value) => finish({ status: "ok", value }),
      (error: unknown) => finish({ status: "threw", error })
    );
  });
}

/** Combine the per-call Claude timeout with the pipeline abort signal. */
export function linkAbortSignals(
  primary: AbortSignal,
  extra: AbortSignal | null | undefined
): AbortSignal {
  if (!extra) return primary;
  if (extra.aborted) return extra;
  if (primary.aborted) return primary;
  const controller = new AbortController();
  const onAbort = () => {
    if (!controller.signal.aborted) controller.abort();
  };
  primary.addEventListener("abort", onAbort, { once: true });
  extra.addEventListener("abort", onAbort, { once: true });
  return controller.signal;
}

let pipelineAbortSignal: AbortSignal | null = null;

/** Installed for the duration of one article run so Claude fetches can be cancelled. */
export function setPipelineAbortSignal(signal: AbortSignal | null): void {
  pipelineAbortSignal = signal;
}

export function getPipelineAbortSignal(): AbortSignal | null {
  return pipelineAbortSignal;
}

export function generateOneAbortHttpBody(input: {
  keyword?: string;
  category?: string;
  error: string;
}): {
  ok: false;
  keyword?: string;
  category?: string;
  error: string;
} {
  return {
    ok: false,
    keyword: input.keyword,
    category: input.category,
    error: input.error
  };
}
