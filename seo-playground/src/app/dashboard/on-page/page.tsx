// src/app/dashboard/on-page/page.tsx
import Link from 'next/link';

const tools = [
  {
    name: 'Microdata',
    description: 'Parse and validate JSON-LD and Microdata (schema.org) structured data.',
    href: '/dashboard/on-page/microdata',
    badge: 'Available',
    badgeCls: 'text-emerald-600 bg-emerald-50 border-emerald-100',
  },
  {
    name: 'Instant Pages',
    description: 'Full on-page audit of a URL: metadata, performance, SEO checks, content metrics.',
    href: '/dashboard/on-page/instant-pages',
    badge: 'Available',
    badgeCls: 'text-emerald-600 bg-emerald-50 border-emerald-100',
  },
];

export default function OnPageHub() {
  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-black text-slate-900 tracking-tight">On Page</h1>
        <p className="text-sm text-slate-400 mt-1">
          On-page analysis tools via the DataForSEO OnPage API.
        </p>
      </div>

      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
        {tools.map((tool) => (
          <Link
            key={tool.name}
            href={tool.href}
            className="group bg-white rounded-2xl border border-slate-200 p-6 shadow-sm hover:shadow-md hover:border-slate-300 transition-all"
          >
            <div className="flex items-start justify-between mb-3">
              <h2 className="text-sm font-black text-slate-900 group-hover:text-blue-600 transition-colors">
                {tool.name}
              </h2>
              <span className={`text-[10px] font-black uppercase tracking-widest px-2 py-0.5 rounded-md border ${tool.badgeCls}`}>
                {tool.badge}
              </span>
            </div>
            <p className="text-xs text-slate-500 leading-relaxed">{tool.description}</p>
          </Link>
        ))}
      </div>
    </div>
  );
}
