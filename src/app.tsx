import {
  memo,
  useCallback,
  useEffect,
  useRef,
  useState,
  type MouseEvent,
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
import {
  createClaudeOAuthPendingSession,
  exchangeClaudeOAuthCode
} from "./pipeline/claude-oauth-flow";
import type {
  ActivityLogEntry,
  SEOArticleAgent,
  SEOAgentState
} from "./server";
import MermaidChart from "./MermaidChart";

/**
 * Versioned sessionStorage key for the in-flight Claude OAuth PKCE session
 * (code_verifier + state) between "Authorize" and pasting the callback code
 * back. Matches prod's key/version exactly — bump the suffix if the stored
 * shape ever changes so stale sessions from an old build don't get read.
 * Deliberately sessionStorage, not localStorage: the code_verifier is only
 * useful for the single in-flight authorize attempt on this tab and should
 * not linger across browser restarts.
 */
const CLAUDE_OAUTH_SS_KEY = "claude_oauth_pkce_v1";

test_marker_will_be_replaced