import { describe, expect, it } from "vitest";
import {
  CLAUDE_AUTHORIZED_STATUS,
  CLAUDE_ONLY_MODEL_COPY,
  claudeCodeExpiryBadgeLabel,
  type ClaudeCodeExpiryPresentation
} from "../claude-code-status-display";

const FALLBACK_COPY = /OpenRouter|Workers AI|primary before|Kimi|Qwen/i;

function activeStatus(
  overrides: Partial<ClaudeCodeExpiryPresentation>
): ClaudeCodeExpiryPresentation {
  return {
    configured: true,
    active: true,
    uiStatus: "active",
    daysRemaining: 200,
    hoursRemaining: 4800,
    hasRefreshToken: false,
    ...overrides
  };
}

describe("Claude-only dashboard status copy", () => {
  it("authorized copy says Claude is the only model and names the red banner", () => {
    expect(CLAUDE_AUTHORIZED_STATUS).toBe(
      `Authorized — ${CLAUDE_ONLY_MODEL_COPY}`
    );
    expect(CLAUDE_ONLY_MODEL_COPY).toMatch(/only chat and vision model/);
    expect(CLAUDE_ONLY_MODEL_COPY).toMatch(/job stops/);
    expect(CLAUDE_ONLY_MODEL_COPY).toMatch(/red banner/);
    expect(CLAUDE_AUTHORIZED_STATUS).not.toMatch(FALLBACK_COPY);
    expect(CLAUDE_ONLY_MODEL_COPY).not.toMatch(FALLBACK_COPY);
  });

  it("active badge does not call Claude the primary model", () => {
    const longLived = claudeCodeExpiryBadgeLabel(activeStatus({}));
    const within30Days = claudeCodeExpiryBadgeLabel(
      activeStatus({
        daysRemaining: 20,
        hoursRemaining: 480,
        hasRefreshToken: true
      })
    );
    expect(longLived).toBe("Active — only chat model");
    expect(within30Days).toBe("Active — only chat model · 20d left");
    expect(longLived).not.toMatch(/primary/i);
    expect(within30Days).not.toMatch(/primary/i);
    expect(longLived).not.toMatch(FALLBACK_COPY);
    expect(within30Days).not.toMatch(FALLBACK_COPY);
  });
});
