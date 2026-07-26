#!/usr/bin/env bash
#
# tools/check-budget-headroom.sh — fail a PR that GROWS a source file into the
# danger zone just below the 600-line hard ceiling (#2311).
#
# Why this exists, when check-file-budget.sh already gates at 600:
#
#   The hard gate fires on the PR that crosses 600. But splitting a file to
#   clear that gate naturally lands it *just* under — 598, 599 — because that
#   is the cheapest change that turns CI green. The result is a standing
#   population of files with one or two lines of headroom, where the NEXT
#   unrelated PR adding a couple of lines fails. The cost lands on whoever
#   shows up second, not on the change that consumed the headroom, and the two
#   never conflict textually so nothing warns either author.
#
#   On 2026-07-25 that is exactly what took `main` red: an export PR took
#   raw-pipeline.service.ts to 599, and the next PR's +19 broke the ceiling
#   (#2266). At the time this script was written, five files sat at 599 and
#   thirteen were within five lines of the limit.
#
# The contract, per source file changed vs the base branch:
#
#   * head > WARN_AT and head > base  -> FAIL. This PR pushed the file into
#     the danger zone (or deeper into it). Split it now, with margin.
#   * head > WARN_AT and head <= base -> pass. The file is already large but
#     this PR did not make it worse; shrinking is always allowed.
#   * head <= WARN_AT                 -> pass.
#
# That is a ratchet, matching tools/check_budget_ratchet.py (parity budgets)
# and the allowlist-shrinks-only job: pre-existing debt does not block, but it
# may not grow. Crucially it charges the PR that consumes the headroom rather
# than the one that runs out of it.
#
# Paths in tools/budget-allowlist.txt are skipped — they are explicitly exempt
# from the hard ceiling, so a headroom warning on them is noise.
#
# Usage:
#   tools/check-budget-headroom.sh [BASE_REF]   # default: origin/main
#   tools/check-budget-headroom.sh --self-test  # built-in tests, no repo needed
#   tools/check-budget-headroom.sh --help
#
# Exit codes:
#   0 — no changed file was grown past the threshold
#   1 — one or more were

set -euo pipefail

WARN_AT=570
HARD_LIMIT=600

usage() {
  awk 'NR==1 {next} /^#/ {sub(/^# ?/, ""); print; next} {exit}' "$0"
  exit 0
}

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# Overridable so the self-test can point at a throwaway allowlist. An
# unconditional assignment here silently ignored the override and made the
# self-test read the real repo allowlist instead.
ALLOWLIST="${ALLOWLIST:-$SCRIPT_DIR/budget-allowlist.txt}"

# Mirrors check-file-budget.sh: strip inline `#` comments and surrounding space,
# skip blanks and full-line comments.
is_allowlisted() {
  local candidate="$1" line
  [[ -f "$ALLOWLIST" ]] || return 1
  while IFS= read -r line || [[ -n "$line" ]]; do
    line="${line%%#*}"
    line="$(printf '%s' "$line" | sed -e 's/^[[:space:]]*//' -e 's/[[:space:]]*$//')"
    [[ -z "$line" ]] && continue
    [[ "$line" == "$candidate" ]] && return 0
  done <"$ALLOWLIST"
  return 1
}

is_source_path() {
  # Paths are repo-relative, so a top-level `node_modules/x.ts` has no leading
  # segment for `*/node_modules/*` to match — each pattern needs a bare form too.
  case "$1" in
    node_modules/* | target/* | vendor/* | dist/* | .angular/* | \
      .build/* | DerivedData/* | pkg/*) return 1 ;;
    */node_modules/* | */target/* | */vendor/* | */dist/* | */.angular/* | \
      */.build/* | */DerivedData/* | */pkg/*) return 1 ;;
  esac
  case "$1" in
    *.rs | *.swift | *.ts | *.tsx | *.js | *.py) return 0 ;;
    *) return 1 ;;
  esac
}

# LOC of $1 at revision $2, or 0 when the file does not exist there (a new file
# has no base to ratchet against, so it is measured against 0 and any file
# introduced above the threshold fails).
#
# Existence is probed with `cat-file -e` FIRST rather than letting `git show`
# fail inside the pipeline: under `set -o pipefail` a failing `git show` makes
# the whole pipeline non-zero, which `set -e` turns into a silent early exit —
# i.e. every new file would abort the check instead of being reported.
lines_at_rev() {
  local path="$1" rev="$2"
  if git cat-file -e "$rev:$path" 2>/dev/null; then
    git show "$rev:$path" | wc -l | tr -d ' '
  else
    echo 0
  fi
}

run_check() {
  local base="$1" merge_base violations=0
  local status path base_path head_lines base_lines

  # Compare against the merge base, not the branch tip, so commits that landed
  # on the base after this branch forked are not attributed to this PR.
  if ! merge_base="$(git merge-base "$base" HEAD 2>/dev/null)"; then
    echo "budget-headroom: cannot resolve merge base against '$base' — skipping" >&2
    return 0
  fi

  # `-z --name-status`, not `--name-only`, for two reasons:
  #
  #   * Renames. `--name-only` prints only the NEW path, which does not exist at
  #     the merge base, so `git mv` on a large file measured it against 0 and
  #     failed the PR — blocking exactly the move-and-split refactors this gate
  #     exists to encourage. `--name-status` carries the old path, so a rename is
  #     compared against the file it came from. A copy (C) has no single origin
  #     and is genuinely a new large file, so it stays measured against 0.
  #   * Quoting. Without `-z`, git C-quotes any path with non-ASCII bytes
  #     (`"caf\303\251.ts"`), `read -r` keeps the literal quotes, `[[ -f ]]`
  #     fails, and the file is skipped — a SILENT bypass of the whole gate.
  #
  # -z record shape: `STATUS\0path\0` and, for R/C, `STATUS\0old\0new\0`.
  while IFS= read -r -d '' status; do
    IFS= read -r -d '' path || break
    case "$status" in
      R*)
        base_path="$path"
        IFS= read -r -d '' path || break
        ;;
      C*)
        # Copy: the source still exists, so the new path really is new content.
        IFS= read -r -d '' path || break
        base_path=''
        ;;
      *) base_path="$path" ;;
    esac

    [[ -z "$path" ]] && continue
    is_source_path "$path" || continue
    # NOT `is_allowlisted ... && continue`: that compound evaluates to 1 for the
    # common (not-allowlisted) case, which `set -e` treats as a fatal error and
    # exits on, silently passing the whole check.
    if is_allowlisted "$path"; then continue; fi
    [[ -f "$path" ]] || continue # deleted in HEAD

    head_lines="$(wc -l <"$path" | tr -d ' ')"
    (( head_lines > WARN_AT )) || continue

    if [[ -n "$base_path" ]]; then
      base_lines="$(lines_at_rev "$base_path" "$merge_base")"
    else
      base_lines=0
    fi
    (( head_lines > base_lines )) || continue

    printf 'ERROR %s — %s lines (was %s; headroom threshold: %s, hard limit: %s)\n' \
      "$path" "$head_lines" "$base_lines" "$WARN_AT" "$HARD_LIMIT" >&2
    violations=$((violations + 1))
  done < <(git -c core.quotePath=false diff -z --name-status --diff-filter=ACMR "$merge_base"...HEAD)

  {
    echo ""
    if (( violations > 0 )); then
      echo "budget-headroom: $violations file(s) grown past $WARN_AT lines"
      echo "             Splitting to 598 just moves the failure to the next PR — split with real margin."
      echo "             See #2311."
    else
      echo "budget-headroom: no changed file grown past $WARN_AT lines"
    fi
  } >&2

  (( violations == 0 ))
}

# ── Self-test ────────────────────────────────────────────────────────────────
# Builds a throwaway git repo and exercises the four contract cases above.
self_test() {
  local tmp failures=0
  tmp="$(mktemp -d)"
  trap 'rm -rf "$tmp"' RETURN

  git -C "$tmp" init -q
  git -C "$tmp" config user.email t@t.t
  git -C "$tmp" config user.name t

  # Base: one already-large file, one small file, and a large file that HEAD
  # will merely rename.
  seq 1 580 | sed 's/^/\/\/ /' >"$tmp/big.ts"
  seq 1 100 | sed 's/^/\/\/ /' >"$tmp/small.ts"
  seq 1 580 | sed 's/^/\/\/ /' >"$tmp/moved-from.ts"
  git -C "$tmp" add -A
  git -C "$tmp" commit -qm base
  git -C "$tmp" branch -q base-ref

  # Head: grow the small file past the threshold (must FAIL), shrink the big
  # one (must pass), add an untouched-by-us large file (must FAIL), rename a
  # large file with no content change (must PASS — regression guard for the
  # `--name-only` bug that measured the new path against 0), and add a large
  # file whose name is non-ASCII (must FAIL — regression guard for the C-quoting
  # bypass, where the quoted path failed `[[ -f ]]` and was skipped silently).
  seq 1 575 | sed 's/^/\/\/ /' >"$tmp/small.ts"
  seq 1 575 | sed 's/^/\/\/ /' >"$tmp/big.ts"
  seq 1 590 | sed 's/^/\/\/ /' >"$tmp/brand-new.ts"
  seq 1 590 | sed 's/^/\/\/ /' >"$tmp/café.ts"
  git -C "$tmp" mv moved-from.ts moved-to.ts
  git -C "$tmp" add -A
  git -C "$tmp" commit -qm head

  # Empty allowlist, so the fixture is judged on its own terms rather than
  # against whatever the real repo happens to exempt.
  : >"$tmp/empty-allowlist.txt"
  local out
  out="$(cd "$tmp" && ALLOWLIST="$tmp/empty-allowlist.txt" \
    bash "$SCRIPT_DIR/check-budget-headroom.sh" base-ref 2>&1)" || true

  assert_contains() {
    if ! grep -q "$1" <<<"$out"; then
      echo "FAIL: expected output to contain '$1'" >&2
      failures=$((failures + 1))
    fi
  }
  assert_absent() {
    if grep -q "$1" <<<"$out"; then
      echo "FAIL: expected output NOT to contain '$1'" >&2
      failures=$((failures + 1))
    fi
  }

  assert_contains 'ERROR small.ts'     # grown 100 -> 575, past threshold
  assert_contains 'ERROR brand-new.ts' # new file introduced above threshold
  assert_contains 'ERROR café.ts'      # non-ASCII path must not be skipped
  assert_absent 'ERROR big.ts'         # 580 -> 575, shrank: allowed
  assert_absent 'ERROR moved-to.ts'    # pure rename, no content change: allowed

  # The allowlist override must actually take effect — if the script ignores it
  # the fixture is silently judged against the real repo's allowlist.
  local allowlisted_out
  printf 'small.ts\n' >"$tmp/one-entry-allowlist.txt"
  allowlisted_out="$(cd "$tmp" && ALLOWLIST="$tmp/one-entry-allowlist.txt" \
    bash "$SCRIPT_DIR/check-budget-headroom.sh" base-ref 2>&1)" || true
  if grep -q 'ERROR small.ts' <<<"$allowlisted_out"; then
    echo "FAIL: ALLOWLIST override ignored — small.ts should have been exempt" >&2
    failures=$((failures + 1))
  fi

  if (( failures == 0 )); then
    echo "check-budget-headroom self-test: PASS"
    return 0
  fi
  echo "check-budget-headroom self-test: $failures failure(s)" >&2
  echo "--- captured output ---" >&2
  echo "$out" >&2
  return 1
}

case "${1:-}" in
  -h | --help) usage ;;
  --self-test) self_test; exit $? ;;
esac

run_check "${1:-origin/main}"
