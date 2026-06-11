#!/usr/bin/env bash
# format.sh — local mirror of the CI format gate.
#
# CI (.github/workflows/cross.yml, "format-check" job) runs
#   prettier --check --config src/web/.prettierrc
# over the files a PR changes vs its merge base with main — repo-wide
# (src/api and docs included), filtered to prettier-eligible extensions,
# excluding vendored/generated trees. This script reproduces that list and
# command against the working tree, so the result predicts CI for the
# commit you are about to push.
#
#   bash scripts/format.sh            # --check (exactly what CI gates)
#   bash scripts/format.sh --write    # fix instead of check
#
# The file list is "what this branch changes vs ${BASE_REF:-origin/main}":
# tracked changes (committed + uncommitted) plus untracked files.
set -euo pipefail

mode="--check"
case "${1:-}" in
  "" | --check) ;;
  --write) mode="--write" ;;
  *)
    echo "usage: format.sh [--check|--write]" >&2
    exit 2
    ;;
esac

repo_root="$(git rev-parse --show-toplevel)"
cd "$repo_root"

prettier_bin="src/web/node_modules/.bin/prettier"
if [ ! -x "$prettier_bin" ]; then
  echo "ERROR: $prettier_bin not found — run 'bun install' in src/web first." >&2
  exit 1
fi

base_ref="${BASE_REF:-origin/main}"
if ! merge_base="$(git merge-base "$base_ref" HEAD 2>/dev/null)"; then
  echo "ERROR: cannot resolve merge base with '$base_ref' — run 'git fetch origin' first." >&2
  exit 1
fi

raw="$(mktemp "${TMPDIR:-/tmp}/maple-format-raw.XXXXXX")"
list="$(mktemp "${TMPDIR:-/tmp}/maple-format-list.XXXXXX")"
trap 'rm -f "$raw" "$list"' EXIT

# Changed tracked files (merge base -> working tree) + untracked files.
{
  git diff --name-only --diff-filter=ACMR "$merge_base"
  git ls-files --others --exclude-standard
} | sort -u > "$raw"

# Same extension filter and path excludes as cross.yml.
grep -E '\.(ts|tsx|js|jsx|json|html|scss|css|md|yml|yaml)$' "$raw" \
  | grep -v -E '^(test-fixtures/|node_modules/|.*/node_modules/|.*/dist/|src/raw-pipeline/vendor/)' \
  > "$list" || true

count="$(wc -l < "$list" | tr -d ' ')"
if [ "$count" = "0" ]; then
  echo "format.sh: no prettier-eligible files changed vs $base_ref — nothing to do."
  exit 0
fi

echo "format.sh: prettier $mode over $count file(s) changed vs $base_ref:"
cat "$list"
tr '\n' '\0' < "$list" | xargs -0 "$prettier_bin" "$mode" --config src/web/.prettierrc
