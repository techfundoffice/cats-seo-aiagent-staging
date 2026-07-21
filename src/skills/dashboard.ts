/**
 * Self-contained HTML dashboard for the cats-seo-skills D1 catalog.
 *
 * Served at GET /skills by the worker fetch handler. Pure HTML/CSS/JS
 * (no build step), Tailwind + marked.js loaded from CDN. Hits the
 * existing /api/skills + /api/skills/search endpoints. Designed to
 * read fine on phones and big monitors.
 */

const HEAD = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover" />
<title>Skills Catalog · cats-seo-skills</title>
<meta name="robots" content="noindex,nofollow" />
<link rel="icon" href="data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 100 100'%3E%3Ctext y='.9em' font-size='90'%3E%F0%9F%90%88%3C/text%3E%3C/svg%3E" />
<script src="https://cdn.jsdelivr.net/npm/marked@12.0.2/marked.min.js"></script>
<script src="https://cdn.tailwindcss.com/3.4.16"></script>
<style>
:root { color-scheme: dark; }
html, body { background: #0b0d10; }
mark { background: #facc1533; color: inherit; padding: 0 2px; border-radius: 2px; }
.prose-skill h1, .prose-skill h2, .prose-skill h3 { color: #f1f5f9; font-weight: 600; }
.prose-skill h1 { font-size: 1.25rem; margin: 1.5rem 0 .75rem; }
.prose-skill h2 { font-size: 1.1rem; margin: 1.25rem 0 .5rem; padding-bottom: .25rem; border-bottom: 1px solid #1f2937; }
.prose-skill h3 { font-size: 1rem; margin: 1rem 0 .5rem; color: #cbd5e1; }
.prose-skill p, .prose-skill ul, .prose-skill ol { color: #cbd5e1; line-height: 1.55; margin: .5rem 0; }
.prose-skill ul { list-style: disc; padding-left: 1.25rem; }
.prose-skill ol { list-style: decimal; padding-left: 1.25rem; }
.prose-skill li { margin: .15rem 0; }
.prose-skill a { color: #60a5fa; text-decoration: underline; }
.prose-skill code { background: #111827; color: #fbbf24; padding: 1px 5px; border-radius: 3px; font-size: .85em; }
.prose-skill pre { background: #0f172a; color: #e2e8f0; padding: .9rem 1rem; border-radius: 6px; overflow-x: auto; border: 1px solid #1f2937; margin: .75rem 0; font-size: .85rem; }
.prose-skill pre code { background: transparent; padding: 0; color: inherit; }
.prose-skill blockquote { border-left: 3px solid #475569; padding-left: .9rem; color: #94a3b8; margin: .75rem 0; }
.prose-skill table { border-collapse: collapse; margin: .75rem 0; font-size: .9rem; }
.prose-skill th, .prose-skill td { border: 1px solid #1f2937; padding: .35rem .6rem; text-align: left; }
.prose-skill th { background: #111827; color: #f1f5f9; }
.prose-skill hr { border-color: #1f2937; margin: 1rem 0; }
.spin { animation: spin 0.8s linear infinite; transform-origin: center; }
@keyframes spin { from { transform: rotate(0deg); } to { transform: rotate(360deg); } }
.fade-in { animation: fadein 180ms ease-out; }
@keyframes fadein { from { opacity: 0; transform: translateY(2px); } to { opacity: 1; transform: none; } }
</style>
</head>`;

const BODY_AND_SCRIPT = `
<body class="min-h-screen bg-[#0b0d10] text-slate-200 font-sans antialiased">
<header class="border-b border-slate-800/60 bg-[#0b0d10]/95 backdrop-blur sticky top-0 z-30">
  <div class="max-w-6xl mx-auto px-4 py-3 flex items-center gap-4">
    <div class="text-2xl">🐈</div>
    <div class="flex-1">
      <h1 class="text-base font-semibold text-slate-100 leading-tight">cats-seo-skills</h1>
      <p class="text-xs text-slate-500 leading-tight">agentskill.sh catalog mirror · D1 FTS5 · BM25 ranking</p>
    </div>
    <button id="n8nBtn" type="button"
      class="inline-flex items-center gap-1.5 text-xs text-slate-300 hover:text-white px-2 py-1 rounded border border-slate-700 hover:border-[#EA4B71]/60"
      title="Wire to your n8n workflow">
      <svg viewBox="0 0 80 80" class="w-3.5 h-3.5" xmlns="http://www.w3.org/2000/svg" aria-hidden="true">
        <line x1="20" y1="40" x2="34" y2="40" stroke="#EA4B71" stroke-width="4"/>
        <line x1="46" y1="40" x2="60" y2="22" stroke="#EA4B71" stroke-width="4"/>
        <line x1="46" y1="40" x2="60" y2="58" stroke="#EA4B71" stroke-width="4"/>
        <circle cx="14" cy="40" r="8" fill="#EA4B71"/>
        <circle cx="40" cy="40" r="8" fill="#EA4B71"/>
        <circle cx="66" cy="22" r="8" fill="#EA4B71"/>
        <circle cx="66" cy="58" r="8" fill="#EA4B71"/>
      </svg>
      n8n
    </button>
    <a href="/mcp" class="hidden sm:inline-block text-xs text-slate-400 hover:text-slate-200 px-2 py-1 rounded border border-slate-700">MCP server</a>
    <span id="rateBadge" class="hidden sm:inline-block text-xs text-slate-500 px-2 py-1 rounded bg-slate-900/60 border border-slate-800"></span>
  </div>
</header>

<main class="max-w-6xl mx-auto px-4 py-6">
  <section id="stats" class="grid grid-cols-2 sm:grid-cols-4 gap-3 mb-6">
    <div class="rounded-lg bg-slate-900/40 border border-slate-800 p-3">
      <div class="text-[10px] uppercase tracking-wider text-slate-500">Total skills</div>
      <div id="statTotal" class="text-2xl font-semibold text-slate-100">…</div>
    </div>
    <div class="rounded-lg bg-slate-900/40 border border-slate-800 p-3">
      <div class="text-[10px] uppercase tracking-wider text-slate-500">With body</div>
      <div id="statBodies" class="text-2xl font-semibold text-emerald-400">…</div>
    </div>
    <div class="rounded-lg bg-slate-900/40 border border-slate-800 p-3">
      <div class="text-[10px] uppercase tracking-wider text-slate-500">Owners</div>
      <div id="statOwners" class="text-2xl font-semibold text-slate-100">…</div>
    </div>
    <div class="rounded-lg bg-slate-900/40 border border-slate-800 p-3">
      <div class="text-[10px] uppercase tracking-wider text-slate-500">Last query</div>
      <div id="statTook" class="text-2xl font-semibold text-amber-300">—</div>
    </div>
  </section>

  <section class="mb-4">
    <div class="flex items-center gap-2 rounded-lg border border-slate-700 bg-slate-900/60 px-3 py-2 focus-within:border-amber-400/60">
      <svg class="w-5 h-5 text-slate-500" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
        <circle cx="11" cy="11" r="7"/><path d="M21 21l-4.3-4.3"/>
      </svg>
      <input id="q" type="search" autocomplete="off" autofocus
        placeholder="Search 104k skills — try 'kubernetes debugging' or 'react form hook'"
        class="flex-1 bg-transparent text-slate-100 placeholder-slate-500 outline-none text-sm" />
      <span id="searchSpin" class="hidden text-amber-300">
        <svg class="w-4 h-4 spin" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
          <path d="M21 12a9 9 0 1 1-6.2-8.55"/>
        </svg>
      </span>
    </div>
    <div class="mt-3 flex flex-wrap items-center gap-3 text-xs text-slate-400">
      <label class="flex items-center gap-1">
        per page
        <select id="k" class="bg-slate-900 border border-slate-700 rounded px-2 py-1 text-slate-200">
          <option>10</option><option selected>25</option><option>50</option><option>100</option>
        </select>
      </label>
      <label class="flex items-center gap-1">
        owner
        <input id="owner" placeholder="any" class="bg-slate-900 border border-slate-700 rounded px-2 py-1 w-32 text-slate-200 placeholder-slate-600" />
      </label>
      <label class="flex items-center gap-1 cursor-pointer">
        <input id="incBody" type="checkbox" checked class="accent-amber-400" />
        include body
      </label>
      <span id="meta" class="ml-auto text-slate-500"></span>
    </div>
  </section>

  <nav id="pager" class="hidden flex items-center gap-2 mb-3 text-xs">
    <button id="pagePrev" class="px-2 py-1 rounded border border-slate-700 text-slate-300 hover:text-white hover:border-slate-500 disabled:opacity-30 disabled:cursor-not-allowed">← prev</button>
    <span id="pageInfo" class="text-slate-400"></span>
    <button id="pageNext" class="px-2 py-1 rounded border border-slate-700 text-slate-300 hover:text-white hover:border-slate-500 disabled:opacity-30 disabled:cursor-not-allowed">next →</button>
    <span class="ml-3 text-slate-600">jump to</span>
    <input id="pageJump" type="number" min="1" class="w-16 bg-slate-900 border border-slate-700 rounded px-2 py-1 text-slate-200" />
    <button id="pageJumpGo" class="px-2 py-1 rounded border border-slate-700 text-slate-300 hover:text-white hover:border-slate-500">go</button>
  </nav>

  <section id="n8nPanel" class="hidden mb-4 rounded-lg border border-[#EA4B71]/40 bg-[#1a0f15] p-4 fade-in">
    <div class="flex items-start gap-3">
      <svg viewBox="0 0 80 80" class="w-7 h-7 flex-shrink-0 mt-0.5" xmlns="http://www.w3.org/2000/svg" aria-hidden="true">
        <line x1="20" y1="40" x2="34" y2="40" stroke="#EA4B71" stroke-width="4"/>
        <line x1="46" y1="40" x2="60" y2="22" stroke="#EA4B71" stroke-width="4"/>
        <line x1="46" y1="40" x2="60" y2="58" stroke="#EA4B71" stroke-width="4"/>
        <circle cx="14" cy="40" r="8" fill="#EA4B71"/>
        <circle cx="40" cy="40" r="8" fill="#EA4B71"/>
        <circle cx="66" cy="22" r="8" fill="#EA4B71"/>
        <circle cx="66" cy="58" r="8" fill="#EA4B71"/>
      </svg>
      <div class="flex-1 min-w-0 space-y-3">
        <div class="flex items-center gap-2">
          <h3 class="text-sm font-semibold text-slate-100">Connected to your n8n workflow</h3>
          <a href="https://n8n.srv828840.hstgr.cloud/workflow/Cq4OuDbFj84JjUXQ" target="_blank" rel="noopener"
            class="text-[11px] text-[#EA4B71] hover:underline">open editor ↗</a>
          <button id="n8nClose" class="ml-auto text-slate-500 hover:text-slate-200 text-xs">close</button>
        </div>

        <div class="text-[11px] text-slate-400 space-y-1">
          <div class="flex items-center gap-2">
            <span class="text-slate-500 w-20">Webhook</span>
            <code class="flex-1 truncate bg-slate-900/60 border border-slate-800 rounded px-2 py-1 text-slate-300 font-mono text-[10px]" id="n8nWebhookUrl"></code>
            <button data-copy="n8nWebhookUrl" class="text-[10px] text-slate-400 hover:text-white px-1.5 py-1 rounded border border-slate-700">copy</button>
          </div>
          <div class="flex items-center gap-2">
            <span class="text-slate-500 w-20">Worker API</span>
            <code class="flex-1 truncate bg-slate-900/60 border border-slate-800 rounded px-2 py-1 text-slate-300 font-mono text-[10px]" id="n8nWorkerUrl">https://cats-seo-aiagent.webmaster-bc8.workers.dev/api/skills/search?q={{$json.q}}&amp;k=5&amp;body=1</code>
            <button data-copy="n8nWorkerUrl" class="text-[10px] text-slate-400 hover:text-white px-1.5 py-1 rounded border border-slate-700">copy</button>
          </div>
        </div>

        <div class="flex items-center gap-2 flex-wrap">
          <button id="n8nRun" class="text-xs bg-[#EA4B71] hover:bg-[#d63d63] text-white px-3 py-1.5 rounded font-medium">
            Run current query through n8n
          </button>
          <span id="n8nStatus" class="text-[11px] text-slate-500"></span>
        </div>

        <pre id="n8nResponse" class="hidden bg-slate-900/60 border border-slate-800 rounded p-3 text-[11px] text-slate-300 font-mono overflow-x-auto max-h-80"></pre>
        <div id="n8nHint" class="hidden text-[11px] text-amber-300 bg-amber-950/30 border border-amber-700/40 rounded px-3 py-2"></div>
      </div>
    </div>
  </section>

  <section id="results" class="space-y-3"></section>

  <section id="empty" class="hidden text-center text-slate-500 py-16">
    <div class="text-3xl mb-2">🔍</div>
    <div class="text-sm">Type a query above to search the catalog.</div>
  </section>

  <section id="error" class="hidden rounded border border-red-700/40 bg-red-950/30 p-3 text-red-300 text-sm"></section>

  <footer class="mt-12 pt-6 border-t border-slate-800/60 text-xs text-slate-500 flex flex-wrap items-center gap-4">
    <span>D1 \`cats-seo-skills\` · 104,292 metadata · 93,206 bodies</span>
    <a class="text-slate-400 hover:text-slate-200" href="/api/skills/crawl/status">crawl status</a>
    <a class="text-slate-400 hover:text-slate-200" href="/mcp">/mcp</a>
    <a class="text-slate-400 hover:text-slate-200" href="https://agentskill.sh">agentskill.sh</a>
    <a class="text-slate-400 hover:text-slate-200" href="https://n8n.srv828840.hstgr.cloud/workflow/Cq4OuDbFj84JjUXQ" target="_blank" rel="noopener">n8n workflow</a>
    <span class="ml-auto">Cloudflare Workers · D1 FTS5</span>
  </footer>
</main>

<script>
(() => {
  const $ = (id) => document.getElementById(id);
  const escape = (s) => String(s ?? "").replace(/[&<>"']/g, c => ({
    "&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"
  }[c]));
  const SEARCH_SNIPPET_MARK_OPEN = "__SKILL_SNIPPET_MARK_OPEN__";
  const SEARCH_SNIPPET_MARK_CLOSE = "__SKILL_SNIPPET_MARK_CLOSE__";
  const MARK_TAG_RE = new RegExp("</?mark>", "g");
  function hasBalancedSnippetMarkTags(raw) {
    const tags = String(raw ?? "").match(MARK_TAG_RE) ?? [];
    let depth = 0;
    for (const tag of tags) {
      if (tag === "<mark>") depth++;
      else depth--;
      if (depth < 0) return false;
    }
    return depth === 0;
  }
  function renderSearchSnippetHtml(raw) {
    const input = String(raw ?? "");
    if (!hasBalancedSnippetMarkTags(input)) {
      return escape(input);
    }
    const normalized = input
      .split("<mark>").join(SEARCH_SNIPPET_MARK_OPEN)
      .split("</mark>").join(SEARCH_SNIPPET_MARK_CLOSE);
    return escape(normalized)
      .split(SEARCH_SNIPPET_MARK_OPEN).join("<mark>")
      .split(SEARCH_SNIPPET_MARK_CLOSE).join("</mark>");
  }
  function sanitizeMarkdownUrl(raw, { allowMailto = false } = {}) {
    const value = String(raw ?? "").trim();
    if (!value) return null;
    if (
      value.startsWith("#") ||
      value.startsWith("/") ||
      value.startsWith("./") ||
      value.startsWith("../")
    ) {
      return value;
    }
    try {
      const parsed = new URL(value, location.origin);
      const isHttp = parsed.protocol === "http:" || parsed.protocol === "https:";
      const isMailto = allowMailto && parsed.protocol === "mailto:";
      return isHttp || isMailto ? parsed.href : null;
    } catch {
      return null;
    }
  }
  function createSafeMarkedRenderer() {
    if (!window.marked?.Renderer) return null;
    const renderer = new window.marked.Renderer();
    renderer.html = function(token) {
      return escape(typeof token?.text === "string" ? token.text : token);
    };
    renderer.link = function(token) {
      const safeHref = sanitizeMarkdownUrl(token?.href, { allowMailto: true });
      const text = this.parser?.parseInline(token?.tokens ?? []) ?? escape(token?.text ?? "");
      if (!safeHref) return text;
      const titleAttr = token?.title
        ? ' title="' + escape(token.title) + '"'
        : "";
      return '<a href="' + escape(safeHref) + '" target="_blank" rel="noopener noreferrer"' + titleAttr + '>' + text + '</a>';
    };
    renderer.image = function(token) {
      const safeSrc = sanitizeMarkdownUrl(token?.href);
      if (!safeSrc) {
        return escape(token?.text ?? "");
      }
      const titleAttr = token?.title
        ? ' title="' + escape(token.title) + '"'
        : "";
      return '<img src="' + escape(safeSrc) + '" alt="' + escape(token?.text ?? "") + '"' + titleAttr + ' loading="lazy" referrerpolicy="no-referrer" />';
    };
    return renderer;
  }
  function renderSkillMarkdown(md) {
    const safeMarkedRenderer = createSafeMarkedRenderer();
    return window.marked && safeMarkedRenderer
      ? window.marked.parse(md, {
          breaks: true,
          gfm: true,
          renderer: safeMarkedRenderer
        })
      : '<pre>' + escape(md) + '</pre>';
  }

  function showError(msg) {
    const e = $("error");
    e.textContent = msg;
    e.classList.remove("hidden");
    setTimeout(() => e.classList.add("hidden"), 6000);
  }
  function setN8nStatusMessage(message, tone = "muted") {
    const e = $("n8nStatus");
    e.textContent = message;
    e.classList.remove("text-slate-500", "text-emerald-400", "text-amber-300");
    if (tone === "success") {
      e.classList.add("text-emerald-400");
    } else if (tone === "warning") {
      e.classList.add("text-amber-300");
    } else {
      e.classList.add("text-slate-500");
    }
  }
  function formatClientError(err, maxLen = 200) {
    const message =
      err instanceof Error && err.message
        ? err.message
        : err &&
            typeof err === "object" &&
            "message" in err &&
            typeof err.message === "string"
          ? err.message
          : err;
    const fallback = String(message ?? "")
      .replace(/\\s+/g, " ")
      .trim();
    return (fallback || "Unexpected error").slice(0, maxLen);
  }

  // ── Stats ─────────────────────────────────────────────────────────
  fetch("/api/skills?limit=1&body=0")
    .then(r => r.json())
    .then(d => {
      $("statTotal").textContent = (d.total ?? 0).toLocaleString();
    })
    .catch(() => $("statTotal").textContent = "?");
  // We don't have a dedicated stats endpoint for bodies/owners yet,
  // so show the numbers verified at deploy time.
  $("statBodies").textContent = "93,206";
  $("statOwners").textContent = "958";

  // ── Search ────────────────────────────────────────────────────────
  let lastReq = 0;
  let timer = null;
  let currentPage = 1;
  let lastSearchData = null;

  function writeUrlState(s) {
    const sp = new URLSearchParams();
    if (s.q) sp.set("q", s.q);
    if (s.page && s.page > 1) sp.set("page", String(s.page));
    if (s.k && s.k !== 25) sp.set("k", String(s.k));
    if (s.owner) sp.set("owner", s.owner);
    if (s.body === false) sp.set("body", "0");
    const next = sp.toString() ? "?" + sp.toString() : location.pathname;
    history.replaceState(null, "", next);
  }
  /**
   * Parses a positive integer from URL/form state, otherwise returns the
   * supplied fallback. Rejects partial/non-decimal strings like "25px".
   */
  function parsePositiveInt(raw, fallback, max = Number.MAX_SAFE_INTEGER) {
    const safeFallback =
      Number.isSafeInteger(fallback) && fallback > 0 ? fallback : 1;
    const safeMax =
      Number.isSafeInteger(max) && max > 0 ? max : Number.MAX_SAFE_INTEGER;
    const normalized = String(raw ?? "").trim();
    if (!/^\\d+$/.test(normalized)) return safeFallback;
    const parsed = Number.parseInt(normalized, 10);
    if (
      Number.isNaN(parsed) ||
      !Number.isSafeInteger(parsed) ||
      parsed <= 0
    ) {
      return safeFallback;
    }
    return Math.min(parsed, safeMax);
  }
  function readUrlState() {
    const sp = new URLSearchParams(location.search);
    return {
      q: sp.get("q") || "",
      page: parsePositiveInt(sp.get("page"), 1),
      k: parsePositiveInt(sp.get("k"), 25, 100),
      owner: sp.get("owner") || "",
      body: sp.get("body") !== "0"
    };
  }

  async function runSearch() {
    const q = $("q").value.trim();
    if (!q) {
      $("results").innerHTML = "";
      $("empty").classList.remove("hidden");
      $("meta").textContent = "";
      $("statTook").textContent = "—";
      $("pager").classList.add("hidden");
      writeUrlState({ q: "", page: 1 });
      return;
    }
    $("empty").classList.add("hidden");
    $("searchSpin").classList.remove("hidden");
    const reqId = ++lastReq;

    const k = parsePositiveInt($("k").value, 25, 100);
    const offset = (currentPage - 1) * k;
    const owner = $("owner").value.trim();
    const includeBody = $("incBody").checked ? "1" : "0";
    const params = new URLSearchParams({
      q,
      k: String(k),
      offset: String(offset),
      body: includeBody
    });
    if (owner) params.set("owner", owner);

    try {
      const t0 = performance.now();
      const r = await fetch("/api/skills/search?" + params);
      const wallMs = (performance.now() - t0).toFixed(0);
      if (reqId !== lastReq) return; // a newer query beat us
      if (!r.ok) {
        showError("HTTP " + r.status + " on /api/skills/search");
        return;
      }
      const data = await r.json();
      lastSearchData = data;
      $("statTook").textContent = (data.took_ms ?? "?") + "ms";
      const total = data.total_matches ?? data.count ?? 0;
      const start = (data.offset ?? 0) + 1;
      const end = (data.offset ?? 0) + (data.count ?? 0);
      $("meta").textContent =
        (total === 0
          ? "no matches"
          : "showing " + start + "–" + end + " of " + total.toLocaleString()) +
        " · server " + data.took_ms + "ms · wall " + wallMs + "ms";
      render(data.hits || []);
      renderPager(data);
      writeUrlState({ q, page: currentPage, k, owner, body: $("incBody").checked });
    } catch (e) {
      showError(formatClientError(e));
    } finally {
      if (reqId === lastReq) $("searchSpin").classList.add("hidden");
    }
  }

  function debouncedSearch() {
    clearTimeout(timer);
    timer = setTimeout(() => { currentPage = 1; runSearch(); }, 220);
  }

  function renderPager(data) {
    const total = data.total_matches ?? 0;
    const k = parsePositiveInt(data.k ?? $("k").value, 25, 100);
    if (total <= k) {
      $("pager").classList.add("hidden");
      return;
    }
    const totalPages = Math.max(1, Math.ceil(total / k));
    $("pager").classList.remove("hidden");
    $("pager").classList.add("flex");
    $("pageInfo").textContent = "page " + currentPage + " of " + totalPages.toLocaleString();
    $("pagePrev").disabled = currentPage <= 1;
    $("pageNext").disabled = !data.has_more;
    $("pageJump").max = totalPages;
    $("pageJump").placeholder = String(totalPages);
  }

  function render(hits) {
    if (!hits.length) {
      $("results").innerHTML = '<div class="text-center text-slate-500 py-10 text-sm">No matches. Try fewer or different words.</div>';
      return;
    }
    const html = hits.map((h, i) => {
      const ownerBadge = '<span class="px-1.5 py-0.5 rounded bg-slate-800 text-slate-300 text-[10px] font-mono">' + escape(h.owner) + '</span>';
      const score = h.score?.toFixed(2) ?? "";
      const desc = h.description ? '<p class="mt-1.5 text-sm text-slate-400 line-clamp-3">' + escape(h.description) + '</p>' : '';
      const snippet = (h.snippet && h.snippet.trim())
        ? '<p class="mt-2 text-xs text-slate-500 italic">…' + renderSearchSnippetHtml(h.snippet) + '…</p>' : '';
      const hasBody = h.skill_md && h.skill_md.length > 0;
      const id = "card-" + i;
      const sourceUrl = h.source_url ? '<a class="text-slate-500 hover:text-slate-300 text-xs" href="' + escape(h.source_url) + '" target="_blank" rel="noopener">↗ agentskill.sh</a>' : '';
      const expand = hasBody
        ? '<button data-toggle="' + id + '" class="text-xs text-amber-300 hover:text-amber-200 border border-amber-300/30 rounded px-2 py-1">View SKILL.md</button>'
        : '<span class="text-xs text-slate-600">no body cached</span>';
      const bodySection = hasBody
        ? '<div id="' + id + '" class="hidden mt-3 prose-skill text-sm border-t border-slate-800 pt-3 fade-in"></div>' : '';
      return '<article class="rounded-lg bg-slate-900/40 border border-slate-800 hover:border-slate-700 p-4 transition fade-in">' +
        '<div class="flex items-start gap-3">' +
          '<div class="flex-1 min-w-0">' +
            '<div class="flex items-center gap-2 flex-wrap">' +
              ownerBadge +
              '<h2 class="text-slate-100 font-semibold text-sm truncate">' + escape(h.name || h.slug) + '</h2>' +
              '<span class="text-[10px] text-slate-600 font-mono ml-auto">bm25 ' + score + '</span>' +
            '</div>' +
            '<div class="text-[11px] text-slate-500 font-mono mt-0.5">' + escape(h.id) + '</div>' +
            desc + snippet +
            '<div class="flex items-center gap-3 mt-3">' +
              expand +
              sourceUrl +
            '</div>' +
            bodySection +
          '</div>' +
        '</div>' +
      '</article>';
    }).join("");
    $("results").innerHTML = html;
    // Stash bodies on dataset so toggle is instant.
    document.querySelectorAll('[data-toggle]').forEach((btn, i) => {
      const target = document.getElementById(btn.dataset.toggle);
      if (!target) return;
      btn.addEventListener("click", () => {
        if (target.classList.contains("hidden")) {
          if (!target.dataset.rendered) {
            const md = hits[i]?.skill_md || "";
            target.innerHTML = renderSkillMarkdown(md);
            target.dataset.rendered = "1";
          }
          target.classList.remove("hidden");
          btn.textContent = "Hide SKILL.md";
        } else {
          target.classList.add("hidden");
          btn.textContent = "View SKILL.md";
        }
      });
    });
  }

  $("q").addEventListener("input", debouncedSearch);
  $("k").addEventListener("change", () => { currentPage = 1; runSearch(); });
  $("owner").addEventListener("change", () => { currentPage = 1; runSearch(); });
  $("incBody").addEventListener("change", () => { currentPage = 1; runSearch(); });

  $("pagePrev").addEventListener("click", () => {
    if (currentPage > 1) {
      currentPage--;
      runSearch();
      window.scrollTo({ top: 0, behavior: "smooth" });
    }
  });
  $("pageNext").addEventListener("click", () => {
    if (lastSearchData?.has_more) {
      currentPage++;
      runSearch();
      window.scrollTo({ top: 0, behavior: "smooth" });
    }
  });
  function jumpTo(n) {
    const total = lastSearchData?.total_matches ?? 0;
    const k = parsePositiveInt($("k").value, 25, 100);
    const totalPages = Math.max(1, Math.ceil(total / k));
    const target = Math.min(Math.max(1, n | 0), totalPages);
    if (target !== currentPage) {
      currentPage = target;
      runSearch();
      window.scrollTo({ top: 0, behavior: "smooth" });
    }
  }
  $("pageJumpGo").addEventListener("click", () => {
    jumpTo(parsePositiveInt($("pageJump").value, currentPage));
  });
  $("pageJump").addEventListener("keydown", (e) => {
    if (e.key === "Enter") {
      jumpTo(parsePositiveInt($("pageJump").value, currentPage));
    }
  });

  // ── Initial state from URL ───────────────────────────────────────
  const initial = readUrlState();
  if (initial.k) $("k").value = String(initial.k);
  if (initial.owner) $("owner").value = initial.owner;
  $("incBody").checked = initial.body;
  if (initial.q) {
    $("q").value = initial.q;
    currentPage = initial.page;
    runSearch();
  } else {
    $("empty").classList.remove("hidden");
  }

  // ── n8n panel ────────────────────────────────────────────────────
  let n8nInfoLoaded = false;
  async function loadN8nInfo() {
    if (n8nInfoLoaded) return;
    setN8nStatusMessage("loading n8n info…");
    try {
      const r = await fetch("/api/skills/n8n-info");
      if (!r.ok) {
        const rawDetail = (await r.text()).trim();
        let detail = rawDetail;
        if (rawDetail.length > 120) {
          detail = rawDetail.slice(0, 120) + "…";
        }
        throw new Error(
          "HTTP " + r.status + (detail ? ": " + detail : "")
        );
      }
      const info = await r.json();
      $("n8nWebhookUrl").textContent = info.webhook_url || "";
      setN8nStatusMessage("");
      n8nInfoLoaded = true;
    } catch (err) {
      console.warn(
        "n8n info load failed:",
        formatClientError(err)
      );
      setN8nStatusMessage("couldn't load n8n info", "warning");
    }
  }

  $("n8nBtn").addEventListener("click", () => {
    const panel = $("n8nPanel");
    if (panel.classList.contains("hidden")) {
      panel.classList.remove("hidden");
      loadN8nInfo();
    } else {
      panel.classList.add("hidden");
    }
  });
  $("n8nClose").addEventListener("click", () => $("n8nPanel").classList.add("hidden"));

  document.querySelectorAll("[data-copy]").forEach((btn) => {
    btn.addEventListener("click", async () => {
      const target = document.getElementById(btn.dataset.copy);
      if (!target) return;
      if (!navigator.clipboard?.writeText) {
        showError("Clipboard copy is unavailable in this browser context.");
        return;
      }
      try {
        await navigator.clipboard.writeText(target.textContent || "");
        const original = btn.textContent;
        btn.textContent = "copied";
        setTimeout(() => { btn.textContent = original; }, 900);
      } catch (err) {
        console.warn(
          "clipboard copy failed for target",
          btn.dataset.copy || "(unknown)",
          ":",
          formatClientError(err)
        );
        showError("Clipboard copy failed. Try copying manually.");
      }
    });
  });

  $("n8nRun").addEventListener("click", async () => {
    const q = $("q").value.trim() || "cloudflare worker deployment";
    // /api/skills/n8n-search clamps k to [1,25].
    const k = parsePositiveInt($("k").value, 5, 25);
    setN8nStatusMessage("calling n8n…");
    $("n8nResponse").classList.add("hidden");
    $("n8nHint").classList.add("hidden");
    try {
      const t0 = performance.now();
      const r = await fetch("/api/skills/n8n-search", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ q, k })
      });
      const raw = await r.text();
      if (!r.ok) {
        const detail = raw.trim().replace(/\\s+/g, " ").slice(0, 120);
        throw new Error("HTTP " + r.status + (detail ? ": " + detail : ""));
      }
      let parsed;
      try {
        parsed = JSON.parse(raw);
      } catch {
        throw new Error("n8n response was not valid JSON");
      }
      const data =
        parsed !== null &&
        typeof parsed === "object" &&
        !Array.isArray(parsed)
          ? parsed
          : { n8n_body: parsed };
      const statusCode =
        typeof data.n8n_status === "number" ? data.n8n_status : null;
      const method =
        typeof data.n8n_method === "string" && data.n8n_method.trim()
          ? data.n8n_method
          : "?";
      const serverMs =
        typeof data.took_ms === "number" || typeof data.took_ms === "string"
          ? String(data.took_ms)
          : "?";
      const wallMs = (performance.now() - t0).toFixed(0);
      setN8nStatusMessage(
        "n8n HTTP " + (statusCode ?? "?") +
          " · " + method +
          " · server " + serverMs + "ms · wall " + wallMs + "ms",
        statusCode === 200 ? "success" : "warning"
      );
      $("n8nResponse").textContent = JSON.stringify(data.n8n_body, null, 2);
      $("n8nResponse").classList.remove("hidden");
      if (typeof data.hint === "string" && data.hint) {
        $("n8nHint").textContent = data.hint;
        $("n8nHint").classList.remove("hidden");
      }
    } catch (e) {
      setN8nStatusMessage(
        "fetch failed: " + formatClientError(e, 120),
        "warning"
      );
    }
  });
})();
</script>
</body>
</html>`;

/**
 * Returns the dashboard HTML payload served by the `/dashboard` route.
 */
export function dashboardHTML(): string {
  return HEAD + BODY_AND_SCRIPT;
}
