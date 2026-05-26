#!/usr/bin/env bash
#
# tools/test-check-file-budget.sh — regression test for check-file-budget.sh.
#
# Asserts that invoking the budget script from a path whose ancestor segments
# contain `.claude` (the standard `.claude/worktrees/agent-X/` layout used by
# Claude Code agents) reports the same file count as invoking it from a path
# that does not. The original bug (#491) was that the `find` exclusion
# `-path '*/.claude/*'` pruned EVERY file when REPO_ROOT itself contained
# `/.claude/`, causing the script to silently return 0 violations.
#
# Strategy: build a tiny self-contained git repo in a tmp dir, copy in the
# budget script, drop in some sample source files (one above the hard limit,
# one above the soft limit, a few small ones). Run the script (a) at the
# normal location and (b) at a path whose ancestor contains `.claude`.
# Verify both runs produce identical hard/soft counts.
#
# Not wired into CI — this is a one-off regression guard that documents the
# bug. Run manually after touching check-file-budget.sh:
#
#   bash tools/test-check-file-budget.sh

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
BUDGET_SCRIPT="$SCRIPT_DIR/check-file-budget.sh"

if [[ ! -x "$BUDGET_SCRIPT" ]]; then
  echo "FAIL: $BUDGET_SCRIPT is not executable" >&2
  exit 1
fi

# Two scratch repos: one at a "clean" path, one whose root sits under a
# `.claude/worktrees/` segment to mimic the agent worktree layout.
TMPROOT="$(mktemp -d -t budget-regress.XXXXXX)"
trap 'rm -rf "$TMPROOT"' EXIT

build_fixture_repo() {
  local repo="$1"
  mkdir -p "$repo/src" "$repo/tools"
  cp "$BUDGET_SCRIPT" "$repo/tools/check-file-budget.sh"
  chmod +x "$repo/tools/check-file-budget.sh"
  : > "$repo/tools/budget-allowlist.txt"

  # Hard violation (601 lines).
  awk 'BEGIN { for (i=0; i<601; i++) print "// hard" }' > "$repo/src/hard.rs"
  # Soft warning (401 lines).
  awk 'BEGIN { for (i=0; i<401; i++) print "// soft" }' > "$repo/src/soft.ts"
  # Two small files (well under limits).
  printf '// ok\n' > "$repo/src/ok1.swift"
  printf '// ok\n' > "$repo/src/ok2.py"

  ( cd "$repo" \
      && git init -q \
      && git config user.email t@t \
      && git config user.name t \
      && git add . \
      && git commit -q -m init )
}

CLEAN_REPO="$TMPROOT/clean"
WORKTREE_REPO="$TMPROOT/.claude/worktrees/agent-test"
mkdir -p "$WORKTREE_REPO"
build_fixture_repo "$CLEAN_REPO"
build_fixture_repo "$WORKTREE_REPO"

run_budget() {
  # Run the budget script; capture stdout+stderr; allow non-zero exits (hard
  # violations are expected). Return the summary line only.
  local repo="$1"
  ( cd "$repo" && ./tools/check-file-budget.sh 2>&1 ) || true
}

CLEAN_OUT="$(run_budget "$CLEAN_REPO" | grep -E '^file-budget:')"
WORKTREE_OUT="$(run_budget "$WORKTREE_REPO" | grep -E '^file-budget:')"

echo "clean    : $CLEAN_OUT"
echo "worktree : $WORKTREE_OUT"

if [[ "$CLEAN_OUT" != "$WORKTREE_OUT" ]]; then
  echo "FAIL: clean and worktree runs disagree" >&2
  echo "  clean    = $CLEAN_OUT" >&2
  echo "  worktree = $WORKTREE_OUT" >&2
  exit 1
fi

# Sanity: we expect the fixture to surface exactly 1 hard + 1 soft.
if ! grep -qE '1 hard violation\(s\), 1 soft warning\(s\)' <<<"$CLEAN_OUT"; then
  echo "FAIL: fixture didn't trip the expected violation counts" >&2
  echo "  got: $CLEAN_OUT" >&2
  exit 1
fi

echo "PASS: check-file-budget.sh is path-agnostic w.r.t. ancestor .claude/ segments"
