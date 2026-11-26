#!/usr/bin/env bash
# Maven Central throttles shared runners with 429 (#6029); Gradle keeps fetched files, so a retry asks only for the rest.
set -euo pipefail
for delay in 30 90 180 0; do
	if ./gradlew --no-daemon :app:resolveCiDependencies; then
		exit 0
	fi
	if [ "$delay" = 0 ]; then
		echo 'Gradle dependency resolution failed after four attempts.' >&2
		exit 1
	fi
	echo "Retrying Gradle dependency resolution in ${delay}s" >&2
	sleep "$delay"
done
