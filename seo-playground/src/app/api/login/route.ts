import { getCloudflareContext } from "@opennextjs/cloudflare";
import { NextRequest, NextResponse } from "next/server";

export async function POST(req: NextRequest) {
  const form = await req.formData();
  const password = String(form.get("password") ?? "");
  const next = String(form.get("next") ?? "/dashboard");

  const { env } = await getCloudflareContext({ async: true });
  const expected = env.DASHBOARD_PASSWORD;

  if (!expected || password !== expected) {
    const url = new URL("/login", req.url);
    url.searchParams.set("error", "1");
    url.searchParams.set("next", next);
    return NextResponse.redirect(url, 303);
  }

  // Only allow same-origin paths — prevents open-redirect via ?next=https://evil.com
  const safeNext = next.startsWith("/") ? next : "/dashboard";
  const res = NextResponse.redirect(new URL(safeNext, req.url), 303);
  res.cookies.set("playground_auth", expected, {
    httpOnly: true,
    secure: true,
    sameSite: "lax",
    path: "/",
    maxAge: 60 * 60 * 24 * 7
  });
  return res;
}
