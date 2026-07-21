export const dynamic = 'force-dynamic';

import Link from 'next/link';
import {
  Activity, BarChart2, Clock, FileSearch2, Gauge, GitMerge, Globe,
  Lightbulb, Link2, MapPin, MessageSquare, Search, Star, TrendingUp,
  TrendingDown, Users
} from 'lucide-react';
import {
  getCredentials,
  getTrackedKeywords,
  getRankHistory,
  getSerpHistory,
  getKwOverviewHistory,
  getKwDifficultyHistory,
  getRelatedKwHistory,
  getRankedKwHistory,
  getKdHistory,
  getBacklinksHistory,
  getRefDomainsHistory,
  getAnchorsHistory,
  getCompetitorsHistory,
  getDomainIntersectionHistory,
  getHistRankHistory,
  getLfHistory,
  getGridHistory,
  getInstantPageHistory,
  getRedditHistory,
  getReviewsTasks
} from '@/lib/db';
import BalanceBadge from '@/components/BalanceBadge';
import { saveCredentialsAction } from './actions';

function timeAgo(ts: number): string {
  const diff = Date.now() - ts;
  const s = Math.max(0, Math.floor(diff / 1000));
  if (s < 60) return `${s}s ago`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  const d = Math.floor(h / 24);
  if (d < 30) return `${d}d ago`;
  const mo = Math.floor(d / 30);
  return `${mo}mo ago`;
}

interface ActivityRow {
  tool: string;
  ts: number;
  label: string;
  meta?: string;
  href: string;
}

export default async function DashboardPage() {
  const creds = await getCredentials();

  if (!creds) {
    return (
      <div className="bg-white rounded-2xl shadow-sm border border-slate-200 p-10 max-w-lg mx-auto mt-10">
        <h2 className="text-2xl font-black text-slate-900 mb-2 tracking-tight">DataForSEO login</h2>
        <p className="text-slate-500 text-sm mb-8">Enter your API credentials to get started. They&apos;re stored locally.</p>
        <form action={saveCredentialsAction} className="space-y-4">
          <div>
            <label className="block text-[10px] font-black text-slate-400 uppercase tracking-widest mb-1.5">API Login</label>
            <input type="text" name="login" required className="w-full px-4 py-3 border border-slate-200 rounded-xl text-sm focus:ring-2 focus:ring-blue-500 focus:border-blue-500 outline-none transition-all" />
          </div>
          <div>
            <label className="block text-[10px] font-black text-slate-400 uppercase tracking-widest mb-1.5">API Password</label>
            <input type="password" name="password" required className="w-full px-4 py-3 border border-slate-200 rounded-xl text-sm focus:ring-2 focus:ring-blue-500 focus:border-blue-500 outline-none transition-all" />
          </div>
          <button type="submit" className="w-full bg-blue-600 text-white font-black uppercase text-xs tracking-widest py-3.5 rounded-xl hover:bg-blue-700 transition-colors">
            Save
          </button>
        </form>
      </div>
    );
  }

  // Fan out every history query in parallel.
  const [
    tracked,
    serp, kwOverview, kwDifficulty, relatedKw, rankedKw, keywordData,
    backlinks, refDomains, anchors,
    competitors, domainIntersection, histRank,
    localFinder, grid, instantPages, reddit, reviews
  ] = await Promise.all([
    getTrackedKeywords(),
    getSerpHistory(), getKwOverviewHistory(), getKwDifficultyHistory(),
    getRelatedKwHistory(), getRankedKwHistory(), getKdHistory(),
    getBacklinksHistory(), getRefDomainsHistory(), getAnchorsHistory(),
    getCompetitorsHistory(), getDomainIntersectionHistory(), getHistRankHistory(),
    getLfHistory(), getGridHistory(), getInstantPageHistory(),
    getRedditHistory(), getReviewsTasks()
  ]);

  // Rank stats — getRankHistory returns DESC-sorted, so history[0] IS the latest.
  // Single query per tracked keyword instead of two.
  const rankData = await Promise.all(
    tracked.map(async (kw) => ({
      kw,
      history: await getRankHistory(kw.id, 30)
    }))
  );

  const inTop10 = rankData.filter(({ history }) => {
    const latest = history[0];
    return latest?.position !== null && latest?.position !== undefined && latest.position <= 10;
  }).length;

  // Top movers — compare latest position to oldest-in-7-days
  const movers = rankData
    .map(({ kw, history }) => {
      const latest = history[0];
      if (!latest || latest.position === null) return null;
      const sorted = [...history].sort((a, b) => a.date.localeCompare(b.date));
      const weekAgo = sorted.find((c) => (Date.now() - c.checkedAt) <= 7 * 24 * 60 * 60 * 1000);
      if (!weekAgo || weekAgo.position === null) return null;
      const delta = weekAgo.position - latest.position;
      if (delta === 0) return null;
      return { kw, current: latest.position, previous: weekAgo.position, delta };
    })
    .filter((m): m is NonNullable<typeof m> => m !== null)
    .sort((a, b) => Math.abs(b.delta) - Math.abs(a.delta))
    .slice(0, 5);

  // Unified activity feed
  const activity: ActivityRow[] = [];

  for (const e of serp) activity.push({
    tool: 'SERP', ts: e.ts,
    label: e.keyword, meta: `${e.location} · ${e.device} · ${e.count} results`,
    href: `/dashboard/serp?history_id=${e.id}`
  });
  for (const e of kwOverview) activity.push({
    tool: 'Keyword Overview', ts: e.ts,
    label: e.keywords, meta: `${e.location} · ${e.count} results`,
    href: `/dashboard/keyword-overview?history_id=${e.id}`
  });
  for (const e of kwDifficulty) activity.push({
    tool: 'Keyword Difficulty', ts: e.ts,
    label: e.keywords, meta: `${e.location} · ${e.count} results`,
    href: `/dashboard/keyword-difficulty?history_id=${e.id}`
  });
  for (const e of relatedKw) activity.push({
    tool: 'Related Keywords', ts: e.ts,
    label: e.keyword, meta: `${e.location} · depth ${e.depth} · ${e.count} results`,
    href: `/dashboard/related-keywords?history_id=${e.id}`
  });
  for (const e of rankedKw) activity.push({
    tool: 'Ranked Keywords', ts: e.ts,
    label: e.target, meta: `${e.location} · ${e.count}/${e.totalCount}`,
    href: `/dashboard/ranked-keywords?history_id=${e.id}`
  });
  for (const e of keywordData) activity.push({
    tool: 'Keyword Data', ts: e.ts,
    label: e.label, meta: `${e.se} · ${e.count} results`,
    href: `/dashboard/keyword-data?history_id=${e.id}`
  });
  for (const e of backlinks) activity.push({
    tool: 'Backlinks', ts: e.ts,
    label: e.target, meta: e.linksTotal ? `${e.linksTotal.toLocaleString()} links` : undefined,
    href: `/dashboard/backlinks?history_id=${e.id}`
  });
  for (const e of refDomains) activity.push({
    tool: 'Referring Domains', ts: e.ts,
    label: e.target, meta: e.total ? `${e.total.toLocaleString()} domains` : undefined,
    href: `/dashboard/backlinks/referring-domains?history_id=${e.id}`
  });
  for (const e of anchors) activity.push({
    tool: 'Anchors', ts: e.ts,
    label: e.target, meta: e.total ? `${e.total.toLocaleString()} anchors` : undefined,
    href: `/dashboard/backlinks/anchors?history_id=${e.id}`
  });
  for (const e of competitors) activity.push({
    tool: 'Competitors', ts: e.ts,
    label: e.target, meta: `${e.location} · ${e.count} results`,
    href: `/dashboard/competitors?history_id=${e.id}`
  });
  for (const e of domainIntersection) activity.push({
    tool: 'Domain Intersection', ts: e.ts,
    label: `${e.target1} ∩ ${e.target2}`, meta: `${e.count}/${e.totalCount}`,
    href: `/dashboard/domain-intersection?history_id=${e.id}`
  });
  for (const e of histRank) activity.push({
    tool: 'Historical Rank', ts: e.ts,
    label: e.target, meta: `${e.location}, ${e.language}`,
    href: `/dashboard/historical-rank?history_id=${e.id}`
  });
  for (const e of localFinder) activity.push({
    tool: 'Local Finder', ts: e.ts,
    label: e.keyword, meta: `${e.location} · ${e.count} results`,
    href: `/dashboard/local-finder?history_id=${e.id}`
  });
  for (const e of grid) activity.push({
    tool: 'Grid Search', ts: e.ts,
    label: `${e.keyword} · ${e.target}`, meta: `${e.grid_size}x${e.grid_size} grid`,
    href: `/dashboard/local-finder?grid_id=${e.id}`
  });
  for (const e of instantPages) activity.push({
    tool: 'Instant Pages', ts: e.ts,
    label: e.url,
    href: `/dashboard/on-page/instant-pages?id=${e.id}`
  });
  for (const e of reddit) activity.push({
    tool: 'Reddit', ts: e.ts,
    label: e.targets, meta: `${e.count} posts`,
    href: `/dashboard/social-media/reddit?history_id=${e.id}`
  });
  for (const e of reviews) activity.push({
    tool: 'Google Reviews', ts: e.ts,
    label: e.business, meta: `${e.location} · ${e.depth} reviews`,
    href: `/dashboard/google-reviews?id=${e.id}`
  });

  activity.sort((a, b) => b.ts - a.ts);
  const recent = activity.slice(0, 12);

  const toolIcons: Record<string, typeof Activity> = {
    'SERP': Globe,
    'Keyword Overview': BarChart2,
    'Keyword Difficulty': Gauge,
    'Related Keywords': Lightbulb,
    'Ranked Keywords': TrendingUp,
    'Keyword Data': Search,
    'Backlinks': Link2,
    'Referring Domains': Link2,
    'Anchors': Link2,
    'Competitors': Users,
    'Domain Intersection': GitMerge,
    'Historical Rank': Clock,
    'Local Finder': MapPin,
    'Grid Search': MapPin,
    'Instant Pages': FileSearch2,
    'Reddit': MessageSquare,
    'Google Reviews': Star
  };

  return (
    <div className="space-y-8 pb-12">
      {/* Header */}
      <div>
        <h1 className="text-3xl font-black text-slate-900 tracking-tight">Overview</h1>
        <p className="text-slate-500 text-sm mt-1 font-medium">Snapshot of rank tracker, recent queries, and account balance.</p>
      </div>

      {/* Stat cards */}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
        <div className="bg-white rounded-2xl border border-slate-200 p-5 shadow-sm">
          <p className="text-[10px] font-black text-slate-400 uppercase tracking-widest">DataForSEO</p>
          <div className="mt-2 flex items-baseline gap-2">
            <BalanceBadge />
          </div>
          <p className="text-[11px] text-slate-400 mt-2">Live account balance</p>
        </div>
        <Link href="/dashboard/rank-tracker" className="bg-white rounded-2xl border border-slate-200 p-5 shadow-sm hover:border-slate-300 transition-colors">
          <p className="text-[10px] font-black text-slate-400 uppercase tracking-widest">Tracked</p>
          <div className="mt-2 text-3xl font-black text-slate-900 tabular-nums">{tracked.length}</div>
          <p className="text-[11px] text-slate-400 mt-2">Keywords monitored</p>
        </Link>
        <Link href="/dashboard/rank-tracker" className="bg-white rounded-2xl border border-slate-200 p-5 shadow-sm hover:border-slate-300 transition-colors">
          <p className="text-[10px] font-black text-slate-400 uppercase tracking-widest">Top 10</p>
          <div className="mt-2 text-3xl font-black text-emerald-600 tabular-nums">{inTop10}</div>
          <p className="text-[11px] text-slate-400 mt-2">Ranking in top 10</p>
        </Link>
        <div className="bg-white rounded-2xl border border-slate-200 p-5 shadow-sm">
          <p className="text-[10px] font-black text-slate-400 uppercase tracking-widest">Activity</p>
          <div className="mt-2 text-3xl font-black text-slate-900 tabular-nums">{activity.length}</div>
          <p className="text-[11px] text-slate-400 mt-2">Saved searches across tools</p>
        </div>
      </div>

      {/* Two columns: movers + activity */}
      <div className="grid grid-cols-1 xl:grid-cols-5 gap-6">
        {/* Top movers */}
        <div className="xl:col-span-2 bg-white rounded-2xl border border-slate-200 shadow-sm overflow-hidden">
          <div className="px-5 py-4 border-b border-slate-100 flex items-center justify-between">
            <h2 className="text-xs font-black text-slate-400 uppercase tracking-widest">Top movers · last 7 days</h2>
            <Link href="/dashboard/rank-tracker" className="text-[10px] font-black uppercase tracking-widest text-blue-600 hover:text-blue-700">
              View all →
            </Link>
          </div>
          {movers.length === 0 ? (
            <div className="px-5 py-10 text-center">
              <p className="text-sm text-slate-400 font-medium">No movement yet.</p>
              <p className="text-xs text-slate-300 mt-1">Tracked keywords with position changes in the last 7 days will appear here.</p>
            </div>
          ) : (
            <table className="w-full text-sm">
              <tbody>
                {movers.map(({ kw, current, previous, delta }) => (
                  <tr key={kw.id} className="border-b border-slate-50 last:border-0">
                    <td className="px-5 py-3">
                      <div className="font-semibold text-slate-900 text-sm truncate">{kw.keyword}</div>
                      <div className="text-[11px] text-slate-400 truncate">{kw.domain} · {kw.location}</div>
                    </td>
                    <td className="px-3 py-3 text-right tabular-nums">
                      <span className="text-slate-400 text-xs">{previous}</span>
                      <span className="text-slate-300 mx-1">→</span>
                      <span className="font-black text-slate-900">{current}</span>
                    </td>
                    <td className="px-5 py-3 text-right">
                      <span className={`inline-flex items-center gap-1 text-[11px] font-black tabular-nums ${delta > 0 ? 'text-emerald-600' : 'text-red-500'}`}>
                        {delta > 0 ? <TrendingUp className="w-3 h-3" /> : <TrendingDown className="w-3 h-3" />}
                        {Math.abs(delta)}
                      </span>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>

        {/* Recent activity */}
        <div className="xl:col-span-3 bg-white rounded-2xl border border-slate-200 shadow-sm overflow-hidden">
          <div className="px-5 py-4 border-b border-slate-100 flex items-center justify-between">
            <h2 className="text-xs font-black text-slate-400 uppercase tracking-widest">Recent activity</h2>
            <span className="text-[10px] text-slate-300">Click a row to reopen the saved results</span>
          </div>
          {recent.length === 0 ? (
            <div className="px-5 py-10 text-center">
              <p className="text-sm text-slate-400 font-medium">No activity yet.</p>
              <p className="text-xs text-slate-300 mt-1">Queries you run across the tools will show up here.</p>
            </div>
          ) : (
            <ul>
              {recent.map((r, i) => {
                const Icon = toolIcons[r.tool] ?? Activity;
                return (
                  <li key={i} className="border-b border-slate-50 last:border-0">
                    <Link href={r.href} className="flex items-center gap-4 px-5 py-3 hover:bg-slate-50 transition-colors">
                      <div className="w-8 h-8 rounded-xl bg-slate-100 flex items-center justify-center text-slate-500 shrink-0">
                        <Icon className="w-4 h-4" />
                      </div>
                      <div className="flex-1 min-w-0">
                        <div className="flex items-baseline gap-2">
                          <span className="text-[10px] font-black text-slate-400 uppercase tracking-widest shrink-0">{r.tool}</span>
                          <span className="font-semibold text-slate-900 text-sm truncate">{r.label}</span>
                        </div>
                        {r.meta && <div className="text-[11px] text-slate-400 truncate mt-0.5">{r.meta}</div>}
                      </div>
                      <span className="text-[11px] font-medium text-slate-400 tabular-nums shrink-0">{timeAgo(r.ts)}</span>
                    </Link>
                  </li>
                );
              })}
            </ul>
          )}
        </div>
      </div>
    </div>
  );
}
