import { cookies } from 'next/headers';
import { redirect } from 'next/navigation';
import { getCloudflareContext } from '@opennextjs/cloudflare';
import Sidebar from '@/components/Sidebar';
import BalanceBadge from '@/components/BalanceBadge';
import ThemeToggle from '@/components/ThemeToggle';

export const dynamic = 'force-dynamic';

function safeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

export default async function DashboardLayout({ children }: { children: React.ReactNode }) {
  // Auth gate — replaces middleware.ts. Runs only on /dashboard/*, so it stays
  // out of the cold-start path for /login, /api/*, and static assets.
  const { env } = await getCloudflareContext({ async: true });
  const expected = env.DASHBOARD_PASSWORD;
  const got = (await cookies()).get('playground_auth')?.value;
  if (!expected || !got || !safeEqual(got, expected)) {
    redirect('/login');
  }

  return (
    <div className="flex h-screen bg-slate-50 dark:bg-slate-950 text-slate-900 dark:text-slate-100 font-sans">
      <Sidebar />
      <div className="flex-1 flex flex-col min-w-0 overflow-hidden">
        <header className="h-16 border-b border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 flex items-center justify-between px-8 shrink-0">
          <span className="text-sm font-bold text-slate-900 dark:text-white">SEO Playground</span>
          <div className="flex items-center gap-3">
            <ThemeToggle />
            <BalanceBadge />
          </div>
        </header>

        <div className="flex-1 overflow-hidden">
          <main className="h-full overflow-y-auto p-8">
            <div className="max-w-6xl mx-auto">
              {children}
            </div>
          </main>
        </div>
      </div>
    </div>
  );
}
