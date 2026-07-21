import { errMsg } from "../pipeline/http-utils";
import { getSkillFull, searchSkills } from "./search";

/**
 * Streamable-HTTP MCP server over the cats-seo-skills D1 catalog.
 *
 * This is a hand-rolled implementation of the Model Context Protocol
 * (2025-06-18 streamable-HTTP transport). MCP at this surface area is
 * just JSON-RPC 2.0 over HTTP POST: the client sends `initialize` then
 * `tools/list` then `tools/call`, and the server answers each one
 * synchronously. We don't need session persistence, SSE streaming, or
 * server→client notifications, so a stateless POST handler is enough.
 *
 * Wire any MCP-aware client at `https://<worker>/mcp`. Two tools are
 * exposed:
 *   - search_skills(query, k?, owner?, include_body?)
 *   - get_skill(id)
 *
 * No auth on the search/get path: the catalog is derived from public
 * SKILL.md files on agentskill.sh; serving lookups is fine.
 */

const PROTOCOL_VERSION = "2025-06-18";
const SERVER_INFO = {
  name: "cats-seo-skills",
  version: "1.0.0"
};
const CORS_HEADERS = {
  "access-control-allow-origin": "*",
  "access-control-allow-methods": "GET, POST, OPTIONS",
  "access-control-allow-headers":
    "content-type, authorization, accept, mcp-session-id, mcp-protocol-version"
};

type JsonRpcId = string | number | null;
interface JsonRpcRequest {
  jsonrpc: "2.0";
  id?: JsonRpcId;
  method: string;
  params?: Record<string, unknown>;
}

const TOOLS = [
  {
    name: "search_skills",
    description:
      "Search the agentskill.sh skill catalog for skills relevant to " +
      "a natural-language query. Returns a paged list of matching skills " +
      "with their full SKILL.md body, scored by BM25, plus the total " +
      "match count so the caller can paginate through everything. Use " +
      "this whenever you need to discover or load a skill for a task.",
    inputSchema: {
      type: "object",
      properties: {
        query: {
          type: "string",
          description:
            "Natural-language description of what the skill " +
            "should do (e.g. 'cloudflare worker deployment', " +
            "'react hook for forms', 'kubernetes debugging')."
        },
        k: {
          type: "integer",
          minimum: 1,
          maximum: 100,
          default: 25,
          description: "Page size — number of hits to return per call."
        },
        offset: {
          type: "integer",
          minimum: 0,
          default: 0,
          description:
            "How many top hits to skip before returning. Use with `k` " +
            "to paginate (page N → offset = (N-1) * k)."
        },
        owner: {
          type: "string",
          description: "Optional GitHub-owner filter (e.g. 'anthropic')."
        },
        include_body: {
          type: "boolean",
          default: true,
          description: "If true (default) include the full SKILL.md text."
        }
      },
      required: ["query"]
    }
  },
  {
    name: "get_skill",
    description:
      'Fetch a single skill by its full id ("<owner>/<slug>") and ' +
      "return the metadata + the full SKILL.md body. Use this after " +
      "search_skills when you only need to revisit one specific skill.",
    inputSchema: {
      type: "object",
      properties: {
        id: {
          type: "string",
          description:
            "Skill id formatted as <owner>/<slug>, e.g. " +
            "'anthropic/seo-content-optimizer'."
        }
      },
      required: ["id"]
    }
  }
];

/**
 * Handle the worker's MCP endpoint over streamable-HTTP JSON-RPC.
 *
 * Supports:
 * - `OPTIONS` CORS preflight
 * - `GET` lightweight discovery/heartbeat payload
 * - `POST` JSON-RPC single or batch requests
 */
export async function handleMcpRequest(
  request: Request,
  env: Env
): Promise<Response> {
  if (request.method === "OPTIONS") {
    return new Response(null, {
      status: 204,
      headers: CORS_HEADERS
    });
  }
  if (request.method === "GET") {
    // Optional discovery / heartbeat — some MCP clients GET first.
    return jsonResponse({
      ok: true,
      server: SERVER_INFO,
      protocol: PROTOCOL_VERSION,
      tools: TOOLS.map((t) => t.name),
      tip: "POST JSON-RPC 2.0 to this endpoint."
    });
  }
  if (request.method !== "POST") {
    return new Response("method not allowed", {
      status: 405,
      headers: {
        "content-type": "text/plain; charset=utf-8",
        ...CORS_HEADERS
      }
    });
  }

  let body: JsonRpcRequest | JsonRpcRequest[];
  try {
    body = (await request.json()) as JsonRpcRequest | JsonRpcRequest[];
  } catch (err: unknown) {
    console.warn(
      `[skills/mcp] parse error while decoding JSON-RPC body: ${errMsg(err)}`
    );
    return rpcError(null, -32700, "parse error");
  }

  if (Array.isArray(body)) {
    if (body.length === 0) {
      return rpcError(null, -32600, "invalid request: empty batch");
    }
    const out = (
      await Promise.all(body.map((req) => dispatch(req, env)))
    ).filter(
      (response): response is Record<string, unknown> => response !== null
    );
    if (out.length === 0) {
      return emptyResponse();
    }
    return jsonResponse(out);
  }
  const result = await dispatch(body, env);
  if (result === null) {
    return emptyResponse();
  }
  return jsonResponse(result);
}

async function dispatch(
  req: unknown,
  env: Env
): Promise<Record<string, unknown> | null> {
  if (!isJsonRpcRequestObject(req)) {
    return rpcErrorObj(null, -32600, "invalid request");
  }

  const expectsResponse = requestExpectsResponse(req);
  const id = normalizeJsonRpcId(req.id);
  if (req.jsonrpc !== "2.0") {
    return expectsResponse
      ? rpcErrorObj(id, -32600, "invalid request: jsonrpc must be '2.0'")
      : null;
  }
  if (typeof req.method !== "string") {
    return expectsResponse
      ? rpcErrorObj(id, -32600, "invalid request: method must be a string")
      : null;
  }
  try {
    let response: Record<string, unknown>;
    switch (req.method) {
      case "initialize":
        response = rpcResultObj(id, {
          protocolVersion: PROTOCOL_VERSION,
          capabilities: { tools: { listChanged: false } },
          serverInfo: SERVER_INFO
        });
        break;
      case "notifications/initialized":
        if (!expectsResponse) {
          return null;
        }
        response = rpcResultObj(id, {});
        break;
      case "tools/list":
        response = rpcResultObj(id, { tools: TOOLS });
        break;
      case "tools/call":
        response = await handleToolCall(id, req.params, env);
        break;
      case "ping":
        response = rpcResultObj(id, {});
        break;
      default:
        response = rpcErrorObj(id, -32601, `method not found: ${req.method}`);
    }
    return expectsResponse ? response : null;
  } catch (err) {
    const msg = errMsg(err);
    const requestDescriptor = expectsResponse
      ? `request id=${String(id)}`
      : "notification";
    console.warn(
      `[skills/mcp] dispatch error for ${requestDescriptor} method '${req.method}': ${msg}`
    );
    return expectsResponse
      ? rpcErrorObj(id, -32603, `internal error: ${msg.slice(0, 200)}`)
      : null;
  }
}

function requestExpectsResponse(req: Record<string, unknown>): boolean {
  return Object.hasOwn(req, "id");
}

function isJsonRpcRequestObject(
  value: unknown
): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function normalizeJsonRpcId(value: unknown): JsonRpcId {
  return typeof value === "string" ||
    typeof value === "number" ||
    value === null
    ? value
    : null;
}

async function handleToolCall(
  id: JsonRpcId,
  params: unknown,
  env: Env
): Promise<Record<string, unknown>> {
  if (!isJsonRpcRequestObject(params)) {
    return rpcErrorObj(id, -32602, "invalid params: expected object");
  }
  if (typeof params.name !== "string" || !params.name.trim()) {
    return rpcErrorObj(id, -32602, "argument 'name' is required");
  }
  if (
    params.arguments !== undefined &&
    !isJsonRpcRequestObject(params.arguments)
  ) {
    return rpcErrorObj(id, -32602, "argument 'arguments' must be an object");
  }

  const name = params.name.trim();
  const args = isJsonRpcRequestObject(params.arguments) ? params.arguments : {};
  if (name === "search_skills") {
    const query = String(args.query ?? "").trim();
    if (!query) {
      return rpcErrorObj(id, -32602, "argument 'query' is required");
    }
    const k = parseOptionalIntegerArgument(args.k, "k", 1, 100);
    if (typeof k === "string") {
      return rpcErrorObj(id, -32602, k);
    }
    const offset = parseOptionalIntegerArgument(args.offset, "offset", 0);
    if (typeof offset === "string") {
      return rpcErrorObj(id, -32602, offset);
    }
    const result = await searchSkills(env, query, {
      k: k ?? 25,
      offset: offset ?? 0,
      owner: typeof args.owner === "string" ? args.owner : undefined,
      includeBody: args.include_body !== false
    });
    const payload = {
      hits: result.hits,
      total_matches: result.totalMatches,
      k: result.k,
      offset: result.offset,
      has_more: result.hasMore
    };
    return rpcResultObj(id, {
      content: [{ type: "text", text: JSON.stringify(payload, null, 2) }],
      structuredContent: payload
    });
  }
  if (name === "get_skill") {
    const skillId = String(args.id ?? "").trim();
    if (!skillId) {
      return rpcErrorObj(id, -32602, "argument 'id' is required");
    }
    const skill = await getSkillFull(env, skillId);
    if (!skill) {
      return rpcResultObj(id, {
        content: [
          {
            type: "text",
            text: JSON.stringify({ found: false, id: skillId })
          }
        ],
        isError: true
      });
    }
    return rpcResultObj(id, {
      content: [{ type: "text", text: JSON.stringify(skill, null, 2) }],
      structuredContent: skill
    });
  }
  return rpcErrorObj(id, -32601, `tool not found: ${name}`);
}

function rpcResultObj(
  id: JsonRpcId,
  result: Record<string, unknown>
): Record<string, unknown> {
  return { jsonrpc: "2.0", id, result };
}
function rpcErrorObj(
  id: JsonRpcId,
  code: number,
  message: string
): Record<string, unknown> {
  return { jsonrpc: "2.0", id, error: { code, message } };
}
function rpcError(id: JsonRpcId, code: number, message: string): Response {
  return jsonResponse(rpcErrorObj(id, code, message));
}
function emptyResponse(): Response {
  return new Response(null, {
    status: 204,
    headers: CORS_HEADERS
  });
}
function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      "content-type": "application/json",
      // CORS so browser-based MCP clients (Claude.ai web,
      // playgrounds, etc.) can hit us cross-origin.
      ...CORS_HEADERS
    }
  });
}

function parseOptionalIntegerArgument(
  value: unknown,
  name: string,
  min: number,
  max = Number.MAX_SAFE_INTEGER
): number | undefined | string {
  if (value === undefined) {
    return undefined;
  }
  let parsedValue: number;
  if (typeof value === "number") {
    parsedValue = value;
  } else if (typeof value === "string" && /^-?\d+$/.test(value.trim())) {
    parsedValue = Number(value.trim());
  } else {
    return `argument '${name}' must be an integer`;
  }
  if (!Number.isSafeInteger(parsedValue)) {
    return `argument '${name}' must be an integer`;
  }
  if (parsedValue < min || parsedValue > max) {
    return max === Number.MAX_SAFE_INTEGER
      ? `argument '${name}' must be an integer >= ${min}`
      : `argument '${name}' must be an integer between ${min} and ${max}`;
  }
  return parsedValue;
}
