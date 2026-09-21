import { describe, expect, it } from "vitest";
import {
  applyPipelineAbort,
  classifyPipelineAbortReason,
  describePipelineAbort,
  generateOneAbortHttpBody,
  healInterruptedPipeline,
  linkAbortSignals,
  parsePipelineRunRecord,
  PIPELINE_ABORT_HOW_TO_FIX,
  racePipelineWork,
  settleSuccessfulPipeline,
  type PipelineRunSnapshot
} from "../pipeline-run-guard";

const NOW = "2026-09-21T22:00:00.000Z";

function snapshot(
  overrides: Partial<PipelineRunSnapshot> & { articlesGenerated?: number } = {}
): PipelineRunSnapshot & { articlesGenerated: number } {
  return {
    status: "idle",
    currentCategory: null,
    currentKeyword: null,
    currentArticleSlug: null,
    currentStep: null,
    currentCompetitorUrl: null,
    lastSheetStepLabel: "",
    articlesFailed: 0,
    articlesGenerated: 3,
    claudeChatFailure: null,
    ...overrides
  };
}

describe("describePipelineAbort", () => {
  it("tells the operator to retry generate-one after a worker timeout", () => {
    const notice = describePipelineAbort(
      "timeout",
      "Worker timed out during Claude writing."
    );
    expect(notice.message).toBe("Worker timed out during Claude writing.");
    expect(notice.howToFix).toBe(PIPELINE_ABORT_HOW_TO_FIX);
    expect(notice.howToFix).toMatch(/retry generate-one/);
    expect(notice.howToFix).toMatch(/shorten the article or raise limits/);
  });
});

describe("applyPipelineAbort", () => {
  it("clears a stuck AI Writing step and sets the red banner", () => {
    const next = applyPipelineAbort(
      snapshot({
        status: "generating",
        currentKeyword: "furhaven microvelvet cat bed e2e claude only review",
        currentCategory: "cat-beds",
        currentArticleSlug: "furhaven-microvelvet-cat-bed",
        currentStep: "7/24: AI Writing",
        lastSheetStepLabel: "7",
        articlesFailed: 2
      }),
      "timeout",
      "Worker timed out during Claude writing.",
      NOW
    );
    expect(next.status).toBe("paused");
    expect(next.currentStep).toBeNull();
    expect(next.currentKeyword).toBeNull();
    expect(next.currentArticleSlug).toBeNull();
    expect(next.currentCategory).toBeNull();
    expect(next.lastSheetStepLabel).toBe("");
    expect(next.articlesFailed).toBe(3);
    expect(next.articlesGenerated).toBe(3);
    expect(next.claudeChatFailure).toEqual({
      message: "Worker timed out during Claude writing.",
      howToFix: PIPELINE_ABORT_HOW_TO_FIX,
      at: NOW
    });
  });

  it("does not increment failed twice when the caller already counted the attempt", () => {
    const next = applyPipelineAbort(
      snapshot({ status: "generating", articlesFailed: 4 }),
      "timeout",
      undefined,
      NOW,
      { incrementFailed: false }
    );
    expect(next.articlesFailed).toBe(4);
    expect(next.claudeChatFailure?.howToFix).toBe(PIPELINE_ABORT_HOW_TO_FIX);
    expect(next.status).toBe("paused");
  });
});

describe("healInterruptedPipeline", () => {
  it("turns idle-plus-AI-Writing into a paused failure with the banner", () => {
    const healed = healInterruptedPipeline(
      snapshot({
        status: "idle",
        currentStep: "7/24: AI Writing",
        currentKeyword: "furhaven microvelvet cat bed e2e claude only review",
        articlesFailed: 1
      }),
      NOW,
      false
    );
    expect(healed.healed).toBe(true);
    expect(healed.stuckStep).toBe("7/24: AI Writing");
    expect(healed.state.status).toBe("paused");
    expect(healed.state.currentStep).toBeNull();
    expect(healed.state.currentKeyword).toBeNull();
    expect(healed.state.articlesFailed).toBe(2);
    expect(healed.state.articlesGenerated).toBe(3);
    expect(healed.state.claudeChatFailure?.message).toMatch(/restarted/i);
    expect(healed.state.claudeChatFailure?.howToFix).toBe(
      PIPELINE_ABORT_HOW_TO_FIX
    );
  });

  it("leaves a finished idle worker unchanged", () => {
    const state = snapshot();
    const healed = healInterruptedPipeline(state, NOW, false);
    expect(healed.healed).toBe(false);
    expect(healed.state).toBe(state);
    expect(healed.state.articlesFailed).toBe(0);
    expect(healed.state.articlesGenerated).toBe(3);
    expect(healed.state.claudeChatFailure).toBeNull();
    expect(healed.state.currentStep).toBeNull();
  });

  it("leaves a generating loop between articles unchanged", () => {
    const state = snapshot({ status: "generating", currentStep: null });
    const healed = healInterruptedPipeline(state, NOW, false);
    expect(healed.healed).toBe(false);
    expect(healed.state).toBe(state);
  });

  it("does not count another failure when the banner is already showing", () => {
    const state = snapshot({
      status: "paused",
      currentStep: "7/24: AI Writing",
      articlesFailed: 5,
      claudeChatFailure: {
        message: "Worker timed out during Claude writing.",
        howToFix: PIPELINE_ABORT_HOW_TO_FIX,
        at: NOW
      }
    });
    const healed = healInterruptedPipeline(state, NOW, true);
    expect(healed.healed).toBe(true);
    expect(healed.state.currentStep).toBeNull();
    expect(healed.state.articlesFailed).toBe(5);
    expect(healed.state.claudeChatFailure?.message).toBe(
      "Worker timed out during Claude writing."
    );
  });

  it("heals a run record left behind with no step", () => {
    const healed = healInterruptedPipeline(
      snapshot({ status: "generating", currentStep: null, articlesFailed: 0 }),
      NOW,
      true
    );
    expect(healed.healed).toBe(true);
    expect(healed.state.status).toBe("paused");
    expect(healed.state.articlesFailed).toBe(1);
    expect(healed.state.claudeChatFailure?.howToFix).toBe(
      PIPELINE_ABORT_HOW_TO_FIX
    );
  });
});

describe("settleSuccessfulPipeline", () => {
  it("clears the step and stays idle without a banner or extra failure", () => {
    const next = settleSuccessfulPipeline(
      snapshot({
        status: "generating",
        currentStep: "24/24: RSS",
        currentKeyword: "cat bed",
        articlesFailed: 2,
        articlesGenerated: 9
      })
    );
    expect(next.status).toBe("idle");
    expect(next.currentStep).toBeNull();
    expect(next.currentKeyword).toBeNull();
    expect(next.articlesFailed).toBe(2);
    expect(next.articlesGenerated).toBe(9);
    expect(next.claudeChatFailure).toBeNull();
  });

  it("stays paused when a Claude banner is already set", () => {
    const next = settleSuccessfulPipeline(
      snapshot({
        status: "generating",
        currentStep: "7/24: AI Writing",
        claudeChatFailure: {
          message: "overloaded",
          howToFix: "retry",
          at: NOW
        }
      })
    );
    expect(next.status).toBe("paused");
    expect(next.currentStep).toBeNull();
    expect(next.claudeChatFailure?.message).toBe("overloaded");
  });
});

describe("racePipelineWork", () => {
  const timers = () => {
    let pending: (() => void) | undefined;
    return {
      timers: {
        setTimeout: (fn: () => void) => {
          pending = fn;
          return 1;
        },
        clearTimeout: () => {
          pending = undefined;
        }
      },
      fire: () => {
        pending?.();
      }
    };
  };

  it("returns the value when the run finishes", async () => {
    const clock = timers();
    const raced = await racePipelineWork(
      Promise.resolve("article"),
      15 * 60_000,
      undefined,
      clock.timers
    );
    expect(raced).toEqual({ status: "ok", value: "article" });
  });

  it("resolves timeout when the run never settles", async () => {
    const clock = timers();
    const raced = racePipelineWork(
      new Promise(() => undefined),
      1000,
      undefined,
      clock.timers
    );
    clock.fire();
    await expect(raced).resolves.toEqual({ status: "timeout" });
  });

  it("resolves cancelled when the client aborts", async () => {
    const clock = timers();
    const controller = new AbortController();
    const raced = racePipelineWork(
      new Promise(() => undefined),
      1000,
      controller.signal,
      clock.timers
    );
    controller.abort();
    await expect(raced).resolves.toEqual({ status: "cancelled" });
  });

  it("surfaces a thrown pipeline error instead of hanging", async () => {
    const clock = timers();
    const raced = await racePipelineWork(
      Promise.reject(new Error("Worker exceeded CPU time limit")),
      1000,
      undefined,
      clock.timers
    );
    expect(raced.status).toBe("threw");
    if (raced.status === "threw") {
      expect(raced.error).toBeInstanceOf(Error);
    }
  });
});

describe("classifyPipelineAbortReason", () => {
  it("recognizes isolate kills, timeouts, and cancels", () => {
    expect(classifyPipelineAbortReason("Worker exceeded CPU time limit")).toBe(
      "isolate-recycle"
    );
    expect(classifyPipelineAbortReason("wall-clock budget exceeded")).toBe(
      "timeout"
    );
    expect(classifyPipelineAbortReason("The operation was aborted")).toBe(
      "cancel"
    );
    expect(classifyPipelineAbortReason("json parse failed")).toBe("unhandled");
  });
});

describe("linkAbortSignals", () => {
  it("aborts the linked signal when the pipeline abort fires", () => {
    const primary = new AbortController();
    const extra = new AbortController();
    const linked = linkAbortSignals(primary.signal, extra.signal);
    expect(linked.aborted).toBe(false);
    extra.abort();
    expect(linked.aborted).toBe(true);
  });
});

describe("parsePipelineRunRecord", () => {
  it("rejects malformed rows", () => {
    expect(parsePipelineRunRecord(null)).toBeNull();
    expect(parsePipelineRunRecord("{")).toBeNull();
    expect(
      parsePipelineRunRecord(
        JSON.stringify({
          keyword: "bed",
          category: "cat-beds",
          slug: "bed",
          startedAtMs: 1
        })
      )?.keyword
    ).toBe("bed");
  });
});

describe("generateOneAbortHttpBody", () => {
  it("returns error JSON for a failed run", () => {
    expect(
      generateOneAbortHttpBody({
        keyword: "bed",
        category: "cat-beds",
        error: `Worker timed out during Claude writing. — ${PIPELINE_ABORT_HOW_TO_FIX}`
      })
    ).toEqual({
      ok: false,
      keyword: "bed",
      category: "cat-beds",
      error: `Worker timed out during Claude writing. — ${PIPELINE_ABORT_HOW_TO_FIX}`
    });
  });
});
