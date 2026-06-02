#!/usr/bin/env bash
# build-xcframework.sh — compile raw-ffi for Apple targets, run cbindgen,
# bundle into RawPipeline.xcframework.
#
# Usage: ./scripts/build-xcframework.sh [--release]
#
# Requirements:
#   - cargo + rustup with targets:
#       aarch64-apple-ios
#       aarch64-apple-ios-sim
#       aarch64-apple-macos (= aarch64-apple-darwin)
#       x86_64-apple-macos  (= x86_64-apple-darwin)
#   - cbindgen (cargo install cbindgen)
#   - xcodebuild (ships with Xcode)
#
# Output: src/apple/Frameworks/RawPipeline.xcframework
# and:    src/apple/Sources/MapleCore/include/RawPipeline.h

set -euo pipefail

# Xcode's "Run Script" phase launches with a minimal PATH that omits
# `~/.cargo/bin` and Homebrew, so cargo/rustc/cbindgen are not on PATH by
# default. Prepend the standard Rust toolchain location and Homebrew
# prefixes so the same script works whether invoked from a terminal
# (no-op — PATH already has these) or from Xcode.
export PATH="$HOME/.cargo/bin:/opt/homebrew/bin:/usr/local/bin:$PATH"

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
NATIVE_DIR="$(dirname "$SCRIPT_DIR")"
# Walk up from NATIVE_DIR to find src/raw-pipeline (works whether invoked from
# within the repo or from the repo root).
_find_raw_pipeline() {
    local dir
    for dir in \
        "$NATIVE_DIR/../raw-pipeline" \
        "$NATIVE_DIR/../../raw-pipeline" \
        "$NATIVE_DIR/../../../raw-pipeline" \
        "$NATIVE_DIR/../../../../raw-pipeline"; do
        if [[ -f "$dir/Cargo.toml" ]]; then
            echo "$(cd "$dir" && pwd)"
            return 0
        fi
    done
    echo "ERROR: cannot find src/raw-pipeline relative to $NATIVE_DIR" >&2
    exit 1
}
RAW_PIPELINE_DIR="$(_find_raw_pipeline)"
RAW_FFI_DIR="$RAW_PIPELINE_DIR/raw-ffi"
FRAMEWORKS_DIR="$NATIVE_DIR/Frameworks"
HEADERS_DIR="$NATIVE_DIR/Packages/MapleCore/Sources/MapleCore/include"

PROFILE="debug"
CARGO_PROFILE_FLAG=""
if [[ "${1:-}" == "--release" ]]; then
    PROFILE="release"
    CARGO_PROFILE_FLAG="--release"
fi

echo "==> build-xcframework.sh"
echo "    raw-ffi:    $RAW_FFI_DIR"
echo "    frameworks: $FRAMEWORKS_DIR"
echo "    profile:    $PROFILE"

LIB_NAME="libraw_ffi.a"

# ---------------------------------------------------------------------------
# 0a. Fast-path: skip if no relevant Rust input has changed since the last
#     build.
#
# We hash the *content* of every input that can change the compiled
# libraw_ffi.a or the generated header — not file mtimes. mtime-based
# staleness (`find -newer`) is fragile: `git checkout`/pull rewrites the
# working tree with checkout-time mtimes (no content awareness, second
# resolution), so a freshly pulled source file can tie or even predate a
# stale stamp and read as "not newer" → false skip. That false skip is
# exactly how #817's new FFI symbols (`maple_compute_profile_curve` /
# `maple_compute_profile_lut`) shipped in a slice that didn't contain them
# and produced an opaque device-link error. A content hash removes the
# mtime dependency entirely: the stamp stores the hash of the inputs, and we
# skip ONLY when the current hash matches the stamped hash AND every
# expected slice exists.
#
# The stamp is written (with the hash) only after a successful build *and*
# the symbol-consistency guard at the end — never on a skipped/no-op run.
# `--force` / FORCE_XCFRAMEWORK_REBUILD=1 bypass the fast-path.
# ---------------------------------------------------------------------------
XCFW_OUT_PROBE="$NATIVE_DIR/Frameworks/RawPipeline.xcframework"
STAMP="$NATIVE_DIR/Frameworks/.xcframework-stamp.$PROFILE"

# Slices the xcframework must contain. Used by the fast-path existence check
# and (independently, via a glob) the symbol guard.
EXPECTED_SLICE_DIRS=(ios-arm64 ios-arm64-simulator macos-arm64_x86_64)

# Stable content hash over the inputs that affect the build:
#   - every .rs under raw-core/src and raw-ffi/src
#   - Cargo.lock (exact dependency versions)
#   - the workspace + raw-core + raw-ffi Cargo.toml files
# Paths are hashed alongside bytes and sorted with NUL delimiters so that
# renames/additions/deletions all register, independent of locale or
# filesystem ordering.
compute_input_hash() {
    {
        find "$RAW_PIPELINE_DIR/raw-core/src" "$RAW_PIPELINE_DIR/raw-ffi/src" \
            -type f -name '*.rs' -print0 2>/dev/null | sort -z | xargs -0 shasum
        for f in \
            "$RAW_PIPELINE_DIR/Cargo.lock" \
            "$RAW_PIPELINE_DIR/Cargo.toml" \
            "$RAW_PIPELINE_DIR/raw-core/Cargo.toml" \
            "$RAW_PIPELINE_DIR/raw-ffi/Cargo.toml"; do
            [[ -f "$f" ]] && shasum "$f"
        done
    } | shasum | awk '{print $1}'
}
INPUT_HASH="$(compute_input_hash)"

all_slices_present() {
    [[ -d "$XCFW_OUT_PROBE" ]] || return 1
    local d
    for d in "${EXPECTED_SLICE_DIRS[@]}"; do
        [[ -f "$XCFW_OUT_PROBE/$d/$LIB_NAME" ]] || return 1
    done
    return 0
}

if [[ "${FORCE_XCFRAMEWORK_REBUILD:-}" != "1" && "${1:-}" != "--force" && \
      -f "$STAMP" ]]; then
    stamped_hash="$(tr -d '[:space:]' < "$STAMP" 2>/dev/null)"
    if [[ "$stamped_hash" == "$INPUT_HASH" ]] && all_slices_present; then
        echo "==> No raw-pipeline input changes since last build (hash $INPUT_HASH) — skipping."
        exit 0
    fi
    if [[ "$stamped_hash" != "$INPUT_HASH" ]]; then
        echo "    input hash changed (was ${stamped_hash:-<none>}, now $INPUT_HASH) — rebuilding."
    else
        echo "    xcframework missing one or more expected slices — rebuilding."
    fi
fi

# ---------------------------------------------------------------------------
# 0. Validate tools
# ---------------------------------------------------------------------------
for tool in cargo cbindgen xcodebuild; do
    if ! command -v "$tool" &>/dev/null; then
        echo "ERROR: $tool not found — install it first."
        exit 1
    fi
done

# ---------------------------------------------------------------------------
# 1. Ensure required Rust targets are installed
# ---------------------------------------------------------------------------
TARGETS=(
    "aarch64-apple-ios"
    "aarch64-apple-ios-sim"
    "aarch64-apple-darwin"   # aarch64-apple-macos
    "x86_64-apple-darwin"    # x86_64-apple-macos
)

for target in "${TARGETS[@]}"; do
    if ! rustup target list --installed | grep -q "^${target}$"; then
        echo "==> Installing Rust target: $target"
        rustup target add "$target"
    fi
done

# ---------------------------------------------------------------------------
# 2. Cargo build for each target
# ---------------------------------------------------------------------------
CARGO_TARGET_DIR="$RAW_PIPELINE_DIR/target"

build_target() {
    local triple="$1"
    echo "==> cargo build [$triple]"
    (
        cd "$RAW_PIPELINE_DIR"
        # Set IPHONEOS_DEPLOYMENT_TARGET / MACOSX_DEPLOYMENT_TARGET so the
        # linker's minimum OS version matches the Xcode project (iOS 17,
        # macOS 14). Without this, blake3's NEON assembly triggers a
        # "___chkstk_darwin / built for newer iOS" linker error because the
        # Rust target's default minimum (iOS 10 / macOS 10.7) is too old.
        case "$triple" in
            *-apple-ios)
                export IPHONEOS_DEPLOYMENT_TARGET=17.0 ;;
            *-apple-ios-sim)
                export IPHONEOS_DEPLOYMENT_TARGET=17.0 ;;
            *-apple-darwin)
                export MACOSX_DEPLOYMENT_TARGET=14.0 ;;
        esac
        # --offline: dependencies are vendored under src/raw-pipeline/vendor
        # (see ../.cargo/config.toml). Forbidding network access keeps the
        # build hermetic — it removes the intermittent crates.io DNS failures
        # on Xcode Cloud and fails loudly if the vendor dir is ever stale,
        # instead of silently falling back to the network.
        CARGO_TARGET_DIR="$CARGO_TARGET_DIR" cargo build --offline $CARGO_PROFILE_FLAG \
            --target "$triple" \
            --package raw-ffi \
            2>&1
    )
}

for triple in "${TARGETS[@]}"; do
    build_target "$triple"
done

# ---------------------------------------------------------------------------
# 3. Generate C header via cbindgen
# ---------------------------------------------------------------------------
INCLUDE_DIR="$FRAMEWORKS_DIR/include"
mkdir -p "$INCLUDE_DIR" "$HEADERS_DIR"

echo "==> cbindgen — generating RawPipeline.h"
(
    cd "$RAW_FFI_DIR"
    cbindgen \
        --lang C \
        --output "$INCLUDE_DIR/RawPipeline.h" \
        --crate raw-ffi \
        2>&1
)

# Emit a modulemap so Swift can `import RawPipeline`. Without it, SwiftPM /
# xcodebuild treat the xcframework as a plain static library and the
# `import RawPipeline` line in MapleCore fails.
cat > "$INCLUDE_DIR/module.modulemap" <<'EOM'
module RawPipeline {
    header "RawPipeline.h"
    export *
}
EOM

# Also copy header + modulemap where Swift can find it directly in
# Packages/MapleCore/Sources/MapleCore/include/
cp "$INCLUDE_DIR/RawPipeline.h"    "$HEADERS_DIR/RawPipeline.h"
cp "$INCLUDE_DIR/module.modulemap" "$HEADERS_DIR/module.modulemap"

# ---------------------------------------------------------------------------
# 4. Create fat / xcframework inputs
#
# xcframework layout:
#   RawPipeline.xcframework/
#     ios-arm64/
#       libraw_ffi.a
#       Headers/RawPipeline.h
#     ios-arm64-simulator/
#       libraw_ffi.a    (aarch64-apple-ios-sim)
#       Headers/RawPipeline.h
#     macos-arm64_x86_64/
#       libraw_ffi.a    (lipo of darwin targets)
#       Headers/RawPipeline.h
# ---------------------------------------------------------------------------

ios_arm64_lib="$CARGO_TARGET_DIR/aarch64-apple-ios/$PROFILE/$LIB_NAME"
ios_sim_lib="$CARGO_TARGET_DIR/aarch64-apple-ios-sim/$PROFILE/$LIB_NAME"
macos_arm64_lib="$CARGO_TARGET_DIR/aarch64-apple-darwin/$PROFILE/$LIB_NAME"
macos_x86_lib="$CARGO_TARGET_DIR/x86_64-apple-darwin/$PROFILE/$LIB_NAME"

STAGING="$FRAMEWORKS_DIR/_staging"
rm -rf "$STAGING"
mkdir -p "$STAGING"

# iOS arm64
mkdir -p "$STAGING/ios-arm64"
cp "$ios_arm64_lib" "$STAGING/ios-arm64/$LIB_NAME"

# iOS Simulator arm64
mkdir -p "$STAGING/ios-arm64-sim"
cp "$ios_sim_lib" "$STAGING/ios-arm64-sim/$LIB_NAME"

# macOS universal
mkdir -p "$STAGING/macos-universal"
lipo -create \
    "$macos_arm64_lib" \
    "$macos_x86_lib" \
    -output "$STAGING/macos-universal/$LIB_NAME"

# ---------------------------------------------------------------------------
# 5. xcodebuild -create-xcframework
# ---------------------------------------------------------------------------
XCFW_OUT="$FRAMEWORKS_DIR/RawPipeline.xcframework"
rm -rf "$XCFW_OUT"

echo "==> xcodebuild -create-xcframework"
xcodebuild -create-xcframework \
    -library "$STAGING/ios-arm64/$LIB_NAME" \
    -headers "$INCLUDE_DIR" \
    -library "$STAGING/ios-arm64-sim/$LIB_NAME" \
    -headers "$INCLUDE_DIR" \
    -library "$STAGING/macos-universal/$LIB_NAME" \
    -headers "$INCLUDE_DIR" \
    -output "$XCFW_OUT"

# ---------------------------------------------------------------------------
# 6. Cleanup staging dir
# ---------------------------------------------------------------------------
rm -rf "$STAGING"

# ---------------------------------------------------------------------------
# 7. Symbol-consistency guard.
#
# Every `maple_*` C function the generated header declares MUST be a defined
# external symbol in every slice's libraw_ffi.a. This is the high-value
# catch for #876: if the fast-path (or any other mishap) leaves a slice that
# predates new FFI symbols, the device link fails late with an opaque
# `Undefined symbols: _maple_compute_profile_curve`. Here we turn that into a
# clear, early build failure naming the slice and the missing symbol.
#
# The expected symbol set is DERIVED from the header (not hardcoded) so it
# stays correct as the FFI surface grows. We strip comment lines (cbindgen
# doc-comments mention `maple_*` names in prose) and match only identifiers
# that appear as a C function call/declaration `maple_xxx(`.
# ---------------------------------------------------------------------------
echo "==> symbol guard — verifying header symbols are present in every slice"

# (No `mapfile` — the Xcode/CLI shebang resolves to macOS's bash 3.2, which
# lacks it. Read line-by-line into the array the portable way.)
EXPECTED_SYMBOLS=()
while IFS= read -r sym; do
    [[ -n "$sym" ]] && EXPECTED_SYMBOLS+=("$sym")
done < <(
    grep -vE '^[[:space:]]*\*' "$INCLUDE_DIR/RawPipeline.h" \
        | grep -oE '\bmaple_[a-z0-9_]+\(' \
        | sed 's/(//' \
        | sort -u
)

if [[ "${#EXPECTED_SYMBOLS[@]}" -eq 0 ]]; then
    echo "ERROR: symbol guard derived zero maple_* symbols from the generated header" >&2
    echo "       ($INCLUDE_DIR/RawPipeline.h) — header parse failed or header is empty." >&2
    echo "       Refusing to bless a possibly-empty xcframework." >&2
    exit 1
fi
echo "    expecting ${#EXPECTED_SYMBOLS[@]} exported maple_* symbols"

guard_failed=0
while IFS= read -r slice_lib; do
    slice_dir="$(basename "$(dirname "$slice_lib")")"
    # `nm -gU` lists external (-g), defined-only (-U) symbols. On a lipo'd
    # fat archive (the macOS slice) nm lists them per-arch; a symbol defined
    # in any arch satisfies the per-symbol check below. The Apple ABI
    # prefixes C symbols with a leading underscore, so we match `_<name>`.
    #
    # `|| true` on the whole pipeline is load-bearing under `set -euo
    # pipefail`: `nm` exits non-zero (and prints to stderr) when an archive
    # member is a Rust LLVM-bitcode object it can't fully parse
    # ("Unknown attribute kind …"). That non-zero status would otherwise
    # propagate through `pipefail` to this command-substitution assignment
    # and `set -e` would abort the guard before it checked a single symbol —
    # a silent false failure with no per-slice output. The defined symbols
    # `nm` *does* emit still land on stdout, so masking the exit status is
    # safe: if `nm` genuinely produced nothing (broken/empty lib), `defined`
    # is empty and every symbol flags as missing below — a loud, correct
    # failure, not a false pass.
    defined="$(nm -gU "$slice_lib" 2>/dev/null | awk '{print $NF}' || true)"
    for sym in "${EXPECTED_SYMBOLS[@]}"; do
        if ! grep -qxF "_$sym" <<<"$defined"; then
            echo "ERROR: stale/incomplete slice $slice_dir: missing symbol $sym" >&2
            guard_failed=1
        fi
    done
done < <(find "$XCFW_OUT" -name "$LIB_NAME")

if [[ "$guard_failed" -ne 0 ]]; then
    echo "" >&2
    echo "ERROR: the xcframework is out of sync with the generated headers." >&2
    echo "       One or more slices are missing FFI symbols the header exports." >&2
    echo "       Rerun the build with --force (or FORCE_XCFRAMEWORK_REBUILD=1) to" >&2
    echo "       rebuild every slice from the current sources." >&2
    exit 1
fi
echo "    OK — all ${#EXPECTED_SYMBOLS[@]} symbols present in every slice"

# Mark this build as up-to-date for the staleness fast-path. We store the
# input content hash (NOT a bare touch) so the next run can compare content,
# and we write it only now — after a successful build AND a passing symbol
# guard — so a failed/partial build never blesses itself.
printf '%s\n' "$INPUT_HASH" > "$STAMP"

echo ""
echo "==> Done."
echo "    Output: $XCFW_OUT"
echo ""
echo "Next step: uncomment .binaryTarget and dependency in Package.swift and run swift build."
