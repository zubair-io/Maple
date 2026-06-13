#!/usr/bin/env bash
# re-apply-patches.sh — re-apply Maple local vendor patches after `cargo vendor`.
#
# Run this after every `cargo vendor` refresh. Patches live in
# src/raw-pipeline/patches/ alongside this script's parent directory.
#
# Each patch is idempotent: if the target file already has the patched checksum
# the patch is skipped (already applied). If the target has neither the original
# nor the patched checksum, the script aborts — that means ort-sys was upgraded
# without updating the patch, and manual intervention is required.
#
# Usage:
#   ./scripts/re-apply-patches.sh            # from src/raw-pipeline/
#   src/raw-pipeline/scripts/re-apply-patches.sh  # from repo root
#
# After running this script you MUST also update vendor/ort-sys/.cargo-checksum.json
# to reflect the patched build.rs SHA-256. The script does this automatically.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
RAW_PIPELINE_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
VENDOR_DIR="$RAW_PIPELINE_DIR/vendor"
PATCHES_DIR="$RAW_PIPELINE_DIR/patches"

# ---------------------------------------------------------------------------
# Patch 1: ort-sys iOS clang_rt.osx guard  (Maple M6 #1244)
# ---------------------------------------------------------------------------
ORT_SYS_BUILD_RS="$VENDOR_DIR/ort-sys/build.rs"
ORT_SYS_CHECKSUM="$VENDOR_DIR/ort-sys/.cargo-checksum.json"

# SHA-256 of the UPSTREAM (unpatched) build.rs from ort-sys 0.23.0-rc.12
# (the version pinned by ort = "=2.0.0-rc.10").
# Update this when upgrading ort-sys.
UPSTREAM_SHA256="c1e166d9f3025251e755ea98bbcce4e2e15d6cc19fd57afc5ef2951e2aca6995"

# SHA-256 of the PATCHED build.rs (what we commit).
# Update this when the patch content changes (run: shasum -a 256 vendor/ort-sys/build.rs).
PATCHED_SHA256="82aa6ecb6f147b2af1c0759b90a31a0c0b100f6c6666cd0dff5df5502acfe8fe"

echo "==> re-apply-patches.sh"
echo "    ort-sys iOS clang_rt.osx guard (M6 #1244)"

if [[ ! -f "$ORT_SYS_BUILD_RS" ]]; then
    echo "ERROR: $ORT_SYS_BUILD_RS not found — is vendor/ populated?" >&2
    exit 1
fi

current_sha="$(shasum -a 256 "$ORT_SYS_BUILD_RS" | awk '{print $1}')"

if [[ "$current_sha" == "$PATCHED_SHA256" ]]; then
    echo "    already patched (SHA $PATCHED_SHA256) — nothing to do."
elif [[ "$current_sha" == "$UPSTREAM_SHA256" ]]; then
    echo "    upstream build.rs detected — applying iOS clang_rt.osx guard..."
    # Apply the guard: wrap the clang_rt.osx emission in an ios-target check.
    # We use Python (always available on macOS) to do a precise string replacement
    # so this is safe to re-run and produces exactly the patched content.
    python3 - "$ORT_SYS_BUILD_RS" <<'PYEOF'
import sys, re, pathlib

path = pathlib.Path(sys.argv[1])
src = path.read_text()

# The exact block to replace (upstream):
OLD = '''\t\tif let Some(dir) = macos_rtlib_search_dir() {
\t\t\tprintln!("cargo:rustc-link-search={dir}");
\t\t\tprintln!("cargo:rustc-link-lib=clang_rt.osx");
\t\t}'''

# The replacement (Maple iOS guard):
NEW = '''\t\t// Only emit clang_rt.osx for macOS targets — iOS / iOS-sim cross-compile
\t\t// must NOT link this library. `macos_rtlib_search_dir()` calls the host
\t\t// `clang --print-search-dirs` which returns the macOS/Catalyst runtime dir;
\t\t// injecting that path into an iOS link command produces:
\t\t//   "linking in object file built for 'zippered(macOS/Catalyst)'"
\t\t// and fails with a linker error. (Maple M6 #1244 vendor patch.)
\t\tif !target_triple.contains("apple-ios") {
\t\t\tif let Some(dir) = macos_rtlib_search_dir() {
\t\t\t\tprintln!("cargo:rustc-link-search={dir}");
\t\t\t\tprintln!("cargo:rustc-link-lib=clang_rt.osx");
\t\t\t}
\t\t}'''

if OLD not in src:
    print(f"ERROR: expected pattern not found in {path} — patch may be stale", file=sys.stderr)
    sys.exit(1)

count = src.count(OLD)
if count != 1:
    print(f"ERROR: expected exactly 1 occurrence of the patch target, found {count}", file=sys.stderr)
    sys.exit(1)

patched = src.replace(OLD, NEW)
path.write_text(patched)
print(f"    patched {path}")
PYEOF

    # Verify the result matches the expected patched SHA
    result_sha="$(shasum -a 256 "$ORT_SYS_BUILD_RS" | awk '{print $1}')"
    if [[ "$result_sha" != "$PATCHED_SHA256" ]]; then
        echo "ERROR: patch applied but result SHA $result_sha != expected $PATCHED_SHA256" >&2
        echo "       The patch content or the upstream file may have changed." >&2
        exit 1
    fi

    # Update .cargo-checksum.json to reflect the patched build.rs
    echo "    updating $ORT_SYS_CHECKSUM"
    python3 - "$ORT_SYS_CHECKSUM" "$PATCHED_SHA256" <<'PYEOF'
import sys, json, pathlib

ck_path = pathlib.Path(sys.argv[1])
new_sha = sys.argv[2]

data = json.loads(ck_path.read_text())
data["files"]["build.rs"] = new_sha
ck_path.write_text(json.dumps(data, indent=None, separators=(",", ":")))
print(f"    checksum updated: build.rs → {new_sha}")
PYEOF

    echo "    OK — patch applied and checksum updated."
else
    echo "ERROR: ort-sys/build.rs has unexpected SHA $current_sha" >&2
    echo "       Expected upstream ($UPSTREAM_SHA256) or patched ($PATCHED_SHA256)." >&2
    echo "       ort-sys may have been upgraded. Update the SHAs in this script," >&2
    echo "       adapt the patch in patches/ort-sys-ios-no-clang-rt.patch," >&2
    echo "       and re-apply manually." >&2
    exit 1
fi

echo ""
echo "==> All patches applied."
echo "    Commit vendor/ort-sys/build.rs and vendor/ort-sys/.cargo-checksum.json."
