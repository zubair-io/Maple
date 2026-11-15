#!/usr/bin/env bash
mkdir -p "$(dirname "$1")" 2>/dev/null || exit 0
{
	date -u +'%Y-%m-%dT%H:%M:%SZ'
	uptime
	nproc
	for resource in cpu memory io; do
		printf '\n/proc/pressure/%s\n' "$resource"
		cat "/proc/pressure/$resource"
	done
} >"$1" 2>&1 || true
