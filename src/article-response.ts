/**
 * Build consistent headers for served article HTML.
 *
 * Articles can be rewritten in place after publish, so cache directives force
 * revalidation and avoid serving stale content for the same slug.
 */
export function createArticleResponseHeaders(): Headers {
  return new Headers({
    "Content-Type": "text/html; charset=UTF-8",
    // Articles can be rewritten in place by retry/editorial flows, so force
    // caches to revalidate instead of serving a long-lived stale HTML body for
    // the same slug after a KV update.
    "Cache-Control": "no-cache, must-revalidate",
    "X-Content-Type-Options": "nosniff"
  });
}
