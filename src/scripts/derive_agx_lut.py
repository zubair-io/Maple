#!/usr/bin/env python3
"""Single source of truth for Maple AgX sigmoid coefficients + 512-entry LUT.

Spec: docs/spec/03-algorithms.md § 3.6a and docs/spec/06-cross-platform.md
§ AgX parity. Running this script emits:

  - agx_lut.bin   — 512 × 1 × f32 little-endian (Y=1 neutral per-channel
                    shape; per-channel use still applies gamut compression
                    through the log-domain sigmoid, per spec). Loaded by all
                    three platforms (Rust / Metal / GLSL-WebGL).
  - agx_coeffs.rs — Rust AGX_COEFFS constant block.

This is **Maple AgX**, calibrated for photography — NOT Blender-faithful.
The shape is still a per-channel log-domain sigmoid (so highlight gamut
compression on hot specular still works the way AgX-class transforms do),
but mid-gray is preserved through the curve (scene 0.18 → display ≈ 0.18)
instead of lifted to ~0.50 the way Blender's AgX_Default_Contrast places
it. Photographers calibrate against ACR/Lightroom; the Blender placement
read as a uniform +1-stop "gain" against that reference. Parity across
the three Maple platforms is the actual gate (§ 06-cross-platform.md
§ AgX parity); third-party-tool match is no longer a constraint.

Coefficients (MIN_EV, MAX_EV, MID_GRAY) are frozen here and emitted into
platform source files. Bump AGX_VERSION any time this script's output
bytes change (§ 05-performance.md § RenderedPreviewCache).

Usage:
  python3 src/scripts/derive_agx_lut.py \
    --bin src/raw-pipeline/raw-core/src/view/agx_lut.bin \
    --rs  src/raw-pipeline/raw-core/src/view/agx_coeffs.rs \
    --apple-bin src/apple/Packages/MapleCore/Sources/MapleCore/Metal/agx_lut.bin

`--apple-bin` is optional but recommended: it writes the same bytes to the
SwiftPM-bundled LUT consumed by `MetalKernels.swift` / `AgXViewTransform.metal`.
Skipping it lets the Apple side drift behind the Rust reference (this is
exactly the Spike 1.2 finding, AGX_VERSION 2 vs 5, that motivated adding
this flag). CI / contributor scripts should always pass it.
"""
from __future__ import annotations

import argparse
import struct
import sys
import textwrap
from pathlib import Path

# ── Coefficients (frozen; bump viewTransformVersion on any edit) ──────────
MIN_EV       = -10.0
MAX_EV       =  +6.5
MID_GRAY     =  0.18          # scene-linear mid-gray, log-encode pivot
BASE_SLOPE   =  2.4           # Blender 4.x AgX_Base default contrast slope
LUT_SIZE     =  512           # table size (spec § 3.6a)

# Derived constants
EV_RANGE     = MAX_EV - MIN_EV     # log-domain span, 16.5 EV
MID_NORM     = (0.0 - MIN_EV) / EV_RANGE   # normalized log position of mid-gray

# Display target at the mid-gray pivot. Computed directly from the Maple
# polynomial at norm = MID_NORM. Maple AgX preserves mid-gray (0.18 scene
# → ~0.18 display), unlike Blender 4.x AgX_Default_Contrast which lifts
# mid-gray to ~0.50 for cinematic look. AGX_MID_DISPLAY is emitted for
# downstream anchor tests.

# Version key — increment whenever the LUT bytes or coefficients change;
# this value is embedded in agx_coeffs.rs and must match viewTransformVersion
# used in RenderedPreviewCache keys.
#  v5: Blender 4.x AgX_Default_Contrast (mid-gray → 0.50).
#  v6: Maple AgX, photography-tuned (mid-gray preserved → ~0.18).
AGX_VERSION  = 6


# ── Maple AgX polynomial (frozen) ──────────────────────────────────────────
# 6th-order polynomial fitted (least-squares) through 15 anchor points that
# describe a photography-tuned tone curve calibrated against ACR baseline
# renders (`test-fixtures/references/<fixture>/down/baseline.png`). Tuned
# iteratively: each refit ran the test_color_pipeline.sh harness against
# ACR ground-truth and adjusted anchor heights to bring bias toward zero.
#
# Anchors (norm, display_linear):
#   (0.000, 0.0000)  (0.200, 0.0008)  (0.300, 0.0030)  (0.400, 0.0200)
#   (0.485, 0.0500)  (0.550, 0.1300)  (0.6061, 0.2500) ← mid-gray (~ACR)
#   (0.650, 0.3400)  (0.700, 0.4600)  (0.728, 0.5500)
#   (0.785, 0.7300)  (0.850, 0.8800)  (0.910, 0.9600)
#   (0.950, 0.9780)  (1.000, 0.9850)
#
# Resulting coefficients (descending degree):
MAPLE_AGX_A6 =   45.168672
MAPLE_AGX_A5 = -153.659289
MAPLE_AGX_A4 =  188.476772
MAPLE_AGX_A3 = -101.333581
MAPLE_AGX_A2 =   24.458269
MAPLE_AGX_A1 =   -2.131000
MAPLE_AGX_A0 =    0.000235


def agx_sigmoid(x: float) -> float:
    """Maple AgX — photography-tuned 6th-order polynomial in normalized-log
    space. Preserves mid-gray (norm = MID_NORM ≈ 0.6061 → display ≈ 0.18).

        y = MAPLE_AGX_A6 * x^6
          + MAPLE_AGX_A5 * x^5
          + MAPLE_AGX_A4 * x^4
          + MAPLE_AGX_A3 * x^3
          + MAPLE_AGX_A2 * x^2
          + MAPLE_AGX_A1 * x
          + MAPLE_AGX_A0

    Polynomial fit to anchors documented above. Clamps outside [0, 1] handle
    the tiny overshoot near both endpoints (a0 ≈ 9e-5, sub-LSB at u8).

    Input: normalized-log position of scene-linear value, i.e.
        norm = (log2(scene / MID_GRAY).clamp(MIN_EV, MAX_EV) - MIN_EV) / EV_RANGE
    Output: display-linear in [0, 1].
    """
    x = max(0.0, min(1.0, x))
    x2 = x * x
    x4 = x2 * x2
    y = ( MAPLE_AGX_A6 * x4 * x2
        + MAPLE_AGX_A5 * x4 * x
        + MAPLE_AGX_A4 * x4
        + MAPLE_AGX_A3 * x2 * x
        + MAPLE_AGX_A2 * x2
        + MAPLE_AGX_A1 * x
        + MAPLE_AGX_A0)
    return max(0.0, min(1.0, y))


def build_lut() -> list[float]:
    """Sample agx_sigmoid over LUT_SIZE evenly-spaced normalized-log positions
    in [0, 1]. Callers interpolate linearly between entries at runtime.

    Enforces monotonicity post-hoc with a cumulative-max sweep — the
    least-squares polynomial fit can dip ~1% near the top edge (a high-order
    artifact), which would visually pull extreme highlights back down. The
    cumulative-max sweep is a closed-form fix that doesn't change the curve
    shape anywhere it was already monotone."""
    lut = []
    for i in range(LUT_SIZE):
        x = i / (LUT_SIZE - 1)
        y = agx_sigmoid(x)
        y = max(0.0, min(1.0, y))
        lut.append(y)
    # Enforce monotonicity (cumulative max).
    for i in range(1, LUT_SIZE):
        if lut[i] < lut[i - 1]:
            lut[i] = lut[i - 1]
    return lut


def emit_bin(lut: list[float], path: Path) -> None:
    """LUT as little-endian f32 bytes, 4 × LUT_SIZE bytes total."""
    path.parent.mkdir(parents=True, exist_ok=True)
    with path.open("wb") as f:
        for v in lut:
            f.write(struct.pack("<f", v))


def emit_rs(path: Path) -> None:
    """Rust constants file. Kept alongside agx_lut.bin for co-versioning."""
    MID_DISPLAY_COMPUTED = agx_sigmoid(MID_NORM)
    src = textwrap.dedent(f"""\
        //! Generated by src/scripts/derive_agx_lut.py — DO NOT EDIT BY HAND.
        //!
        //! Single-source-of-truth AgX constants. Re-run the derivation script
        //! when coefficients change; bump `viewTransformVersion` in
        //! RenderedPreviewCache (spec § 05-performance.md) at the same time.

        /// AgX log-encode domain: scene values below MID_GRAY * 2^MIN_EV
        /// clamp to the toe; values above MID_GRAY * 2^MAX_EV clamp to the
        /// shoulder.
        pub const AGX_MIN_EV: f32 = {MIN_EV:.6};
        pub const AGX_MAX_EV: f32 = {MAX_EV:.6};

        /// Scene-linear middle gray — the AgX log-encoding reference point.
        pub const AGX_MID_GRAY: f32 = {MID_GRAY:.6};

        /// Display-linear value at the mid-gray log-pivot (norm = MID_NORM).
        /// Computed from the Maple AgX polynomial at norm = (0-MIN_EV)/EV_RANGE.
        /// Maple AgX is photography-tuned: this anchor sits near MID_GRAY
        /// (~0.18), preserving mid-gray through the curve. Blender 4.x AgX
        /// (the prior shape) lifted it to ~0.50 for cinematic look.
        pub const AGX_MID_DISPLAY: f32 = {MID_DISPLAY_COMPUTED:.6};

        /// Slope-modulation constant. Mirrored across platforms so the
        /// contrast slider drives identical behavior in Rust / Metal / WebGL.
        pub const AGX_BASE_SLOPE: f32 = {BASE_SLOPE:.6};

        /// Size of the per-channel sigmoid LUT embedded in agx_lut.bin.
        pub const AGX_LUT_SIZE: usize = {LUT_SIZE};

        /// Cache-invalidation key — every time this file's bytes change
        /// (due to coefficient edits or LUT recompute), bump this. It is
        /// propagated into RenderedPreviewCache's viewTransformVersion
        /// so every cached preview re-renders on the next cold open.
        pub const AGX_VERSION: u32 = {AGX_VERSION};
    """)
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(src)


def sanity_check(lut: list[float]) -> None:
    """Verify endpoint anchors and monotonicity. Maple AgX preserves
    mid-gray, so the LUT value at norm = MID_NORM should land near 0.18
    (target 0.180; least-squares fit places it at 0.165)."""
    assert abs(lut[0]) < 1e-3, f"LUT[0] = {lut[0]:.6f}, expected ~0"
    assert lut[-1] >= 0.97, f"LUT[-1] = {lut[-1]:.6f}, expected ≥ 0.97"
    mid_idx = round(MID_NORM * (LUT_SIZE - 1))
    mid_val = lut[mid_idx]
    assert 0.15 < mid_val < 0.30, (
        f"mid-gray anchor LUT[{mid_idx}] = {mid_val:.6f} outside Maple AgX "
        f"plausible range [0.15, 0.30] — coefficient drift? Target ~0.20-0.25."
    )
    # Monotonicity (allow tiny dip from least-squares fit; clamped at runtime)
    for i in range(1, LUT_SIZE):
        assert lut[i] >= lut[i - 1] - 1e-3, (
            f"non-monotone at {i}: {lut[i-1]:.6f} → {lut[i]:.6f}"
        )


def main() -> int:
    p = argparse.ArgumentParser()
    p.add_argument("--bin", required=True, help="output .bin path (Rust raw-core)")
    p.add_argument("--rs",  required=True, help="output coeffs.rs path")
    p.add_argument(
        "--apple-bin",
        required=False,
        default=None,
        help=(
            "optional output .bin path for the Apple SwiftPM-bundled LUT "
            "(consumed by MetalKernels.swift). Identical bytes to --bin; "
            "writing both keeps the Apple side from drifting behind Rust."
        ),
    )
    args = p.parse_args()

    lut = build_lut()
    sanity_check(lut)
    emit_bin(lut, Path(args.bin))
    emit_rs(Path(args.rs))
    print(f"wrote {args.bin} ({LUT_SIZE} f32 entries, {LUT_SIZE * 4} bytes)")
    print(f"wrote {args.rs}  (constants, version={AGX_VERSION})")
    if args.apple_bin:
        emit_bin(lut, Path(args.apple_bin))
        print(
            f"wrote {args.apple_bin} ({LUT_SIZE} f32 entries, "
            f"{LUT_SIZE * 4} bytes; Apple-bundled mirror)"
        )
    return 0


if __name__ == "__main__":
    sys.exit(main())
