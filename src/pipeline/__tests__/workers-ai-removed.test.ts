import { readdirSync, readFileSync, statSync } from "node:fs";
import { extname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const ROOT = fileURLToPath(new URL("../../../", import.meta.url));

const SOURCE_DIRS = ["src", "scripts"];
const SOURCE_EXT = new Set([
  ".ts",
  ".tsx",
  ".mts",
  ".js",
  ".mjs",
  ".cjs",
  ".py"
]);
const SKIP_FILES = new Set([
  "src/pipeline/__tests__/workers-ai-removed.test.ts"
]);
const TOKEN_SKIP = "scripts/doppler-to-wrangler-bulk.py";

/** Needles are split so this file is not itself a Workers AI call site. */
const CALL_PATTERNS: RegExp[] = [
  new RegExp(["/", "ai", "/", "run"].join("")),
  new RegExp(["env", "\\.AI\\b"].join("")),
  new RegExp(["envBindings", "\\.AI\\b"].join("")),
  new RegExp(["@", "cf/"].join("")),
  new RegExp(["workers-ai", "/"].join("")),
  new RegExp(["createWorkers", "AI"].join("")),
  new RegExp(["\\.AI", "\\.run\\b"].join(""))
];

const TOKEN_PATTERN = new RegExp(
  ["CLOUDFLARE", "_WORKERS_", "AI_TOKEN"].join("")
);

const BINDING_KEY = new RegExp(['"', "ai", '"\\s*:'].join(""));
const BINDING_NAME = new RegExp(['"binding"', "\\s*:\\s*", '"AI"'].join(""));
const ENV_AI_TYPE = new RegExp(["\\bAI\\??", "\\s*:\\s*", "Ai\\b"].join(""));

function walk(dir: string, out: string[]): void {
  let names: string[];
  try {
    names = readdirSync(dir);
  } catch {
    return;
  }
  for (const name of names) {
    if (name === "node_modules" || name === "dist" || name === ".git") {
      continue;
    }
    const path = join(dir, name);
    let info: ReturnType<typeof statSync>;
    try {
      info = statSync(path);
    } catch {
      continue;
    }
    if (info.isDirectory()) {
      walk(path, out);
      continue;
    }
    out.push(path);
  }
}

function rel(path: string): string {
  return relative(ROOT, path).split("\\").join("/");
}

function stripJsonComments(text: string): string {
  return text.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
}

describe("Workers AI stays removed", () => {
  it("has no AI binding in wrangler configs", () => {
    const configs: string[] = [];
    walk(ROOT, configs);
    const wranglers = configs.filter((path) => {
      const name = path.split("/").pop() ?? "";
      return (
        name === "wrangler.jsonc" ||
        name === "wrangler.json" ||
        name === "wrangler.toml"
      );
    });
    expect(wranglers.length).toBeGreaterThan(0);
    const hits: string[] = [];
    for (const path of wranglers) {
      const body = stripJsonComments(readFileSync(path, "utf8"));
      if (BINDING_KEY.test(body) || BINDING_NAME.test(body)) {
        hits.push(rel(path));
      }
    }
    expect(hits).toEqual([]);
  });

  it("does not type an Ai binding on Env", () => {
    const envPath = join(ROOT, "env.d.ts");
    const body = readFileSync(envPath, "utf8");
    expect(ENV_AI_TYPE.test(body)).toBe(false);
  });

  it("has no Workers AI call site in src or scripts", () => {
    const files: string[] = [];
    for (const dir of SOURCE_DIRS) {
      walk(join(ROOT, dir), files);
    }
    const hits: string[] = [];
    for (const path of files) {
      const name = rel(path);
      if (SKIP_FILES.has(name)) continue;
      if (!SOURCE_EXT.has(extname(path))) continue;
      const body = readFileSync(path, "utf8");
      for (const pattern of CALL_PATTERNS) {
        if (pattern.test(body)) {
          hits.push(`${name} matches ${pattern.source}`);
        }
      }
      if (name !== TOKEN_SKIP && TOKEN_PATTERN.test(body)) {
        hits.push(`${name} names the Workers AI token`);
      }
    }
    expect(hits).toEqual([]);
  });

  it("does not install the Workers AI token on deploy", () => {
    const body = readFileSync(
      join(ROOT, "scripts/doppler-to-wrangler-bulk.py"),
      "utf8"
    );
    expect(body).toContain('"CLOUDFLARE_WORKERS_AI_TOKEN"');
    const skipBlock = body.slice(
      body.indexOf("SKIP = {"),
      body.indexOf("}", body.indexOf("SKIP = {"))
    );
    expect(skipBlock).toContain("CLOUDFLARE_WORKERS_AI_TOKEN");
  });
});
