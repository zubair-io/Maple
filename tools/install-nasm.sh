#!/usr/bin/env bash
# Installs nasm, which the AV1 encoder's x86_64 assembly needs at build time (#6165).
# Runs on GitHub's Linux, macOS and Windows (Git Bash) runners; a runner that
# already has a new enough nasm is left alone.
set -euo pipefail

readonly MINIMUM_MAJOR=2
readonly MINIMUM_MINOR=15

nasm_is_new_enough() {
	local version
	version=$(nasm -v 2>/dev/null | sed -nE 's/^NASM version ([0-9]+)\.([0-9]+).*/\1 \2/p')
	[[ -n "$version" ]] || return 1
	read -r major minor <<<"$version"
	# Base 10: NASM 3.x minors such as 08 would otherwise be read as octal.
	((10#$major > MINIMUM_MAJOR || (10#$major == MINIMUM_MAJOR && 10#$minor >= MINIMUM_MINOR)))
}

install_with_apt() {
	# The runner's Azure HTTP mirror can stall beyond the whole job budget (#5206).
	for mirrors in /etc/apt/apt-mirrors.txt /etc/apt/apt-mirrors-security.txt; do
		if [[ -f "$mirrors" ]]; then
			sudo sed -i \
				-e 's|http://azure.archive.ubuntu.com/ubuntu|https://archive.ubuntu.com/ubuntu|g' \
				-e 's|http://archive.ubuntu.com/ubuntu|https://archive.ubuntu.com/ubuntu|g' \
				-e 's|http://security.ubuntu.com/ubuntu|https://security.ubuntu.com/ubuntu|g' \
				"$mirrors"
		fi
	done
	local -a apt_options=(-o Acquire::Retries=2 -o Acquire::http::Timeout=20 -o Acquire::https::Timeout=20)
	# apt resumes partial downloads, so a retry finishes what one 180 s window could not (#6029).
	for attempt in 1 2 3; do
		sudo timeout 180 apt-get "${apt_options[@]}" -o APT::Update::Error-Mode=any update &&
			sudo timeout 180 apt-get "${apt_options[@]}" install -y --download-only --no-install-recommends nasm &&
			break
		echo "nasm download attempt $attempt failed" >&2
	done
	sudo timeout 180 apt-get "${apt_options[@]}" install -y --no-install-recommends nasm
}

install_on_windows() {
	choco install nasm -y --no-progress
	local nasm_dir="/c/Program Files/NASM"
	export PATH="$nasm_dir:$PATH"
	if [[ -n "${GITHUB_PATH:-}" ]]; then
		cygpath -w "$nasm_dir" >>"$GITHUB_PATH"
	fi
}

if ! nasm_is_new_enough; then
	case "$(uname -s)" in
	Linux) install_with_apt ;;
	Darwin) brew install nasm ;;
	MINGW* | MSYS* | CYGWIN*) install_on_windows ;;
	*)
		echo "install-nasm.sh: no installer for $(uname -s); install nasm ${MINIMUM_MAJOR}.${MINIMUM_MINOR}+ by hand" >&2
		exit 1
		;;
	esac
fi

if ! nasm_is_new_enough; then
	echo "install-nasm.sh: nasm ${MINIMUM_MAJOR}.${MINIMUM_MINOR}+ is required; found: $(nasm -v 2>&1 || echo none)" >&2
	exit 1
fi
nasm -v
