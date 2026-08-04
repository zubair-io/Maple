#!/usr/bin/env bash
# src/windows/scripts/build-windows.sh — Build script for Maple Windows target
# Compiles the Rust core, FFI, and Windows native host executable.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT_DIR="$(cd "$SCRIPT_DIR/../../.." && pwd)"

cd "$ROOT_DIR"

echo "=== Building Maple Windows Native Core & FFI ==="

# Target triple defaults to x86_64-pc-windows-msvc (or cross-compilation target)
TARGET="${WINDOWS_TARGET:-x86_64-pc-windows-msvc}"

echo "Target architecture: $TARGET"

# 1. Regenerate cross-language schema declarations
echo "--> Running codegen..."
./tools/codegen.sh

# 2. Build Rust core FFI for Windows target
echo "--> Building raw-ffi for $TARGET..."
cargo build --release \
  --manifest-path src/raw-pipeline/Cargo.toml \
  -p raw-ffi \
  --features gpu

# 3. Build Windows native host binary
echo "--> Building maple-windows native host..."
cargo build --release \
  --manifest-path src/windows/Cargo.toml

# 4. Build WinUI 3 Native UI Solution
echo "--> Building WinUI 3 Native Application (Maple.WinUI.csproj)..."
if command -v dotnet &> /dev/null; then
  dotnet build src/windows/Maple.WinUI/Maple.WinUI.csproj -c Release
fi

echo "=== Windows build completed successfully ==="
