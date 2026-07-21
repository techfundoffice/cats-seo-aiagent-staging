/* Priority 1 audit — content quality depth over a random sample of
 * published articles. Pulls the public /api/qa index, samples N
 * recent articles by lastUpdated, fetches their live HTML, runs the
 * production SEO scorer locally, and prints the score distribution
 * + failure breakdown. */

import { calculateSEOScore } from "../src/pipeline/seo-score";

const BASE = "https://cats-seo-aiagent.webmaster-bc8.workers.dev";
const SITE = "https://catsluvus.com";
const SAMPLE_SIZE = Number(process.env.SAMPLE_SIZE ?? "50");

type IndexEntry = {
  slug: string;
  keyword: string;
  url: string;
  categorySlug: string;
};

function deterministicSample<T>(arr: T[], n: number, seed: number): T[] {
  // LCG so results are reproducible.
  const out: T[] = [];
  const taken = new Set<number>();
  let s = seed;
  while (out.length < Math.min(n, arr.length)) {
    s = (s * 1664525 + 1013904223) >>> 0;
    const idx = s % arr.length;
    if (taken.has(idx)) continue;
    taken.add(idx);
    out.push(arr[idx]);
  }
  return out;
}

async function fetchHtml(url: string): Promise<string | null> {
  try {
    const res = await fetch(url, {
      signal: AbortSignal.timeout(15_000),
      headers: { "user-agent": "audit-bot/1 (catsluvus-cse)" }
    });
    if (!res.ok) return null;
    return await res.text();
  } catch {
    return null;
  }
}

async function fetchQa(
  categorySlug: string,
  slug: string
): Promise<{ title?: string; metaDescription?: string } | null> {
  try {
    const res = await fetch(`${BASE}/api/qa/${categorySlug}/${slug}`, {
      signal: AbortSignal.timeout(10_000)
    });
    if (!res.ok) return null;
    return (await res.json()) as { title?: string; metaDescription?: string };
  } catch {
    return null;
  }
}

function percentile(sorted: number[], p: number): number {
  if (sorted.length === 0) return 0;
  const i = Math.min(sorted.length - 1, Math.floor((sorted.length - 1) * p));
  return sorted[i];
}

async function main() {
  console.log(`Fetching /api/qa index from ${BASE} …`);
  const idxRes = await fetch(`${BASE}/api/qa`, {
    signal: AbortSignal.timeout(20_000)
  });
  if (!idxRes.ok) throw new Error(`QA index fetch failed: ${idxRes.status}`);
  const idx = (await idxRes.json()) as { articles: IndexEntry[] };
  console.log(`Index: ${idx.articles.length} articles total`);
  const sample = deterministicSample(idx.articles, SAMPLE_SIZE, 0xc0ffee);
  console.log(`Sampling ${sample.length} articles (seed 0xc0ffee)…\n`);

  type Row = {
    url: string;
    keyword: string;
    htmlLen: number;
    wordCount: number;
    score: number;
    failed: string[];
  };
  const rows: Row[] = [];
  let fetchFailures = 0;
  let i = 0;
  for (const a of sample) {
    i++;
    const html = await fetchHtml(`${SITE}${new URL(a.url).pathname}`);
    if (!html) {
      fetchFailures++;
      continue;
    }
    // Recover title + meta from the HTML head to feed the scorer.
    const titleM = html.match(/<title>([^<]*)<\/title>/i);
    const title = titleM ? titleM[1].trim() : "";
    const metaM = html.match(
      /<meta\s+name=["']description["']\s+content=["']([^"']*)["']/i
    );
    const metaDescription = metaM ? metaM[1].trim() : "";
    // Coarse word-count: strip tags, then split on whitespace.
    const bodyText = html
      .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, "")
      .replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, "")
      .replace(/<[^>]+>/g, " ");
    const wordCount = bodyText.split(/\s+/).filter(Boolean).length;
    const r = calculateSEOScore(html, a.keyword, title, metaDescription, 1000);
    const failedNames = r.checks.filter((c) => !c.passed).map((c) => c.name);
    rows.push({
      url: a.url,
      keyword: a.keyword,
      htmlLen: html.length,
      wordCount,
      score: r.score,
      failed: failedNames
    });
    if (i % 10 === 0) console.log(`  scored ${i}/${sample.length}…`);
  }
  console.log(
    `\nScored: ${rows.length} | fetch-failed: ${fetchFailures} | total: ${sample.length}\n`
  );

  // Distribution.
  const scores = rows.map((r) => r.score).sort((a, b) => a - b);
  const min = scores[0] ?? 0;
  const max = scores[scores.length - 1] ?? 0;
  const median = percentile(scores, 0.5);
  const p10 = percentile(scores, 0.1);
  const p90 = percentile(scores, 0.9);
  const mean = scores.reduce((a, b) => a + b, 0) / Math.max(1, scores.length);
  console.log("=== Score distribution (out of 105) ===");
  console.log(
    `  min=${min} | p10=${p10} | median=${median} | mean=${mean.toFixed(1)} | p90=${p90} | max=${max}`
  );
  console.log();

  // Word count distribution.
  const wcs = rows.map((r) => r.wordCount).sort((a, b) => a - b);
  console.log("=== Word count distribution (rendered body) ===");
  console.log(
    `  min=${wcs[0]} | p10=${percentile(wcs, 0.1)} | median=${percentile(wcs, 0.5)} | p90=${percentile(wcs, 0.9)} | max=${wcs[wcs.length - 1]}`
  );
  console.log();

  // Top failing checks across the sample.
  const failHist: Record<string, number> = {};
  for (const r of rows) {
    for (const f of r.failed) failHist[f] = (failHist[f] ?? 0) + 1;
  }
  const topFails = Object.entries(failHist)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 20);
  console.log(
    "=== Top failed checks across sample (count out of " + rows.length + ") ==="
  );
  for (const [name, n] of topFails) {
    const pct = ((n / rows.length) * 100).toFixed(0);
    console.log(`  ${String(n).padStart(3)} (${pct.padStart(3)}%) | ${name}`);
  }
  console.log();

  // Low-score outliers.
  const sortedAsc = [...rows].sort((a, b) => a.score - b.score);
  console.log("=== 5 lowest-scoring articles ===");
  for (const r of sortedAsc.slice(0, 5)) {
    console.log(`  ${r.score}/105 | ${r.wordCount}w | ${r.url}`);
  }
  console.log();

  // Word-count vs score scatter (binned).
  console.log("=== Word count × score (binned, count per cell) ===");
  const wcBins = [0, 500, 1000, 1500, 2000, 3000, 4000, 6000, 10000];
  const scoreBins = [0, 60, 70, 80, 85, 90, 95, 100, 106];
  const grid: number[][] = scoreBins
    .slice(0, -1)
    .map(() => wcBins.slice(0, -1).map(() => 0));
  for (const r of rows) {
    const wi = wcBins.findIndex(
      (b, j) => r.wordCount >= b && r.wordCount < wcBins[j + 1]
    );
    const si = scoreBins.findIndex(
      (b, j) => r.score >= b && r.score < scoreBins[j + 1]
    );
    if (wi >= 0 && si >= 0) grid[si][wi]++;
  }
  console.log(
    "                  | " +
      wcBins
        .slice(0, -1)
        .map((b, j) => `${b}-${wcBins[j + 1]}`.padStart(9))
        .join(" | ")
  );
  for (let si = scoreBins.length - 2; si >= 0; si--) {
    const label = `score ${scoreBins[si]}-${scoreBins[si + 1]}`.padStart(17);
    console.log(
      `${label} | ` +
        grid[si]
          .map((n) => (n === 0 ? "        ." : String(n).padStart(9)))
          .join(" | ")
    );
  }
}

main().catch((e) => {
  console.error("FATAL:", e);
  process.exit(1);
});
