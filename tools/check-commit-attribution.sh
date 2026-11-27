#!/usr/bin/env bash
# Usage: check-commit-attribution.sh <rev-range>
#        check-commit-attribution.sh --message-file <path>
set -euo pipefail

readonly TOOL_EMAIL='noreply@anthropic.com'
readonly TRAILER_PATTERN='^(co-authored-by:.*(claude|anthropic)|claude-session:)'

offending_trailers() {
	grep -Ei "$TRAILER_PATTERN" || true
}

check_message_file() {
	local trailers
	trailers="$(offending_trailers <"$1")"
	[ -z "$trailers" ] && return 0
	printf 'Commit blocked: remove AI attribution trailers from the message:\n%s\n' "$trailers" >&2
	return 1
}

check_range() {
	local failures=0 sha identity trailers
	for sha in $(git rev-list "$1"); do
		identity="$(git show -s --format='%an <%ae>%n%cn <%ce>' "$sha")"
		trailers="$(git show -s --format='%B' "$sha" | offending_trailers)"
		if printf '%s\n' "$identity" | grep -Eqi "^claude <|<${TOOL_EMAIL}>"; then
			printf '%s: authored or committed as the tool identity:\n%s\n' "$sha" "$identity" >&2
			failures=$((failures + 1))
		fi
		if [ -n "$trailers" ]; then
			printf '%s: carries AI attribution trailers:\n%s\n' "$sha" "$trailers" >&2
			failures=$((failures + 1))
		fi
	done
	[ "$failures" -eq 0 ] && return 0
	printf 'Re-author these commits under your own identity without Co-Authored-By/Claude-Session trailers (CONTRIBUTING.md).\n' >&2
	return 1
}

case "${1:-}" in
--message-file) check_message_file "${2:?message file required}" ;;
'') printf 'usage: %s <rev-range> | --message-file <path>\n' "$0" >&2 && exit 2 ;;
*) check_range "$1" ;;
esac
