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
test -x "$toolchain/aarch64-linux-android29-clang" || {
	echo "Install Android NDK 28.2.13676358 under $sdk" >&2
	exit 1
}
export CARGO_TARGET_AARCH64_LINUX_ANDROID_LINKER="$toolchain/aarch64-linux-android29-clang"
export CC_aarch64_linux_android="$toolchain/aarch64-linux-android29-clang"
export AR_aarch64_linux_android="$toolchain/llvm-ar"
cargo build --manifest-path native/Cargo.toml --target aarch64-linux-android --release --locked
