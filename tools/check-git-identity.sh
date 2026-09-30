#!/usr/bin/env bash
set -euo pipefail

# git var honors --author and GIT_* overrides passed to the commit process,
# as well as the repository/global settings. Check both stored identities.
for identity_kind in AUTHOR COMMITTER; do
	identity="$(git var "GIT_${identity_kind}_IDENT")"
	email="${identity#*<}"
	email="${email%%>*}"
	normalized_email="$(printf '%s' "$email" | tr '[:upper:]' '[:lower:]')"
	case "$normalized_email" in
	*.invalid | noreply@anthropic.com | *github-actions\[bot\]@users.noreply.github.com)
		printf 'Commit blocked: %s identity uses a placeholder or tool email: %s\n' "$identity_kind" "$email" >&2
		printf 'Use your own Git name/email, and remove any GIT_AUTHOR_* or GIT_COMMITTER_* override.\n' >&2
		printf 'Inspect settings with: git config --show-origin --get-regexp "^user\\.(name|email)$"\n' >&2
		exit 1
		;;
	esac
done
