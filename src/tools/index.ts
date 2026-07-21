/**
 * Agent tool registry. Each tool here is a self-contained capability
 * exposed via AI SDK v6 `tool()` so it can be:
 *   - called directly as a function from deterministic pipeline code,
 *   - registered on `SEOArticleAgent` for `generateText({tools})` loops,
 *   - surfaced through the Agent's MCP server to external clients.
 *
 * When adding a new tool, export its factory here and include it in
 * `createDesignAuditTools()` (or create a new bundle).
 */
import type { ToolSet } from "ai";
import type { SEOArticleAgent } from "../server";
import {
  createScreenshotPageTool,
  SCREENSHOT_TOOL_NAME
} from "./browser-rendering";
import {
  createAuditScreenshotTool,
  createAuditPageDesignTool,
  AUDIT_SCREENSHOT_TOOL_NAME,
  AUDIT_URL_TOOL_NAME
} from "./vision-audit";

export * from "./browser-rendering";
export * from "./vision-audit";

/**
 * Bundle used by the Step 11.5 design-audit flow. Registering this on an
 * agent lets any tool-using model (QC, Polish, external MCP client) run
 * the full flow — `auditPageDesign(url)` — or the primitives independently.
 */
export function createDesignAuditTools(agent: SEOArticleAgent): ToolSet {
  return {
    [SCREENSHOT_TOOL_NAME]: createScreenshotPageTool(agent),
    [AUDIT_SCREENSHOT_TOOL_NAME]: createAuditScreenshotTool(agent),
    [AUDIT_URL_TOOL_NAME]: createAuditPageDesignTool(agent)
  } as ToolSet;
}
