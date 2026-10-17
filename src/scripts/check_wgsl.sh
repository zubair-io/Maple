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
#     * generated/local_mask_wire.wgsl — the local mask composition wire constants
#   So validating a kernel that calls `mul_rec2020_to_srgb` standalone reports a
#   false "unknown identifier". To mirror the runtime concat without hard-coding
#   a per-kernel header map (which would drift from the Rust source), each kernel
#   is validated under a LADDER of header prefixes:
#       (a) standalone
#       (b) color_matrices + kernel
#       (c) color_matrices + agx_coeffs + kernel
#       (d) color_matrices + local_mask_wire + kernel
#       (e) present_chain + kernel (display histogram shares the display quantizer)
#       (f) color_matrices + present_chain + kernel (P3-to-scRGB presentation)
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
LOCAL_MASK_WIRE="$GEN_DIR/local_mask_wire.wgsl"
for f in "$COLOR_MATRICES" "$AGX_COEFFS" "$LOCAL_MASK_WIRE"; do
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
# Every hand-written kernel plus the generated headers.
while IFS= read -r kernel; do
	# The shared HSM body has caller-owned bindings; validate it in BOTH real
	# modules below, assembled exactly like context_pipelines.rs (#4629).
	if [[ "$kernel" == "$WGSL_DIR/hue_sat_map/math.wgsl" || "$kernel" == "$WGSL_DIR/auto_exposure/common.wgsl" || "$kernel" == "$WGSL_DIR/retouch/common.wgsl" || "$kernel" == "$WGSL_DIR/bm3d_types.wgsl" ]]; then
		continue
	fi
	checked=$((checked + 1))
	base="$(basename "$kernel")"
	assembled="$TMP/assembled.wgsl"
	if [[ "$kernel" == "$WGSL_DIR/bm3d_matching.wgsl" || "$kernel" == "$WGSL_DIR/bm3d_filter.wgsl" || "$kernel" == "$WGSL_DIR/bm3d_aggregate.wgsl" ]]; then
		cat "$WGSL_DIR/generated/bm3d.wgsl" "$WGSL_DIR/bm3d_types.wgsl" "$kernel" >"$assembled"
		if validate "$assembled"; then
			echo "PASS  $base  (+BM3D constants)"
		else
			echo "FAIL  $base — assembled BM3D module does not validate:" >&2
			sed 's/^/    /' "$TMP/err" >&2
			fail=$((fail + 1))
		fi
		continue
	fi
	if [[ "$kernel" == "$WGSL_DIR/retouch/"* ]]; then
		cat "$WGSL_DIR/retouch/common.wgsl" "$kernel" >"$assembled"
		if validate "$assembled"; then
			echo "PASS  retouch/$base  (+retouch common)"
		else
			echo "FAIL  retouch/$base — assembled retouch module does not validate:" >&2
			sed 's/^/    /' "$TMP/err" >&2
			fail=$((fail + 1))
		fi
		continue
	fi
	if [[ "$kernel" == "$WGSL_DIR/auto_exposure/"* ]]; then
		cat "$COLOR_MATRICES" "$WGSL_DIR/auto_exposure/common.wgsl" "$kernel" >"$assembled"
		if validate "$assembled"; then
			echo "PASS  auto_exposure/$base  (+color_matrices+AE common)"
		else
			echo "FAIL  auto_exposure/$base — assembled AE module does not validate:" >&2
			sed 's/^/    /' "$TMP/err" >&2
			fail=$((fail + 1))
		fi
		continue
	fi
	if [[ "$base" == "hue_sat_map.wgsl" || "$base" == "dcp_colorimetry.wgsl" ]]; then
		cat "$COLOR_MATRICES" "$WGSL_DIR/hue_sat_map/math.wgsl" "$kernel" >"$assembled"
		if validate "$assembled"; then
			echo "PASS  $base  (+color_matrices+HSM math)"
		else
			echo "FAIL  $base — assembled HSM module does not validate:" >&2
			sed 's/^/    /' "$TMP/err" >&2
			fail=$((fail + 1))
		fi
		continue
	fi

	# Rung (a): standalone.
	cp "$kernel" "$assembled"
	if validate "$assembled"; then
		echo "PASS  $base  (standalone)"
		continue
	fi

	# Rung (b): color_matrices + kernel.
	cat "$COLOR_MATRICES" "$kernel" >"$assembled"
	if validate "$assembled"; then
		echo "PASS  $base  (+color_matrices)"
		continue
	fi

	# Rung (c): color_matrices + agx_coeffs + kernel.
	cat "$COLOR_MATRICES" "$AGX_COEFFS" "$kernel" >"$assembled"
	if validate "$assembled"; then
		echo "PASS  $base  (+color_matrices+agx_coeffs)"
		continue
	fi

	# Rung (d): local adjustments share the generated mask wire layout.
	cat "$COLOR_MATRICES" "$LOCAL_MASK_WIRE" "$kernel" >"$assembled"
	if validate "$assembled"; then
		echo "PASS  $base  (+color_matrices+local_mask_wire)"
		continue
	fi

	# Rung (e): display histogram shares the present shader's quantization.
	cat "$WGSL_DIR/present_chain.wgsl" "$kernel" >"$assembled"
	if validate "$assembled"; then
		echo "PASS  $base  (+present_chain)"
		continue
	fi

	# Rung (f): float presentation shares the quantizer and core color matrices.
	cat "$COLOR_MATRICES" "$WGSL_DIR/present_chain.wgsl" "$kernel" >"$assembled"
	if validate "$assembled"; then
		echo "PASS  $base  (+color_matrices+present_chain)"
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
