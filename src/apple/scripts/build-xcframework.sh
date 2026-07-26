#!/usr/bin/env bash
# build-xcframework.sh — compile raw-ffi for Apple targets, run cbindgen,
# bundle into RawPipeline.xcframework.
#
# Usage: ./scripts/build-xcframework.sh [--debug]
#
# The default profile is RELEASE. The Maple pano path (maple_pano_stitch) runs
# ~16× slower in debug than release on CPU-heavy SIMD/ONNX workloads (measured:
# 5785s debug vs 353s release for an identical 21-frame stitch on M4). Pass
# --debug only for fast-recompile iteration where pano performance doesn't
# matter. The CI (Xcode Cloud ci_post_clone.sh) always builds release.
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

PROFILE="release"
CARGO_PROFILE_FLAG="--release"
if [[ "${1:-}" == "--debug" ]]; then
    PROFILE="debug"
    CARGO_PROFILE_FLAG=""
    echo "WARNING: building debug xcframework — maple_pano_stitch runs ~16× slower" >&2
    echo "         in debug than release on CPU-heavy SIMD/ONNX workloads." >&2
    echo "         Use this only for fast-compile iteration where pano perf doesn't matter." >&2
fi

# ---------------------------------------------------------------------------
# GPU build (epic #925 / #1064) — always on.
#
# As of #1064 the Apple build is always-gpu (no wgpu-free variant): raw-ffi is
# built with `--features gpu`, which links wgpu/naga/metal into every slice
# (incl. aarch64-apple-ios — the #1 cross-compile risk) and compiles the
# `maple_gpu_*` FFI surface the always-compiled Swift GPU live path links
# against. The `MAPLE_GPU` compile gate on the Swift side is gone, and the
# cbindgen header now declares `maple_gpu_*` unconditionally, so the libs MUST
# contain them — hence `--features gpu` is unconditional here.
#
# The build is OFFLINE from the vendored sources. wgpu's full dep tree IS
# vendored under `src/raw-pipeline/vendor/` (`cargo vendor` after #996 —
# wgpu/wgpu-core/wgpu-hal/wgpu-types, naga, metal, ash, gpu-alloc*/gpu-descriptor*,
# pollster, futures-channel, … all present with their `.cargo-checksum.json`), so
# the build is hermetic: no crates.io round-trip, no intermittent "Could not
# resolve host" DNS flake on the Xcode Cloud workers, and a loud failure if
# vendor/ is ever stale instead of a silent network fallback.

echo "==> build-xcframework.sh"
echo "    raw-ffi:    $RAW_FFI_DIR"
echo "    frameworks: $FRAMEWORKS_DIR"
echo "    profile:    $PROFILE"
echo "    GPU:        ON (--features gpu, offline + vendored — always-gpu since #1064)"
echo "    PANO-iOS:   ON (--features pano-ios for iOS slices; static ORT — M6 #1244)"

# ---------------------------------------------------------------------------
# 0a-pano. Provision the ONNX Runtime iOS static xcframework (M6 #1244).
#
# The ORT iOS static lib is required for the iOS + iOS-sim slices when
# `pano-ios` is enabled. The zip (pod-archive-onnxruntime-c-1.22.0.zip,
# 45 MB) is vendored in the repo at src/apple/vendor/ort-ios/ (#1353).
# fetch-ort-ios.sh copies it to ~/.cache/maple-pano/ort-ios/, verifies
# the ZIP SHA-256, and extracts it. No network access is required.
#
# ORT version 1.22.0 pairs with the workspace's `ort = "=2.0.0-rc.10"`
# crate (which binds ORT 1.22.x C API). The official iOS pod is a static
# xcframework — libonnxruntime.a for arm64 and a fat arm64+x86_64 for the
# simulator — and includes the CoreML EP symbols (M6-C placeholder, not yet
# wired).
# ---------------------------------------------------------------------------
ORT_IOS_XCFW_BASE="${HOME}/.cache/maple-pano/ort-ios/onnxruntime-c-1.22.0/onnxruntime.xcframework"

fetch_ort_ios_if_needed() {
    local fetch_script="$SCRIPT_DIR/fetch-ort-ios.sh"
    if [[ ! -x "$fetch_script" ]]; then
        echo "ERROR: fetch-ort-ios.sh not found at $fetch_script" >&2
        exit 1
    fi
    if [[ ! -f "${ORT_IOS_XCFW_BASE}/ios-arm64/onnxruntime.framework/onnxruntime" ]]; then
        echo "==> ORT iOS static lib not cached — fetching..."
        "$fetch_script"
    else
        echo "==> ORT iOS static lib cached at $ORT_IOS_XCFW_BASE"
    fi
}

fetch_ort_ios_if_needed

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
# A pre-#1064 wgpu-free stamp can't be mistaken for this always-gpu build:
# cbindgen.toml is in the input hash below, and the #1064 change to it (drop the
# `feature = gpu` define) bumps the hash, so any stale wgpu-free stamp mismatches
# and forces a rebuild.
STAMP="$NATIVE_DIR/Frameworks/.xcframework-stamp.$PROFILE"

# Slices the xcframework must contain. Used by the fast-path existence check
# and (independently, via a glob) the symbol guard.
EXPECTED_SLICE_DIRS=(ios-arm64 ios-arm64-simulator macos-arm64_x86_64)

# Stable content hash over the inputs that affect the build:
#   - every .rs, .wgsl, and .bin under raw-core/src, raw-ffi/src,
#     maple-pano/src, and raw-gpu/src (the .bin blobs are include_bytes!-
#     embedded LUT / profile-bundle build inputs — #1946)
#   - Cargo.lock (exact dependency versions)
#   - the workspace + raw-core + raw-ffi Cargo.toml files
#   - raw-ffi/cbindgen.toml (drives header generation — its [defines] decide
#     which symbols the guard expects, so a change here must force a rebuild
#     even when no Rust/Cargo input moved)
# Paths are hashed alongside bytes and sorted with NUL delimiters so that
# renames/additions/deletions all register, independent of locale or
# filesystem ordering.
compute_input_hash() {
    {
        # raw-core, raw-ffi, (since M3 #1235) maple-pano, and raw-gpu — raw-ffi's
        # GPU live/present FFI delegates into raw-gpu (the wgpu/WGSL chain), so a
        # raw-gpu change MUST trigger a rebuild. Omitting it (the bug #1513
        # exposed) let a raw-gpu-only edit hash-skip and ship a stale xcframework.
        # Includes `*.wgsl` shaders: raw-gpu `include_str!`s them into the compiled
        # library (the kernels run from those strings), so a shader-only edit also
        # changes the lib and must not hash-skip.
        # Includes `*.bin` blobs (#1946): the baked LUT / profile-bundle files are
        # `include_bytes!`-embedded into the compiled libraries and are therefore
        # real build inputs — `view/agx_lut.bin` (the AgX cube LUT) and
        # `color/profiles/profiles.bin` (the DCP bundle). A LUT- or
        # profile-only regeneration touches no `.rs`/`.wgsl`
        # file, so without hashing these a stale xcframework would ship — the same
        # bug class #1513 fixed for `.wgsl`, never extended to the `.bin` files.
        find "$RAW_PIPELINE_DIR/raw-core/src" \
             "$RAW_PIPELINE_DIR/raw-ffi/src" \
             "$RAW_PIPELINE_DIR/maple-pano/src" \
             "$RAW_PIPELINE_DIR/raw-gpu/src" \
            -type f \( -name '*.rs' -o -name '*.wgsl' -o -name '*.bin' \) -print0 2>/dev/null | sort -z | xargs -0 shasum
        for f in \
            "$RAW_PIPELINE_DIR/Cargo.lock" \
            "$RAW_PIPELINE_DIR/Cargo.toml" \
            "$RAW_PIPELINE_DIR/raw-core/Cargo.toml" \
            "$RAW_PIPELINE_DIR/raw-ffi/Cargo.toml" \
            "$RAW_PIPELINE_DIR/maple-pano/Cargo.toml" \
            "$RAW_PIPELINE_DIR/raw-gpu/Cargo.toml" \
            "$RAW_FFI_DIR/cbindgen.toml" \
            "$SCRIPT_DIR/fetch-ort-ios.sh"; do
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
# 0b-pano. Verify the ort-sys iOS vendor patch is applied (M6 #1244).
#
# The iOS build requires a patch to vendor/ort-sys/build.rs that guards the
# clang_rt.osx link emission behind an `if !target_triple.contains("apple-ios")`
# check. `cargo vendor` silently reverts vendor patches — this guard catches that
# before the build fails with a cryptic linker error.
#
# SHA-256 of the PATCHED build.rs (must match patches/ort-sys-ios-no-clang-rt.patch).
# Update when the patch changes: `shasum -a 256 vendor/ort-sys/build.rs`
# ---------------------------------------------------------------------------
ORT_SYS_PATCHED_SHA256="82aa6ecb6f147b2af1c0759b90a31a0c0b100f6c6666cd0dff5df5502acfe8fe"
ORT_SYS_BUILD_RS="$RAW_PIPELINE_DIR/vendor/ort-sys/build.rs"
if [[ -f "$ORT_SYS_BUILD_RS" ]]; then
    actual_sha="$(shasum -a 256 "$ORT_SYS_BUILD_RS" | awk '{print $1}')"
    if [[ "$actual_sha" != "$ORT_SYS_PATCHED_SHA256" ]]; then
        echo "" >&2
        echo "ERROR: vendor/ort-sys/build.rs does not have the expected iOS patch." >&2
        echo "       Found SHA:    $actual_sha" >&2
        echo "       Expected SHA: $ORT_SYS_PATCHED_SHA256" >&2
        echo "" >&2
        echo "       This likely means 'cargo vendor' was re-run and reverted the patch." >&2
        echo "       Re-apply it:" >&2
        echo "         src/raw-pipeline/scripts/re-apply-patches.sh" >&2
        echo "       Then commit vendor/ort-sys/build.rs + vendor/ort-sys/.cargo-checksum.json." >&2
        echo "" >&2
        echo "       See src/raw-pipeline/patches/ort-sys-ios-no-clang-rt.patch for details." >&2
        exit 1
    fi
    echo "==> ort-sys iOS patch verified (SHA $ORT_SYS_PATCHED_SHA256)"
fi

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
        # Build raw-ffi against the vendored crate sources under
        # src/raw-pipeline/vendor/ (committed by `cargo vendor`), with the network
        # forbidden. This keeps the Xcode Cloud build hermetic: it removes the
        # intermittent crates.io DNS failures ("Could not resolve host:
        # static.crates.io") and fails loudly if the vendor dir is ever stale,
        # instead of silently falling back to the network.
        #
        # The source replacement is passed inline (not via a committed
        # .cargo/config.toml) so it applies ONLY to this Apple raw-ffi build. A
        # repo-level config.toml would also be inherited by the WASM build, which
        # uses `-Z build-std` — that rebuilds std from source and needs std's
        # *own* dependency versions, which aren't (and shouldn't be) in our vendor
        # dir. Scoping it here keeps the web/wasm and API builds resolving from
        # crates.io as before. The directory is absolute so it resolves regardless
        # of cargo's --config path semantics.
        #
        # `--features gpu` is unconditional since #1064 (the Apple build is
        # always-gpu): it links wgpu/naga/metal into every slice and compiles the
        # `maple_gpu_*` FFI the always-compiled Swift GPU live path links against.
        # wgpu's full dep tree IS vendored (#996), so the gpu build cross-compiles
        # + links into every slice (incl. aarch64-apple-ios — the #1 risk) with no
        # crates.io round-trip and no DNS flake.
        #
        # Pano features (M6 #1244 — split by target):
        #
        # macOS slices (`--features gpu,pano`): pulls `maple-pano` with `ml`
        # (ALIKED + LightGlue via ort `load-dynamic`). The onnxruntime dylib is
        # loaded at runtime; it is NOT embedded in the xcframework.
        #
        # iOS + iOS-sim slices (`--features gpu,pano-ios`): pulls `maple-pano`
        # with `ml-static` (ort WITHOUT `load-dynamic`). `ORT_LIB_LOCATION`
        # points at the official iOS static xcframework (cached by fetch-ort-ios.sh
        # at ~/.cache/maple-pano/ort-ios/). ort-sys sees `libonnxruntime.a` (or the
        # framework binary named `onnxruntime`) in that dir and emits
        # `cargo:rustc-link-lib=static=onnxruntime`. The iOS sandbox blocks dlopen
        # of arbitrary paths — static linking is the only correct path.
        #
        # The framework binary inside Apple's pod is named `onnxruntime` (no lib
        # prefix, no .a extension) and is a Mach-O fat archive (0xcafebabe) even
        # for single-arch slices. We use `lipo -thin arm64` to extract a plain ar
        # archive named exactly `libonnxruntime.a` (the name ort-sys probes for)
        # into a per-target subdirectory of .ort-ios-thin/$PROFILE/$triple/.
        local PANO_FEATURES="pano"
        case "$triple" in
            *-apple-ios|*-apple-ios-sim)
                PANO_FEATURES="pano-ios"
                # ort-sys's build.rs searches for `libonnxruntime.a` in ORT_LIB_LOCATION.
                # Apple's xcframework pod names the binary `onnxruntime` (no lib prefix, no
                # .a extension) and wraps it in a Mach-O fat archive (magic 0xcafebabe) even
                # when there is only one architecture. Rust's linker rejects a fat archive
                # as "Unsupported archive identifier" — it expects a plain ar archive (!<arch>).
                #
                # Fix: `lipo -thin arm64` extracts the arm64 slice as a clean ar archive.
                # We write it to the PROFILE-scoped cache dir alongside the build outputs to
                # avoid contaminating the shared ORT cache. The extracted .a is stable across
                # build runs (content-addressed by ORT version + profile), so we skip the lipo
                # step if the file already exists.
                # Each target gets its own subdirectory so the file is always
                # named exactly `libonnxruntime.a` — that is the name ort-sys's
                # build.rs probes for via `platform_format_lib("onnxruntime")`.
                # Sharing a flat dir and using per-target name suffixes (e.g.
                # libonnxruntime-ios-arm64.a) caused ort-sys to emit no link
                # directive and the build to fail with undefined symbols.
                ORT_THIN_DIR="$CARGO_TARGET_DIR/.ort-ios-thin/$PROFILE/$triple"
                mkdir -p "$ORT_THIN_DIR"
                ORT_THIN_LIB="$ORT_THIN_DIR/libonnxruntime.a"
                case "$triple" in
                    *-apple-ios)
                        ORT_FAT_LIB="${ORT_IOS_XCFW_BASE}/ios-arm64/onnxruntime.framework/onnxruntime"
                        ;;
                    *-apple-ios-sim)
                        ORT_FAT_LIB="${ORT_IOS_XCFW_BASE}/ios-arm64_x86_64-simulator/onnxruntime.framework/onnxruntime"
                        ;;
                esac
                if [[ ! -f "$ORT_THIN_LIB" ]]; then
                    echo "    lipo -thin arm64 → $ORT_THIN_LIB"
                    lipo -thin arm64 "$ORT_FAT_LIB" -output "$ORT_THIN_LIB"
                else
                    echo "    ORT arm64 slice already extracted: $ORT_THIN_LIB"
                fi
                # ort-sys's build.rs calls `add_search_dir` on ORT_LIB_LOCATION, then checks
                # if `libonnxruntime.a` exists there to emit `cargo:rustc-link-lib=static=onnxruntime`.
                export ORT_LIB_LOCATION="$ORT_THIN_DIR"
                echo "    ORT_LIB_LOCATION=$ORT_LIB_LOCATION (static arm64 ar archive, M6 #1244)"
                ;;
        esac
        CARGO_TARGET_DIR="$CARGO_TARGET_DIR" cargo build --offline $CARGO_PROFILE_FLAG \
            --config 'source.crates-io.replace-with="vendored-sources"' \
            --config "source.vendored-sources.directory=\"$RAW_PIPELINE_DIR/vendor\"" \
            --target "$triple" \
            --package raw-ffi \
            --features "gpu,$PANO_FEATURES" \
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

# cbindgen runs `cargo metadata` internally to resolve the crate graph, and
# that invocation reads `.cargo/config.toml` from the directory hierarchy.
# On Xcode Cloud (empty registry cache + intermittent DNS) the default
# `cargo metadata` attempts to "Update crates.io index", fails to resolve
# `blake3`, and the build dies with:
#
#   ERROR: Couldn't execute `cargo metadata` ... failed to get `blake3` as
#   a dependency ... download of bl/ak/blake3 failed ... Could not resolve
#   host: index.crates.io
#
# Fix: write a scoped, transient `.cargo/config.toml` under raw-ffi/ so
# cbindgen's internal `cargo metadata` resolves offline from vendor/.
#
# WHY scoped to raw-ffi/.cargo/ (not repo root): a repo-level config.toml
# would also be inherited by the WASM build (raw-wasm/), which uses
# `-Z build-std` — that rebuilds std from source and needs std's own
# dependency versions, which are not (and should not be) in our vendor dir.
# A config under raw-ffi/.cargo/ is only discovered when cwd is within
# raw-ffi/ (exactly the cbindgen step below), so the WASM and API builds
# continue resolving from crates.io as before.
#
# The file is removed immediately after cbindgen (and on any exit via trap)
# so it never persists into subsequent build steps.
CBINDGEN_CARGO_DIR="$RAW_FFI_DIR/.cargo"
CBINDGEN_CARGO_CFG="$CBINDGEN_CARGO_DIR/config.toml"
mkdir -p "$CBINDGEN_CARGO_DIR"
cat > "$CBINDGEN_CARGO_CFG" <<CBINDGEN_CFG
[source.crates-io]
replace-with = "vendored-sources"
[source.vendored-sources]
directory = "$RAW_PIPELINE_DIR/vendor"
[net]
offline = true
CBINDGEN_CFG

# Ensure the transient config is removed even when the script exits early.
trap 'rm -rf "$CBINDGEN_CARGO_DIR"' EXIT

(
    cd "$RAW_FFI_DIR"
    # Since #1064 the header declares the GPU FFI surface (`maple_gpu_*`,
    # src/gpu.rs + src/gpu_live.rs) UNCONDITIONALLY — cbindgen.toml no longer maps
    # `feature = gpu` to `#if defined(MAPLE_GPU)`. The two Apple-only present
    # entries stay wrapped in `#if defined(__APPLE__)` (their Rust cfg), which the
    # Clang importer always satisfies on Apple slices. Because the default build
    # links raw-ffi `--features gpu` (above), the libs contain every declared
    # `maple_gpu_*` symbol, so the symbol guard below passes.
    cbindgen \
        --config cbindgen.toml \
        --lang C \
        --output "$INCLUDE_DIR/RawPipeline.h" \
        --crate raw-ffi \
        2>&1
)

# Remove the transient .cargo/ immediately so the cleanup trap is a no-op
# for normal (non-error) exits (belt-and-suspenders).
rm -rf "$CBINDGEN_CARGO_DIR"
# Unset the trap now that we've cleaned up manually.
trap - EXIT

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

# Since #1064 the build is always-gpu and the header declares the whole FFI
# surface (`maple_gpu_*` included) UNCONDITIONALLY — cbindgen.toml no longer wraps
# them in `#if defined(MAPLE_GPU)`, and there is no wgpu-free variant. So every
# `maple_*` identifier the header declares is expected in every slice; no
# conditional-region stripping is needed. (The two Apple-only present entries are
# wrapped in `#if defined(__APPLE__)`, which holds on every Apple slice, so their
# symbols are correctly expected too.)
#
# EXCEPTION — iOS-only symbols (M6 #1244): `maple_pano_ort_selftest` is compiled
# only for iOS/iOS-sim (the static-link ORT path). Its declaration appears in the
# shared header (cbindgen parses source text regardless of feature/target cfg), but
# the symbol is NOT present in the macOS slice. We maintain an explicit list here;
# macOS slice checks skip these. iOS/iOS-sim slices MUST have them.
IOS_ONLY_SYMBOLS=(
    maple_pano_ort_selftest   # ORT static-link smoke test (M6 #1244, pano-ios only)
)

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
echo "    expecting ${#EXPECTED_SYMBOLS[@]} exported maple_* symbols (${#IOS_ONLY_SYMBOLS[@]} iOS-only)"

# Helper: returns 0 (true) if $1 is in the IOS_ONLY_SYMBOLS list.
is_ios_only_symbol() {
    local sym="$1"
    local s
    for s in "${IOS_ONLY_SYMBOLS[@]}"; do
        [[ "$s" == "$sym" ]] && return 0
    done
    return 1
}

guard_failed=0
while IFS= read -r slice_lib; do
    slice_dir="$(basename "$(dirname "$slice_lib")")"
    # Determine whether this slice is an iOS slice (arm64 device or simulator).
    # macOS slices are named `macos-*`; iOS slices are `ios-*`.
    is_ios_slice=0
    if [[ "$slice_dir" == ios-* ]]; then
        is_ios_slice=1
    fi
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
        # iOS-only symbols: required in iOS slices, must NOT be in macOS slices.
        if is_ios_only_symbol "$sym"; then
            if [[ "$is_ios_slice" -eq 1 ]]; then
                # iOS slice MUST have the symbol.
                if ! grep -qxF "_$sym" <<<"$defined"; then
                    echo "ERROR: iOS slice $slice_dir: missing iOS-only symbol $sym" >&2
                    guard_failed=1
                fi
            else
                # macOS slice must NOT have it (would indicate a mis-build).
                if grep -qxF "_$sym" <<<"$defined"; then
                    echo "ERROR: macOS slice $slice_dir: found iOS-only symbol $sym (should be absent)" >&2
                    guard_failed=1
                fi
            fi
        else
            # All-slice symbol: must be present in every slice.
            if ! grep -qxF "_$sym" <<<"$defined"; then
                echo "ERROR: stale/incomplete slice $slice_dir: missing symbol $sym" >&2
                guard_failed=1
            fi
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
echo "    OK — all ${#EXPECTED_SYMBOLS[@]} symbols verified across all slices (${#IOS_ONLY_SYMBOLS[@]} iOS-only)"

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
