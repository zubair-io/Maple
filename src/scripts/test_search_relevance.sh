#!/usr/bin/env bash
# Hybrid search relevance gate (#2384).
#
# Sibling of test_color_pipeline.sh: same skip-pass-without-fixtures shape,
# different subsystem. Measures ranking quality (Recall@10, MRR, and per-query
# rank guards) against the committed corpus in
# src/api/tests/fixtures/search-relevance/.
#
# Needs a real Meilisearch AND a real Ollama with bge-m3 pulled — there is no
# offline way to measure embedding relevance. Skip-passes (exit 0) when either
# is unset so CI without a sidecar doesn't fail spuriously.
#
# Usage:
#   MAPLE_MEILISEARCH_INTEGRATION_URL=http://localhost:7700 \
#   MAPLE_OLLAMA_INTEGRATION_URL=http://localhost:11434 \
#   src/scripts/test_search_relevance.sh
#
#   # sweep one blend ratio (default comes from budgets.json)
#   MAPLE_SEMANTIC_RATIO=0.8 src/scripts/test_search_relevance.sh
#
# The per-case JSON report goes to stderr; redirect it to capture a baseline:
#   src/scripts/test_search_relevance.sh 2>&1 | tee baseline.json
#
# One-time setup (writes to a throwaway `maple_relevance_probe` index,
# never the managed `assets` index):
#   # Native Meilisearch 1.50.0 and Ollama on the same machine:
#   meilisearch --http-addr 127.0.0.1:7700 --experimental-allowed-ip-networks 127.0.0.1/32
#   ollama pull bge-m3
# Use MAPLE_OLLAMA_INTEGRATION_URL=http://127.0.0.1:11434 with that exception.
# Container/remote address policy: docs/indexer-enrichment.md, Local embedding connectivity.

set -euo pipefail
cd "$(dirname "$0")/../api"

if [[ -z "${MAPLE_MEILISEARCH_INTEGRATION_URL:-}" || -z "${MAPLE_OLLAMA_INTEGRATION_URL:-}" ]]; then
  echo "MAPLE_MEILISEARCH_INTEGRATION_URL / MAPLE_OLLAMA_INTEGRATION_URL unset — skipping"
  exit 0
fi

MAPLE_SEARCH_RELEVANCE=1 bun test tests/search-relevance.integration.test.ts
