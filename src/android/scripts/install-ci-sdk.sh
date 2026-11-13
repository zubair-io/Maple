#!/usr/bin/env bash
# Retry setup only: sdkmanager has failed with a truncated NDK ZipFile (#4648).
set -euo pipefail
: "${ANDROID_HOME:?ANDROID_HOME must identify the CI SDK}"
for attempt in 1 2 3; do
	if sdkmanager 'platforms;android-36' 'build-tools;36.0.0' 'ndk;28.2.13676358' 'cmake;3.22.1'; then
		exit 0
	fi
	if [ "$attempt" = 3 ]; then
		echo 'Android SDK installation failed after three attempts.' >&2
		exit 1
	fi
	# The CI job installs serially. Discard only incomplete download operations,
	# never installed packages or build/test failures.
	rm -rf "$ANDROID_HOME/.temp"
	echo "Retrying Android SDK installation after attempt $attempt" >&2
	sleep 5
done
