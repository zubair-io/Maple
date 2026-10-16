#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/.."
sdk="${ANDROID_HOME:-${ANDROID_SDK_ROOT:-$HOME/Library/Android/sdk}}"
ndk="$sdk/ndk/28.2.13676358"
case "$(uname -s)" in
Darwin) host=darwin-x86_64 ;;
Linux) host=linux-x86_64 ;;
*)
	echo 'Build the Android native library on macOS or Linux.' >&2
	exit 1
	;;
esac
toolchain="$ndk/toolchains/llvm/prebuilt/$host/bin"
export CARGO_TARGET_AARCH64_LINUX_ANDROID_LINKER="$toolchain/aarch64-linux-android29-clang"
export CC_aarch64_linux_android="$toolchain/aarch64-linux-android29-clang"
export AR_aarch64_linux_android="$toolchain/llvm-ar"
export CARGO_TARGET_X86_64_LINUX_ANDROID_LINKER="$toolchain/x86_64-linux-android29-clang"
export CC_x86_64_linux_android="$toolchain/x86_64-linux-android29-clang"
export AR_x86_64_linux_android="$toolchain/llvm-ar"
for abi in "${@:-arm64-v8a}"; do
	case "$abi" in
	arm64-v8a) target=aarch64-linux-android ;;
	x86_64) target=x86_64-linux-android ;;
	*)
		echo "Unsupported Maple Android ABI: $abi" >&2
		exit 1
		;;
	esac
	test -x "$toolchain/${target}29-clang" || {
		echo "Install Android NDK 28.2.13676358 under $sdk" >&2
		exit 1
	}
	cargo build --manifest-path native/Cargo.toml --target "$target" --release --locked
done
