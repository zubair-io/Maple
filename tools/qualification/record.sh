#!/usr/bin/env bash
# tools/qualification/record.sh — run one qualification suite and write (or
# check) its evidence record for the capability registry (#2430).
#
#   tools/qualification/record.sh [--check] <source> <backend> -- <command...>
#
# Runs <command...> in the foreground, tees its output, parses the suite's
# own summary line for executed / failed / skipped counts, and hands the
# numbers to `qualification-record` (src/raw-pipeline/codegen/src/qualification_record.rs),
# which stamps the record with the current pipeline + schema version, the
# source's declared expected count, and a blake3 hash of its declared
# corpus, then writes test-fixtures/qualification/<source>.json.
#
# With --check the record is NOT written: the run is compared against the
# committed record's load-bearing fields and the script exits 1 on any
# difference. CI runs every suite it can execute this way, so a suite that
# gained or lost a case, or a corpus that changed, cannot keep a stale
# record green — re-record locally (without --check) and commit the file.
#
# Recognised summary formats (the first match wins):
#   cargo test   "test result: ok. N passed; M failed; K ignored; ..."  (summed
#                over every test target the command ran)
#   bun test     " N pass" / " M fail" / " K skip"
#   swift test   "Executed N tests, with M failures"
#   colour       "qualification: executed=N failed=M skipped=K"  (printed by
#   harness      src/scripts/test_color_pipeline.sh's final summary)
#
# The suite's own exit code is NOT the gate here — a red suite still writes
# a record (with failed_cases > 0), which is exactly what demotes the
# capabilities that depend on it. The script exits non-zero only when the
# run cannot be parsed or, under --check, when the record drifted.

set -euo pipefail

check=""
if [[ "${1:-}" == "--check" ]]; then
  check="--check"
  shift
fi
if [[ $# -lt 4 || "$3" != "--" ]]; then
  echo "usage: $0 [--check] <source> <backend> -- <command...>" >&2
  exit 2
fi
source_id="$1"
backend="$2"
shift 3

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
OUT="$REPO_ROOT/test-fixtures/qualification/${source_id}.json"
LOG="$(mktemp "${TMPDIR:-/tmp}/qualification-${source_id}.XXXXXX")"
trap 'rm -f "$LOG"' EXIT

echo "qualification: running [$source_id] on [$backend]: $*"
suite_exit=0
"$@" 2>&1 | tee "$LOG" || suite_exit=${PIPESTATUS[0]}
echo "qualification: suite exited $suite_exit"

# ---- parse counts --------------------------------------------------------
executed=""
failed=""
skipped=""
if grep -qE '^qualification: executed=[0-9]+ failed=[0-9]+ skipped=[0-9]+' "$LOG"; then
  line="$(grep -E '^qualification: executed=' "$LOG" | tail -n 1)"
  executed="$(sed -E 's/.*executed=([0-9]+).*/\1/' <<<"$line")"
  failed="$(sed -E 's/.*failed=([0-9]+).*/\1/' <<<"$line")"
  skipped="$(sed -E 's/.*skipped=([0-9]+).*/\1/' <<<"$line")"
elif grep -qE '^test result: ' "$LOG"; then
  passed_sum=0
  failed_sum=0
  ignored_sum=0
  while IFS= read -r line; do
    p="$(sed -E 's/.* ([0-9]+) passed;.*/\1/' <<<"$line")"
    f="$(sed -E 's/.* ([0-9]+) failed;.*/\1/' <<<"$line")"
    i="$(sed -E 's/.* ([0-9]+) ignored;.*/\1/' <<<"$line")"
    passed_sum=$((passed_sum + p))
    failed_sum=$((failed_sum + f))
    ignored_sum=$((ignored_sum + i))
  done < <(grep -E '^test result: ' "$LOG")
  executed=$((passed_sum + failed_sum))
  failed=$failed_sum
  skipped=$ignored_sum
elif grep -qE '^ *[0-9]+ pass' "$LOG"; then
  pass="$(grep -E '^ *[0-9]+ pass' "$LOG" | tail -n 1 | sed -E 's/^ *([0-9]+) pass.*/\1/')"
  fail="$(grep -E '^ *[0-9]+ fail' "$LOG" | tail -n 1 | sed -E 's/^ *([0-9]+) fail.*/\1/' || true)"
  skip="$(grep -E '^ *[0-9]+ skip' "$LOG" | tail -n 1 | sed -E 's/^ *([0-9]+) skip.*/\1/' || true)"
  executed=$((pass + ${fail:-0}))
  failed=${fail:-0}
  skipped=${skip:-0}
elif grep -qE 'Executed [0-9]+ tests?, with [0-9]+ failures?' "$LOG"; then
  line="$(grep -E 'Executed [0-9]+ tests?, with [0-9]+ failures?' "$LOG" | tail -n 1)"
  executed="$(sed -E 's/.*Executed ([0-9]+) tests?, with ([0-9]+) failures?.*/\1/' <<<"$line")"
  failed="$(sed -E 's/.*Executed ([0-9]+) tests?, with ([0-9]+) failures?.*/\2/' <<<"$line")"
  skipped="$(grep -cE ' skipped( |$|:)' "$LOG" || true)"
  # XCTest counts a skipped test inside "Executed"; a skip is not evidence.
  executed=$((executed - skipped))
else
  echo "qualification: could not find a recognised summary line in the suite output" >&2
  exit 2
fi
echo "qualification: parsed executed=$executed failed=$failed skipped=$skipped"

# ---- stamp + write / check ------------------------------------------------
cargo build --quiet \
  --manifest-path "$REPO_ROOT/src/raw-pipeline/Cargo.toml" \
  -p codegen --bin qualification-record
BIN="$REPO_ROOT/src/raw-pipeline/target/debug/qualification-record"
if [[ -f "${BIN}.exe" ]]; then
  BIN="${BIN}.exe"
fi

git_sha="$(git -C "$REPO_ROOT" rev-parse HEAD 2>/dev/null || echo "")"
recorded_at="$(date -u +%Y-%m-%dT%H:%M:%SZ)"

"$BIN" \
  --source "$source_id" \
  --backend "$backend" \
  --executed "$executed" \
  --failed "$failed" \
  --skipped "$skipped" \
  --repo-root "$REPO_ROOT" \
  --out "$OUT" \
  --git-sha "$git_sha" \
  --recorded-at "$recorded_at" \
  --command "$*" \
  $check
