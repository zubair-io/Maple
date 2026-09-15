#!/usr/bin/env bash
# Build the Windows/MSVC native core, diagnostic host, and WinUI application.
# Run under Git Bash on Windows with the matching native Rust host toolchain.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT_DIR="$(cd "$SCRIPT_DIR/../../.." && pwd)"
cd "$ROOT_DIR"

fail() {
  echo "Windows build: $*" >&2
  exit 1
}

TARGET="${WINDOWS_TARGET:-x86_64-pc-windows-msvc}"
case "$TARGET" in
  x86_64-pc-windows-msvc) PLATFORM=x64; RID=win-x64 ;;
  aarch64-pc-windows-msvc) PLATFORM=ARM64; RID=win-arm64 ;;
  *) fail "unsupported WINDOWS_TARGET '$TARGET'; use x86_64-pc-windows-msvc or aarch64-pc-windows-msvc" ;;
esac

# Preflight before codegen or any expensive compilation. A partial Rust build
# must never be reported as a successfully built Windows application.
for tool in cargo rustc dotnet git python3; do
  command -v "$tool" >/dev/null 2>&1 || fail "required tool '$tool' was not found in PATH"
done
RUST_VERSION="$(rustc -vV)"
RUST_HOST=""
while read -r key value; do
  if [[ "$key" == host: ]]; then RUST_HOST="$value"; fi
done <<< "$RUST_VERSION"
[[ "$RUST_HOST" == "$TARGET" ]] || fail "native Windows builds only: Rust host '$RUST_HOST' does not match '$TARGET'; cross-compilation is not supported"

# Keep Cargo output independent of a caller's CARGO_TARGET_DIR. The codegen
# wrapper expects its executable at the workspace's unqualified release path.
echo "--> Running codegen..."
(
  unset CARGO_BUILD_TARGET
  export CARGO_TARGET_DIR="$ROOT_DIR/src/raw-pipeline/target"
  ./tools/codegen.sh
)

NATIVE_DIR="src/raw-pipeline/target/$TARGET/release"
HOST_DIR="src/windows/target/$TARGET/release"
APP_DIR="src/windows/Maple.WinUI/bin/Release/$TARGET"

echo "--> Building raw-ffi for $TARGET..."
cargo build --release --target "$TARGET" --target-dir src/raw-pipeline/target \
  --manifest-path src/raw-pipeline/Cargo.toml -p raw-ffi --features gpu
[[ -s "$NATIVE_DIR/raw_ffi.dll" ]] || fail "missing native output: $NATIVE_DIR/raw_ffi.dll"

echo "--> Building diagnostic host for $TARGET..."
cargo build --release --target "$TARGET" --target-dir src/windows/target \
  --manifest-path src/windows/Cargo.toml
[[ -s "$HOST_DIR/maple-windows.exe" ]] || fail "missing diagnostic output: $HOST_DIR/maple-windows.exe"

echo "--> Building WinUI application for $RID ($PLATFORM)..."
dotnet build src/windows/Maple.WinUI/Maple.WinUI.csproj -c Release \
  -r "$RID" "-p:Platform=$PLATFORM" "-p:MapleRustTarget=$TARGET" -o "$APP_DIR"
for output in Maple.WinUI.exe raw_ffi.dll; do
  [[ -s "$APP_DIR/$output" ]] || fail "missing application output: $APP_DIR/$output"
done

echo "Windows application built successfully: $APP_DIR/Maple.WinUI.exe"
