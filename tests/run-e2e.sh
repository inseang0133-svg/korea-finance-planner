#!/usr/bin/env bash
# Browser tests (Chromium via Playwright, Supabase mocked, CDNs blocked).
set -euo pipefail
cd "$(dirname "$0")/.."
for t in $(ls tests/e2e/phase*.test.js | sort -V); do echo "### $t"; node "$t" | grep -E "✗|passed"; done
