#!/usr/bin/env python3
"""
Reads Doppler secrets JSON from stdin, filters out Cloudflare env vars
and internal Doppler metadata keys, and writes the result to stdout
for piping into `wrangler secret bulk`.
"""
import sys
import json

# Keys managed as wrangler.jsonc `vars` (not secrets) or internal Doppler keys
SKIP = {
    "DOPPLER_CONFIG",
    "DOPPLER_ENVIRONMENT",
    "DOPPLER_PROJECT",
    "AMAZON_AFFILIATE_TAG",
    "DOMAIN",
    "CLOUDFLARE_ZONE_ID",
    "CLOUDFLARE_ACCOUNT_ID",
    # Staging: keep the coding-agent escalation loop dormant. Without this
    # worker secret, escalateToCodingAgent() logs "skipping issue" and no-ops,
    # so staging never opens claude-fix GitHub issues or assigns Copilot.
    # (Also disables article-HTML GitHub backup + authenticated skill fetches.)
    "GITHUB_TOKEN_SECRET",
}

secrets = json.load(sys.stdin)
out = {
    k: v
    for k, v in secrets.items()
    if k not in SKIP and not k.startswith("DOPPLER_")
}
print(json.dumps(out))
