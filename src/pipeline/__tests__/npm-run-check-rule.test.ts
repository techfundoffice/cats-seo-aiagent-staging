import { describe, expect, it } from "vitest";
import { NPM_RUN_CHECK_RULE } from "../escalate-to-claude";

describe("NPM_RUN_CHECK_RULE", () => {
  it("describes the full npm run check quality gate", () => {
    expect(NPM_RUN_CHECK_RULE).toBe(
      "- Run `npm run check` before committing (format, lint, typecheck, and tests)."
    );
  });
});
