#!/usr/bin/env bash
#
# tools/check-file-budget.sh — flag source files that exceed the file-size budget.
#
# Budgets (LOC, counted by `wc -l`):
#   * SOFT — 400 lines. Warn; non-blocking. Encourages splitting before pain.
#   * HARD — 600 lines. Error; blocks commit / CI unless the path is allowlisted
#                       in tools/budget-allowlist.txt.
#
# Why those numbers: ~400 lines is the largest file most editors render without
# overview-mode tricks; ~600 is the empirical point where reviewers stop reading
# a diff carefully (see CONTRIBUTING.md § "File-size budget"). The allowlist
# documents historical violators so day-0 CI doesn't fail — every entry has a
# corresponding split ticket on the KTLO project, and the allowlist is
# append-forbidden in CI (#114).
#
# Scope: *.rs *.swift *.ts *.tsx *.js *.py — source code only. Generated dirs
# (node_modules/, target/, dist/, .angular/, pkg/, DerivedData/, .build/) and
# generated wasm bindings under raw-wasm/pkg/ are skipped.
#
# Usage:
#   tools/check-file-budget.sh                 # scan the whole repo
#   tools/check-file-budget.sh path1 path2     # scan a subset (e.g. lefthook staged files)
#   tools/check-file-budget.sh --help          # print this help
#
# Exit codes:
#   0 — no hard violations outside the allowlist
#   1 — one or more hard violations not in the allowlist
#
# Soft violations print a `WARN` line but never affect the exit code.

set -euo pipefail

SOFT_LIMIT=400
HARD_LIMIT=600

usage() {
  sed -n '2,32p' "$0" | sed 's/^# \{0,1\}//'
  exit 0
}

case "${1:-}" in
  -h|--help) usage ;;
esac

# Resolve repo root so the script works from anywhere.
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
ALLOWLIST="$SCRIPT_DIR/budget-allowlist.txt"

# Load allowlist into an associative-ish lookup using a sentinel-delimited string.
# (Bash 3.2 on macOS doesn't support associative arrays consistently.)
ALLOW_BLOB=""
if [[ -f "$ALLOWLIST" ]]; then
  while IFS= read -r line || [[ -n "$line" ]]; do
    # strip comments + leading/trailing whitespace
    path="${line%%#*}"
    path="${path#"${path%%[![:space:]]*}"}"
    path="${path%"${path##*[![:space:]]}"}"
    [[ -z "$path" ]] && continue
    ALLOW_BLOB+="|$path|"
  done < "$ALLOWLIST"
fi

is_allowlisted() {
  case "$ALLOW_BLOB" in
    *"|$1|"*) return 0 ;;
    *)        return 1 ;;
  esac
}

# Build the file list. If args given, use them (after filtering); otherwise scan.
collect_files() {
  if [[ $# -gt 0 ]]; then
    for f in "$@"; do
      [[ -f "$f" ]] || continue
      case "$f" in
        *.rs|*.swift|*.ts|*.tsx|*.js|*.py) printf '%s\n' "$f" ;;
      esac
    done
  else
    find "$REPO_ROOT" -type f \
      \( -name '*.rs' -o -name '*.swift' -o -name '*.ts' \
         -o -name '*.tsx' -o -name '*.js' -o -name '*.py' \) \
      -not -path '*/node_modules/*' \
      -not -path '*/target/*' \
      -not -path '*/.git/*' \
      -not -path '*/dist/*' \
      -not -path '*/.angular/*' \
      -not -path '*/.build/*' \
      -not -path '*/DerivedData/*' \
      -not -path '*/raw-wasm/pkg/*' \
      -not -path '*/pkg/*' \
      -print
  fi
}

# Walk files, print findings, track exit status.
exit_code=0
soft_count=0
hard_count=0
allowed_count=0

while IFS= read -r file; do
  [[ -z "$file" ]] && continue
  # Normalise to repo-relative path.
  rel="${file#"$REPO_ROOT/"}"
  lines=$(wc -l < "$file" | tr -d ' ')
  if (( lines > HARD_LIMIT )); then
    if is_allowlisted "$rel"; then
      allowed_count=$((allowed_count + 1))
    else
      echo "ERROR $rel — $lines lines (hard limit: $HARD_LIMIT)" >&2
      hard_count=$((hard_count + 1))
      exit_code=1
    fi
  elif (( lines > SOFT_LIMIT )); then
    echo "WARN  $rel — $lines lines (soft limit: $SOFT_LIMIT)"
    soft_count=$((soft_count + 1))
  fi
done < <(collect_files "$@")

# Summary footer (stderr so it shows up even when consumers grep stdout).
{
  echo ""
  echo "file-budget: $hard_count hard violation(s), $soft_count soft warning(s), $allowed_count allowlisted"
  if (( exit_code != 0 )); then
    echo "             see tools/budget-allowlist.txt — every entry needs a split ticket on the KTLO project"
  fi
} >&2

exit "$exit_code"
