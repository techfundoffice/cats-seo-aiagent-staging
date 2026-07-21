#!/usr/bin/env bash
# Post-publish hook: opens the article in the user's real Chrome
# via browser-harness CDP connection. Only runs when browser-harness
# is installed and Chrome has remote debugging enabled.
#
# Usage: ARTICLE_URL=https://catsluvus.com/... ./post-publish-browser-harness.sh

set -euo pipefail

ARTICLE_URL="${ARTICLE_URL:-}"
if [ -z "$ARTICLE_URL" ]; then
  echo "ARTICLE_URL not set — skipping browser-harness preview"
  exit 0
fi

if ! command -v browser-harness >/dev/null 2>&1; then
  echo "browser-harness not installed — run scripts/install-browser-harness.sh"
  exit 0
fi

browser-harness <<PY
new_tab("${ARTICLE_URL}")
wait_for_load()
info = page_info()
print(f"browser-harness: opened {info.get('url', 'unknown')} — title: {info.get('title', 'unknown')}")
PY
