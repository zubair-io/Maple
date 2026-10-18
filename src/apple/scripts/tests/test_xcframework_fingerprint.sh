#!/usr/bin/env bash
# Exercise the hash code from the production wrapper in two independent roots.
set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../../.." && pwd)"
wrapper="$repo_root/src/apple/scripts/build-xcframework.sh"
scratch="$(mktemp -d)"
trap 'rm -rf "$scratch"' EXIT

make_root() {
	local root="$1" path
	mkdir -p "$root/src/apple/scripts" "$root/src/raw-pipeline"
	for path in raw-core raw-ffi maple-pano raw-gpu; do
		mkdir -p "$root/src/raw-pipeline/$path/src"
		printf 'crate = "%s"\n' "$path" >"$root/src/raw-pipeline/$path/Cargo.toml"
		printf 'pub fn %s() {}\n' "${path//-/_}" >"$root/src/raw-pipeline/$path/src/lib.rs"
	done
	printf '[workspace]\n' >"$root/src/raw-pipeline/Cargo.toml"
	printf 'lock\n' >"$root/src/raw-pipeline/Cargo.lock"
	printf 'language = "C"\n' >"$root/src/raw-pipeline/raw-ffi/cbindgen.toml"
	printf 'shader\n' >"$root/src/raw-pipeline/raw-gpu/src/render.wgsl"
	printf 'binary\0bytes\n' >"$root/src/raw-pipeline/raw-core/src/profile.bin"
	printf 'fetch\n' >"$root/src/apple/scripts/fetch-ort-ios.sh"
	# Keep the production setup and hash function; stop before --check-only or
	# the build path can read a stamp, install tools, or create an artifact.
	sed -n '1,/^INPUT_HASH="$(compute_input_hash)"/p' "$wrapper" \
		>"$root/src/apple/scripts/build-xcframework.sh"
	printf '%s\n' 'printf "%s\n" "$INPUT_HASH"' \
		>>"$root/src/apple/scripts/build-xcframework.sh"
}

fingerprint() {
	bash "$1/src/apple/scripts/build-xcframework.sh" | tail -n 1
}

fingerprint_script() {
	bash "$1" | tail -n 1
}

expect_changed() {
	local label="$1" actual
	actual="$(fingerprint "$second")"
	if [[ "$actual" == "$baseline" ]]; then
		echo "FAIL: $label did not change the xcframework fingerprint" >&2
		exit 1
	fi
}

first="$scratch/first"
second="$scratch/second"
make_root "$first"
make_root "$second"
baseline="$(fingerprint "$first")"
if [[ "$baseline" != "$(fingerprint "$second")" ]]; then
	echo 'FAIL: identical inputs in different roots produced different fingerprints' >&2
	exit 1
fi
ln -s "$first" "$scratch/alias"
if [[ "$baseline" != "$(fingerprint "$scratch/alias")" ]]; then
	echo 'FAIL: a symlink alias changed the xcframework fingerprint' >&2
	exit 1
fi

for depth in 1 2 3 4; do
	layout="$scratch/layout-$depth"
	native="$layout/a/b/c/apple"
	case "$depth" in
	1) raw="$layout/a/b/c/raw-pipeline" ;;
	2) raw="$layout/a/b/raw-pipeline" ;;
	3) raw="$layout/a/raw-pipeline" ;;
	4) raw="$layout/raw-pipeline" ;;
	esac
	mkdir -p "$native/scripts" "$(dirname "$raw")"
	cp -R "$first/src/raw-pipeline" "$raw"
	cp "$first/src/apple/scripts/build-xcframework.sh" "$native/scripts/"
	cp "$first/src/apple/scripts/fetch-ort-ios.sh" "$native/scripts/"
	probe="$native/scripts/build-xcframework.sh"
	if [[ "$baseline" != "$(fingerprint_script "$probe")" ]]; then
		echo "FAIL: resolver layout $depth changed or could not compute the fingerprint" >&2
		exit 1
	fi
	printf 'updated\n' >>"$native/scripts/fetch-ort-ios.sh"
	if [[ "$baseline" == "$(fingerprint_script "$probe")" ]]; then
		echo "FAIL: resolver layout $depth ignored fetch script content" >&2
		exit 1
	fi
	rm "$native/scripts/fetch-ort-ios.sh"
	if fingerprint_script "$probe" >/dev/null 2>&1; then
		echo "FAIL: resolver layout $depth accepted a missing fetch script" >&2
		exit 1
	fi
done

printf 'changed\n' >>"$second/src/raw-pipeline/raw-core/src/lib.rs"
expect_changed 'Rust source content'
cp "$first/src/raw-pipeline/raw-core/src/lib.rs" "$second/src/raw-pipeline/raw-core/src/lib.rs"

printf 'changed\n' >>"$second/src/raw-pipeline/raw-gpu/src/render.wgsl"
expect_changed 'shader content'
cp "$first/src/raw-pipeline/raw-gpu/src/render.wgsl" \
	"$second/src/raw-pipeline/raw-gpu/src/render.wgsl"

mv "$second/src/raw-pipeline/raw-gpu/src/render.wgsl" \
	"$second/src/raw-pipeline/raw-gpu/src/renamed.wgsl"
expect_changed 'shader relative path'
mv "$second/src/raw-pipeline/raw-gpu/src/renamed.wgsl" \
	"$second/src/raw-pipeline/raw-gpu/src/render.wgsl"

printf 'new\n' >"$second/src/raw-pipeline/maple-pano/src/new.rs"
expect_changed 'added source'
rm "$second/src/raw-pipeline/maple-pano/src/new.rs"

rm "$second/src/raw-pipeline/raw-core/src/profile.bin"
expect_changed 'deleted embedded binary'
cp "$first/src/raw-pipeline/raw-core/src/profile.bin" \
	"$second/src/raw-pipeline/raw-core/src/profile.bin"

printf 'changed\n' >>"$second/src/raw-pipeline/raw-core/src/profile.bin"
expect_changed 'embedded binary content'
cp "$first/src/raw-pipeline/raw-core/src/profile.bin" \
	"$second/src/raw-pipeline/raw-core/src/profile.bin"

printf 'changed\n' >>"$second/src/raw-pipeline/raw-ffi/Cargo.toml"
expect_changed 'Cargo manifest content'
cp "$first/src/raw-pipeline/raw-ffi/Cargo.toml" \
	"$second/src/raw-pipeline/raw-ffi/Cargo.toml"

printf 'updated\n' >>"$second/src/apple/scripts/fetch-ort-ios.sh"
expect_changed 'native fetch input'
cp "$first/src/apple/scripts/fetch-ort-ios.sh" \
	"$second/src/apple/scripts/fetch-ort-ios.sh"

printf 'updated\n' >>"$second/src/raw-pipeline/raw-ffi/cbindgen.toml"
expect_changed 'cbindgen input'
cp "$first/src/raw-pipeline/raw-ffi/cbindgen.toml" \
	"$second/src/raw-pipeline/raw-ffi/cbindgen.toml"

rm "$second/src/raw-pipeline/Cargo.lock"
if fingerprint "$second" >/dev/null 2>&1; then
	echo 'FAIL: missing listed Cargo input did not fail closed' >&2
	exit 1
fi
cp "$first/src/raw-pipeline/Cargo.lock" "$second/src/raw-pipeline/Cargo.lock"

rm -r "$second/src/raw-pipeline/raw-gpu/src"
if fingerprint "$second" >/dev/null 2>&1; then
	echo 'FAIL: missing source directory did not fail closed' >&2
	exit 1
fi

echo 'PASS: checkout-stable identity and changed-input invalidation'
