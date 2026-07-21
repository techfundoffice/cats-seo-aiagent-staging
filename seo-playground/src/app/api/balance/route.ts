import { cookies } from 'next/headers';
import { getCredentials } from '@/lib/db';
import { getCloudflareContext } from '@opennextjs/cloudflare';
import { NextResponse } from 'next/server';

interface DFUserResponse {
  tasks?: Array<{ result?: Array<{ money?: { balance?: number } }> }>;
}

let cachedBalance: string | null = null;
let cacheExpiry = 0;
const CACHE_TTL = 5 * 60 * 1000; // 5 minutes

function safeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

export async function GET() {
  // Auth guard (replaces middleware)
  const { env } = await getCloudflareContext({ async: true });
  const expected = env.DASHBOARD_PASSWORD;
  const got = (await cookies()).get('playground_auth')?.value;
  if (!expected || !got || !safeEqual(got, expected)) {
    return NextResponse.json({ balance: null }, { status: 401 });
  }

  const now = Date.now();
  if (cachedBalance !== null && now < cacheExpiry) {
    return NextResponse.json({ balance: cachedBalance });
  }

  const creds = await getCredentials();
  if (!creds) return NextResponse.json({ balance: null });

  try {
    const auth = btoa(`${creds.login}:${creds.pass}`);
    const res = await fetch('https://api.dataforseo.com/v3/appendix/user_data', {
      headers: { Authorization: `Basic ${auth}` },
    });
    if (res.ok) {
      const data = await res.json() as DFUserResponse;
      const balance = (data.tasks?.[0]?.result?.[0]?.money?.balance ?? 0).toFixed(2);
      cachedBalance = balance;
      cacheExpiry = now + CACHE_TTL;
      return NextResponse.json({ balance });
    }
  } catch {
    // fall through
  }

  return NextResponse.json({ balance: '0.00' });
}
