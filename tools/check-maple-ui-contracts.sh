#!/usr/bin/env bash
# Verifies every Maple UI component-contract doc has all required sections,
# each with real (non-empty) content. Run standalone or from CI.
#
# Usage: tools/check-maple-ui-contracts.sh [dir]
#   dir defaults to docs/design/maple-ui/components

set -euo pipefail

DIR="${1:-docs/design/maple-ui/components}"
REQUIRED_SECTIONS=("Purpose" "Variants" "States" "Tokens used" "Props" "Accessibility")

if [ ! -d "$DIR" ]; then
  echo "FAIL: directory not found: $DIR" >&2
  exit 1
fi

count=0
fail=0

while IFS= read -r file; do
  count=$((count + 1))

  if ! grep -q '^\*\*Tier:\*\*' "$file"; then
    echo "FAIL: $file: missing '**Tier:**' line" >&2
    fail=1
  fi

  for section in "${REQUIRED_SECTIONS[@]}"; do
    if ! grep -qF "## $section" "$file"; then
      echo "FAIL: $file: missing section '## $section'" >&2
      fail=1
      continue
    fi

    body="$(awk -v want="## $section" '
      $0 == want { found = 1; next }
      found && /^## / { exit }
      found { print }
    ' "$file")"

    trimmed="$(printf '%s' "$body" | tr -d '[:space:]')"
    if [ -z "$trimmed" ]; then
      echo "FAIL: $file: section '## $section' is empty" >&2
      fail=1
    fi
  done
done < <(find "$DIR" -maxdepth 1 -name '*.md' | sort)

if [ "$count" -eq 0 ]; then
  echo "FAIL: no .md contract docs found in $DIR" >&2
  exit 1
fi

if [ "$fail" -ne 0 ]; then
  exit 1
fi

echo "OK: $count contract(s) checked in $DIR"
