#!/bin/bash
# test_face_clustering.sh — quality-parity gate for face clustering.
#
# Mirrors src/scripts/test_color_pipeline.sh for the people / face-
# clustering subsystem. Drives the pure-function clustering core
# (`clusterEmbeddings` in src/api/src/people/clustering-job.ts) over a
# labelled fixture set and gates the result against committed per-metric
# floors in test-fixtures/face-clustering/budgets.json.
#
# Why a separate gate
#   `src/api/src/people/clustering-job.test.ts` exercises the DB-backed
#   path against hand-crafted orthogonal embeddings — useful for
#   correctness, useless for *quality*. This script reproduces the
#   color-pipeline contract: committed budgets, ratchet-only, perceptual
#   metrics (here: purity / NMI / V-measure / ARI / recall@1), skip-pass
#   when the fixture file isn't on disk.
#
# Skip-pass branches:
#   - test-fixtures/face-clustering/embeddings.jsonl missing → exit 0 with notice.
#   - test-fixtures/face-clustering/budgets.json missing    → exit 0 with notice.
#   - bun not installed                                      → exit 0 with notice
#     (matches the color-pipeline pattern of "no tools, no gate").
#
# Env overrides:
#   FIXTURES       default test-fixtures/face-clustering/embeddings.jsonl
#   BUDGETS        default test-fixtures/face-clustering/budgets.json
#   BUN            path to bun (default: `bun` from $PATH)
#
# Usage:
#   src/scripts/test_face_clustering.sh
#   FIXTURES=/tmp/my-fixtures.jsonl src/scripts/test_face_clustering.sh

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"

FIXTURES="${FIXTURES:-$REPO_ROOT/test-fixtures/face-clustering/embeddings.jsonl}"
BUDGETS="${BUDGETS:-$REPO_ROOT/test-fixtures/face-clustering/budgets.json}"
BUN="${BUN:-bun}"
HARNESS="$REPO_ROOT/src/api/src/people/clustering-quality-harness.ts"

err() { printf "test_face_clustering: %s\n" "$*" >&2; }

# ----- preflight -----------------------------------------------------------

if [[ ! -f "$FIXTURES" ]]; then
  echo "test_face_clustering: fixtures not found at $FIXTURES — skipping"
  echo "test_face_clustering: (regenerate via test-fixtures/face-clustering/scripts/generate.py)"
  exit 0
fi

if [[ ! -f "$BUDGETS" ]]; then
  echo "test_face_clustering: budgets file not found at $BUDGETS — skipping"
  echo "test_face_clustering: (seed via: bun $HARNESS --suggest-budgets)"
  exit 0
fi

if [[ ! -f "$HARNESS" ]]; then
  err "harness script missing at $HARNESS"
  exit 2
fi

if ! command -v "$BUN" >/dev/null 2>&1; then
  echo "test_face_clustering: bun not installed — skipping"
  echo "test_face_clustering: (install bun via https://bun.sh; CI provisions it via setup-bun)"
  exit 0
fi

# ----- run -----------------------------------------------------------------

echo "test_face_clustering: fixtures=$FIXTURES"
echo "test_face_clustering: budgets=$BUDGETS"
echo ""

# Harness writes a one-line JSON summary on stdout (CI grep target) and a
# pretty table on stderr (human read). We funnel both through so the CI
# log captures everything. Exit code propagates: 0 pass, 1 breach, 2
# input error.
"$BUN" "$HARNESS" --fixtures "$FIXTURES" --budgets "$BUDGETS"
