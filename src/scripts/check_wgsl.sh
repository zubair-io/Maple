#!/usr/bin/env bash
# check_wgsl.sh — CPU-only WGSL syntax/type gate for the hand-written raw-gpu
# kernels (#1937).
#
# Why this exists:
#
#   The raw-gpu WGSL kernels (raw-gpu/src/*.wgsl) are compiled by naga at
#   runtime inside GpuContext's pipeline accessors — so a WGSL syntax or type
#   error is only caught when a GPU device actually compiles the shader, i.e.
#   on a local run or an Apple-side build. No CI step validated the shaders,
#   and the runtime raw-gpu tests need a GPU adapter that a stock Linux runner
#   doesn't have. This gate runs naga's WGSL front-end + validator on the CPU
#   with no GPU, so it catches shader breakage on every runner.
#
# What it checks:
#
#   naga has no `#include`, but the Rust pipeline accessors assemble several
#   kernels by PREPENDING generated header modules before compiling
#   (context_pipelines.rs / context_pipelines_helpers.rs):
#     * generated/color_matrices.wgsl   — the Oklab / Rec.2020<->sRGB mul_*
#                                          helpers (compile_with_matrices / _nr)
#     * generated/agx_coeffs.wgsl       — the AgX inset/outset matrices (agx only)
#   So validating a kernel that calls `mul_rec2020_to_srgb` standalone reports a
#   false "unknown identifier". To mirror the runtime concat without hard-coding
#   a per-kernel header map (which would drift from the Rust source), each kernel
#   is validated under a LADDER of header prefixes:
#       (a) standalone
#       (b) color_matrices + kernel
#       (c) color_matrices + agx_coeffs + kernel
#   A kernel PASSES if it validates under ANY rung (unused header helpers are
#   legal WGSL), and FAILS only if a genuine syntax/type error makes every rung
#   fail. The generated headers are themselves validated standalone (rung a).
#
# Usage:
#   src/scripts/check_wgsl.sh            # uses `naga` on PATH
#   NAGA=/path/to/naga src/scripts/check_wgsl.sh
#
# naga-cli install (CI): `cargo install naga-cli --locked`.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"
WGSL_DIR="$REPO_ROOT/src/raw-pipeline/raw-gpu/src"
GEN_DIR="$WGSL_DIR/generated"

NAGA="${NAGA:-naga}"
if ! command -v "$NAGA" >/dev/null 2>&1; then
  echo "check_wgsl: naga not found (set NAGA=/path/to/naga or 'cargo install naga-cli --locked')" >&2
  exit 2
fi

COLOR_MATRICES="$GEN_DIR/color_matrices.wgsl"
AGX_COEFFS="$GEN_DIR/agx_coeffs.wgsl"
for f in "$COLOR_MATRICES" "$AGX_COEFFS"; do
  if [[ ! -f "$f" ]]; then
    echo "check_wgsl: generated header missing: $f (run tools/codegen.sh)" >&2
    exit 2
  fi
done

TMP="$(mktemp -d -t check-wgsl-XXXXXX)"
trap 'rm -rf "$TMP"' EXIT

# Validate one assembled module; returns 0 if naga accepts it. naga prints a
# WGSL diagnostic and exits non-zero on a parse/validation error; with only an
# input file (no output file) it performs validation only.
validate() {
  local src="$1"
  "$NAGA" "$src" >/dev/null 2>"$TMP/err"
}

fail=0
checked=0
# Every hand-written kernel plus the two generated headers.
while IFS= read -r kernel; do
  checked=$((checked + 1))
  base="$(basename "$kernel")"
  assembled="$TMP/assembled.wgsl"

  # Rung (a): standalone.
  cp "$kernel" "$assembled"
  if validate "$assembled"; then
    echo "PASS  $base  (standalone)"
    continue
  fi

  # Rung (b): color_matrices + kernel.
  cat "$COLOR_MATRICES" "$kernel" > "$assembled"
  if validate "$assembled"; then
    echo "PASS  $base  (+color_matrices)"
    continue
  fi

  # Rung (c): color_matrices + agx_coeffs + kernel.
  cat "$COLOR_MATRICES" "$AGX_COEFFS" "$kernel" > "$assembled"
  if validate "$assembled"; then
    echo "PASS  $base  (+color_matrices+agx_coeffs)"
    continue
  fi

  # Failed every rung — a real error. Show the richest-context diagnostic.
  echo "FAIL  $base — WGSL does not validate under any header prefix:" >&2
  sed 's/^/    /' "$TMP/err" >&2
  fail=$((fail + 1))
done < <(find "$WGSL_DIR" -type f -name '*.wgsl' | sort)

echo ""
echo "check_wgsl: $checked shader module(s) checked, $fail failure(s)"
[[ "$fail" -eq 0 ]]
