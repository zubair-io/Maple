#!/usr/bin/env bash
# Self-test for tools/check-maple-ui-contracts.sh — creates fixtures in a
# temp directory and asserts the checker's pass/fail behavior against them.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
CHECKER="$SCRIPT_DIR/check-maple-ui-contracts.sh"

TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

fail=0

assert_pass() {
  local dir="$1" label="$2"
  if "$CHECKER" "$dir" > /dev/null 2>&1; then
    echo "PASS: $label"
  else
    echo "FAIL: expected pass for $label, checker exited non-zero" >&2
    fail=1
  fi
}

assert_fail_containing() {
  local dir="$1" label="$2" needle="$3"
  local output
  if output="$("$CHECKER" "$dir" 2>&1)"; then
    echo "FAIL: expected failure for $label, checker exited zero" >&2
    fail=1
    return
  fi
  if echo "$output" | grep -qF "$needle"; then
    echo "PASS: $label"
  else
    echo "FAIL: expected '$needle' in checker output for $label, got:" >&2
    echo "$output" >&2
    fail=1
  fi
}

# Case 1: a fully complete doc passes.
mkdir -p "$TMP/good"
cat > "$TMP/good/button.md" <<'EOF'
# Button

## Purpose
Primary interactive control for committing an action.

## Variants
Primary, secondary, ghost, destructive.

## States
Default, hover, pressed, focused, disabled.

## Tokens used
`radius_md`, `spacing_sm`, `color.primary`.

## Props
`variant`, `label`, `disabled`.

## Accessibility
Minimum 44x44pt touch target; label is the accessible name.
EOF
assert_pass "$TMP/good" "complete doc"

# Case 2: a doc missing a required section fails, and names it.
mkdir -p "$TMP/missing-section"
cat > "$TMP/missing-section/button.md" <<'EOF'
# Button

## Purpose
Primary interactive control.

## Variants
Primary, secondary.

## States
Default, hover.

## Tokens used
`radius_md`.

## Props
`variant`.
EOF
assert_fail_containing "$TMP/missing-section" "missing section" "missing section '## Accessibility'"

# Case 3: a doc with an empty required section fails, and names it.
mkdir -p "$TMP/empty-section"
cat > "$TMP/empty-section/button.md" <<'EOF'
# Button

## Purpose
Primary interactive control.

## Variants
Primary, secondary.

## States
Default, hover.

## Tokens used
`radius_md`.

## Props

## Accessibility
Minimum 44x44pt touch target.
EOF
assert_fail_containing "$TMP/empty-section" "empty section" "section '## Props' is empty"

# Case 4: an empty directory fails.
mkdir -p "$TMP/empty-dir"
assert_fail_containing "$TMP/empty-dir" "empty directory" "no .md contract docs found"

if [ "$fail" -ne 0 ]; then
  echo "SELF-TEST FAILED" >&2
  exit 1
fi

echo "SELF-TEST PASSED"
