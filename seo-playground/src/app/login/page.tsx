export const dynamic = "force-dynamic";

export default async function LoginPage({
  searchParams
}: {
  searchParams: Promise<{ next?: string; error?: string }>;
}) {
  const { next = "/dashboard", error } = await searchParams;
  return (
    <div className="min-h-screen flex items-center justify-center bg-slate-50">
      <form
        action="/api/login"
        method="POST"
        className="w-80 bg-white p-8 rounded-2xl shadow-sm border border-slate-200 space-y-4"
      >
        <h1 className="text-xl font-black text-slate-900 tracking-tight">
          SEO Playground
        </h1>
        <p className="text-xs text-slate-500">
          Enter the shared dashboard password to continue.
        </p>
        <input type="hidden" name="next" value={next} />
        <input
          type="password"
          name="password"
          placeholder="Password"
          required
          autoFocus
          className="w-full px-4 py-3 border border-slate-200 rounded-xl text-sm outline-none focus:ring-2 focus:ring-blue-500 focus:border-blue-500 transition-all"
        />
        {error && (
          <p className="text-sm text-red-600 font-medium">
            Incorrect password.
          </p>
        )}
        <button
          type="submit"
          className="w-full bg-blue-600 text-white font-black uppercase text-xs tracking-widest py-3.5 rounded-xl hover:bg-blue-700 transition-colors"
        >
          Sign in
        </button>
      </form>
    </div>
  );
}
