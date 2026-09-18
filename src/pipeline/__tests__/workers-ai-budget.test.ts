import { describe, expect, it } from "vitest";
import {
  isWorkersAiEnabled,
  parseFlag,
  WORKERS_AI_SURFACES,
  WorkersAiDisabledError,
  workersAiDisabledReason,
  type WorkersAiSurface
} from "../workers-ai-budget";
import { readFileSync } from "node:fs";
import { join } from "node:path";

/**
 * Read the `vars` block out of the real wrangler.jsonc. Strips `//` line
 * comments (JSONC) before parsing, ignoring any that sit inside a string.
 */
function readWranglerVars(): Record<string, unknown> {
  const raw = readFileSync(join(process.cwd(), "wrangler.jsonc"), "utf8");
  const stripped = raw
    .split("\n")
    .map((line) => {
      let inString = false;
      for (let i = 0; i < line.length; i++) {
        const ch = line[i];
        if (ch === '"' && line[i - 1] !== "\\") inString = !inString;
        if (!inString && ch === "/" && line[i + 1] === "/") {
          return line.slice(0, i);
        }
      }
      return line;
    })
    .join("\n");
  const parsed = JSON.parse(stripped) as { vars?: Record<string, unknown> };
  return parsed.vars ?? {};
}

describe("parseFlag", () => {
  it("passes real booleans through", () => {
    expect(parseFlag(true)).toBe(true);
    expect(parseFlag(false)).toBe(false);
  });

  it("reads the truthy string spellings wrangler vars arrive as", () => {
    for (const v of ["true", "TRUE", " True ", "1", "yes"]) {
      expect(parseFlag(v)).toBe(true);
    }
  });

  it("reads the falsy string spellings", () => {
    for (const v of ["false", "FALSE", " False ", "0", "no"]) {
      expect(parseFlag(v)).toBe(false);
    }
  });

  it("returns undefined for absent, blank, and unrecognized values so the caller falls through", () => {
    for (const v of [undefined, null, "", "   ", "maybe", 1, {}]) {
      expect(parseFlag(v)).toBeUndefined();
    }
  });
});

describe("isWorkersAiEnabled", () => {
  it("defaults every surface to disabled when nothing is configured", () => {
    for (const surface of WORKERS_AI_SURFACES) {
      expect(isWorkersAiEnabled({}, surface)).toBe(false);
    }
  });

  it("treats a missing or malformed env as disabled rather than throwing", () => {
    expect(isWorkersAiEnabled(undefined, "text")).toBe(false);
    expect(isWorkersAiEnabled(null, "image")).toBe(false);
  });

  it("enables all four surfaces from the master switch", () => {
    const env = { WORKERS_AI_ENABLED: "true" };
    for (const surface of WORKERS_AI_SURFACES) {
      expect(isWorkersAiEnabled(env, surface)).toBe(true);
    }
  });

  it("lets a per-surface flag override the master switch in both directions", () => {
    const mostlyOn = {
      WORKERS_AI_ENABLED: "true",
      WORKERS_AI_IMAGE_ENABLED: "false"
    };
    expect(isWorkersAiEnabled(mostlyOn, "image")).toBe(false);
    expect(isWorkersAiEnabled(mostlyOn, "text")).toBe(true);

    const mostlyOff = {
      WORKERS_AI_ENABLED: "false",
      WORKERS_AI_SCOUT_ENABLED: "true"
    };
    expect(isWorkersAiEnabled(mostlyOff, "scout")).toBe(true);
    expect(isWorkersAiEnabled(mostlyOff, "text")).toBe(false);
  });

  it("keeps the surfaces independent of one another", () => {
    const env = { WORKERS_AI_TEXT_ENABLED: "true" };
    expect(isWorkersAiEnabled(env, "text")).toBe(true);
    expect(isWorkersAiEnabled(env, "image")).toBe(false);
    expect(isWorkersAiEnabled(env, "vision")).toBe(false);
    expect(isWorkersAiEnabled(env, "scout")).toBe(false);
  });

  it("ignores an unrecognized flag value and stays disabled", () => {
    expect(
      isWorkersAiEnabled({ WORKERS_AI_TEXT_ENABLED: "sure" }, "text")
    ).toBe(false);
  });
});

describe("the shipped wrangler.jsonc configuration", () => {
  // Regression: pinning all four per-surface flags to "false" in
  // wrangler.jsonc made WORKERS_AI_ENABLED=true a no-op, because a
  // per-surface flag wins over the master one. The bug lived in the config
  // file rather than in the resolver, so this reads the real file instead of
  // restating it — a future edit that re-pins the surfaces fails here.
  const shipped = readWranglerVars();

  it("disables every surface as shipped", () => {
    for (const surface of WORKERS_AI_SURFACES) {
      expect(isWorkersAiEnabled(shipped, surface)).toBe(false);
    }
  });

  it("enables every surface when only the master flag is flipped to true", () => {
    const flipped = { ...shipped, WORKERS_AI_ENABLED: "true" };
    for (const surface of WORKERS_AI_SURFACES) {
      expect(isWorkersAiEnabled(flipped, surface)).toBe(true);
    }
  });
});

describe("workersAiDisabledReason", () => {
  it("names both the surface flag and the master flag so the fix is copy-pasteable", () => {
    const reason = workersAiDisabledReason("image");
    expect(reason).toContain("WORKERS_AI_IMAGE_ENABLED=true");
    expect(reason).toContain("WORKERS_AI_ENABLED=true");
  });

  it("names a distinct flag for every surface", () => {
    const flags = WORKERS_AI_SURFACES.map(
      (s: WorkersAiSurface) => workersAiDisabledReason(s).split(" ")[0]
    );
    expect(new Set(WORKERS_AI_SURFACES.map(workersAiDisabledReason)).size).toBe(
      WORKERS_AI_SURFACES.length
    );
    expect(flags).toHaveLength(WORKERS_AI_SURFACES.length);
  });
});

describe("WorkersAiDisabledError", () => {
  it("carries the surface and the actionable message", () => {
    const err = new WorkersAiDisabledError("text");
    expect(err).toBeInstanceOf(Error);
    expect(err.name).toBe("WorkersAiDisabledError");
    expect(err.surface).toBe("text");
    expect(err.message).toBe(workersAiDisabledReason("text"));
  });
});
