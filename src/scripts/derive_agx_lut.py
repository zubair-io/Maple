#!/usr/bin/env python3
"""Single source of truth for Maple AgX matrices + sigmoid + 512-entry LUT.

Spec: docs/spec/03-algorithms.md § 3.6a and docs/spec/06-cross-platform.md
§ AgX parity. Running this script emits:

  - agx_lut.bin   — 512 × 1 × f32 little-endian (per-channel sigmoid on
                    normalized-log values; the inset/outset matrices live
                    in agx_coeffs.rs and are applied around this LUT).
                    Loaded by Rust and Apple-bundled for Metal/CI parity.
  - agx_coeffs.rs — Rust constants: AGX_MIN_EV/MAX_EV/MID_GRAY/X_PIVOT/
                    Y_PIVOT/SLOPE/TOE_POWER/SHOULDER_POWER, the INSET and
                    OUTSET 3×3 matrices, LUT size, and AGX_VERSION.

This is **canonical Sobotka AgX**, Rec.2020-targeted, photography-tuned.
The pipeline is:

    scene-linear Rec.2020
        → INSET matrix (Rec.2020 → AgX-Base-Rec.2020). The AgX-Base
          chromaticities are obtained by pushing each primary AWAY from
          D65 along its (primary − white) ray by a factor of
          1 / (1 − 0.20) = 1.25 (i.e. the chromaticity gamut expands
          by 25%). Because AgX-Base then encloses a wider triangle than
          Rec.2020, the Rec.2020 → AgX-Base RGB→RGB matrix is a
          *desaturating* (per-channel) transform on saturated inputs —
          which is the inset behaviour the AgX pipeline wants. Mirrors
          `AgX.AgX_compressed_matrix(0.20)` in
          https://github.com/sobotka/AgX-S2O3/blob/main/AgX.py L17-50.
        → per-channel log2-encode + normalize (MIN_EV=-10, MAX_EV=+6.5,
          MID_GRAY=0.18) — Sobotka `open_domain_to_normalized_log2`
        → per-channel Jed Smith sigmoid `equation_full_curve(x, x_pivot,
          y_pivot, slope, [toe_power, shoulder_power])` (AgX-S2O3 AgX.py
          L122-L207). Coefficients:
            x_pivot = |MIN_EV| / (MAX_EV - MIN_EV) ≈ 0.6060606
            y_pivot = 0.18                        (Maple photography-tuned;
                                                    Sobotka cinematic = 0.50)
            slope   = 2.4                         (Maple — Sobotka uses 2.0
                                                    but that's infeasible
                                                    with y_pivot=0.18, see
                                                    feasibility note below)
            toe_power      = 3.0                  (Sobotka default)
            shoulder_power = 3.25                 (Sobotka default)
        → OUTSET matrix (AgX-Base-Rec.2020 → Rec.2020; numerical inverse
          of INSET)
        → clamp to [0, 1]

The INSET and OUTSET matrices preserve neutral RGB triples exactly (both
have row sums of 1.0), so a 0.18 scene-linear neutral maps to a 0.18
display-linear neutral within numerical precision. This is the key
mid-gray invariant — see `sanity_check()`.

**Feasibility note for slope choice.** Jed Smith's full curve requires
slope > max(y_pivot/x_pivot, (1-y_pivot)/(1-x_pivot)) for the scale
equation to have a real solution. With x_pivot=0.6061 and y_pivot=0.18:

    toe-side min slope:      0.180 / 0.6061   = 0.297
    shoulder-side min slope: 0.820 / 0.3939   = 2.082

So slope=2.0 (Sobotka's default for y_pivot=0.50) is infeasible at
y_pivot=0.18, producing NaN at the pivot. slope=2.4 sits comfortably
above the 2.08 threshold and is the photography-tuned slope Maple has
shipped since AGX_VERSION 5.

Usage:
  python3 src/scripts/derive_agx_lut.py \
    --bin src/raw-pipeline/raw-core/src/view/agx_lut.bin \
    --rs  src/raw-pipeline/raw-core/src/view/agx_coeffs.rs \
    --apple-bin src/apple/Packages/MapleCore/Sources/MapleCore/Metal/agx_lut.bin

`--apple-bin` is optional but recommended: it writes the same bytes to the
SwiftPM-bundled LUT consumed by `MetalKernels.swift` / Apple parity tests.
"""
from __future__ import annotations

import argparse
import struct
import sys
import textwrap
from pathlib import Path

# WGSL emitter lives in a sibling leaf module to keep this file under the
# file-size budget (tools/check-file-budget.sh; split precedent #924). The
# import is one-directional (`_agx_emit` imports no symbols back from here),
# so the script run as `__main__` can't trip a circular import. Re-exported
# below so any external `derive_agx_lut.emit_wgsl` reference still resolves.
from _agx_emit import emit_wgsl  # noqa: E402  (kept with the other imports)

# ── Frozen coefficients (bump AGX_VERSION on any edit) ────────────────────
MIN_EV       = -10.0
MAX_EV       =  +6.5
MID_GRAY     =  0.18          # scene-linear mid-gray, log-encode pivot
LUT_SIZE     =  512           # table size (spec § 3.6a)

# Sigmoid parameters (Jed Smith equation_full_curve)
EV_RANGE     = MAX_EV - MIN_EV                     # 16.5
X_PIVOT      = abs(MIN_EV) / EV_RANGE              # ≈ 0.6060606
Y_PIVOT      = 0.18                                # Maple photography-tuned
SLOPE        = 2.4                                 # see feasibility note in docstring
TOE_POWER    = 3.0                                 # Sobotka default
SHOULDER_POWER = 3.25                              # Sobotka default

# Inset compression (Sobotka AgX.py L17-50 `AgX_compressed_matrix`).
# 0.20 = primaries pushed away from D65 by scale 1/(1-0.20) = 1.25 along
# the (primary - white) ray in CIE xy — the chromaticity triangle widens
# by 25%. Used as an inset matrix (Rec.2020 → AgX-Base-Rec.2020), this
# desaturates saturated Rec.2020 inputs because they're no longer at the
# corners of the wider AgX-Base triangle. Matches AgX-S2O3 default.
COMPRESSION  = 0.20

# Version key. Bump whenever the LUT bytes or coefficients change.
#  v5: Blender 4.x AgX_Default_Contrast polynomial fit (mid-gray → 0.50).
#  v6: Maple AgX 6th-order polynomial fit (mid-gray → 0.237, ~8% high).
#  v7: Canonical Sobotka AgX with Rec.2020 inset/outset matrices + real
#      Jed Smith sigmoid (#263). Mid-gray scene 0.18 → display 0.18 exact.
#  v8: Cache-bust only — no LUT/coefficient change from v7. Aligns this
#      generator to the value already shipped in agx_coeffs.rs (the .rs
#      had been bumped to 8 without bumping the generator, so a regen
#      would otherwise downgrade the live RenderedPreviewCache key).
AGX_VERSION  = 8


# ── Sobotka / Jed Smith sigmoid (port of AgX-S2O3 AgX.py L122-L207) ───────
# Pure float implementation — no numpy at runtime so the LUT generation is
# byte-deterministic across Python implementations.
def _equation_scale(x_pivot: float, y_pivot: float, slope: float, power: float) -> float:
    """Sobotka AgX.py `equation_scale`."""
    return (
        ((slope * x_pivot) ** -power)
        * (((slope * (x_pivot / y_pivot)) ** power) - 1.0)
    ) ** (-1.0 / power)


def _equation_hyperbolic(x: float, power: float) -> float:
    """Sobotka AgX.py `equation_hyperbolic`."""
    return x / ((1.0 + x ** power) ** (1.0 / power))


def _equation_term(x: float, x_pivot: float, slope: float, scale: float) -> float:
    """Sobotka AgX.py `equation_term`."""
    return (slope * (x - x_pivot)) / scale


def agx_sigmoid(x: float) -> float:
    """Jed Smith / Sobotka tunable sigmoid; the real AgX sigmoid (no fit).

    Input  `x`: normalized-log position in [0, 1]
    Output `y`: display-linear value (typically [0, 1], may slightly exceed
                this near the endpoints — caller clamps).
    """
    x = max(0.0, min(1.0, x))
    if x >= X_PIVOT:
        # Shoulder side: scale based on the distance from pivot to 1.
        sx = 1.0 - X_PIVOT
        sy = 1.0 - Y_PIVOT
        side_power = SHOULDER_POWER
        scale = _equation_scale(sx, sy, SLOPE, side_power)
    else:
        # Toe side: scale based on the distance from pivot to 0.
        sx = X_PIVOT
        sy = Y_PIVOT
        side_power = TOE_POWER
        scale = -_equation_scale(sx, sy, SLOPE, side_power)
    term = _equation_term(x, X_PIVOT, SLOPE, scale)
    return scale * _equation_hyperbolic(term, side_power) + Y_PIVOT


# ── Inset / outset matrix derivation (Rec.2020 primaries, D65 white) ──────
# Sobotka's AgX_compressed_matrix is sRGB-by-default; we apply the same
# construction to Rec.2020 primaries so Maple's working space (linear
# Rec.2020 D65) flows through AgX without an intermediate gamut conversion.

REC2020_PRIMARIES = (   # (x, y) chromaticities
    (0.708, 0.292),     # R
    (0.170, 0.797),     # G
    (0.131, 0.046),     # B
)
D65_WHITE = (0.3127, 0.3290)


def _xy_to_XYZ(xy: tuple[float, float], Y: float = 1.0) -> tuple[float, float, float]:
    x, y = xy
    return (x / y * Y, Y, (1.0 - x - y) / y * Y)


def _mat3_mul(A: list[list[float]], B: list[list[float]]) -> list[list[float]]:
    return [
        [sum(A[i][k] * B[k][j] for k in range(3)) for j in range(3)]
        for i in range(3)
    ]


def _mat3_inv(M: list[list[float]]) -> list[list[float]]:
    """3×3 matrix inverse via cofactor expansion. Inputs come from
    `_rgb_to_xyz_matrix` (well-conditioned), so we don't bother with
    pivoting."""
    a, b, c = M[0]
    d, e, f = M[1]
    g, h, i = M[2]
    det = a * (e * i - f * h) - b * (d * i - f * g) + c * (d * h - e * g)
    inv_det = 1.0 / det
    return [
        [ (e * i - f * h) * inv_det, -(b * i - c * h) * inv_det,  (b * f - c * e) * inv_det],
        [-(d * i - f * g) * inv_det,  (a * i - c * g) * inv_det, -(a * f - c * d) * inv_det],
        [ (d * h - e * g) * inv_det, -(a * h - b * g) * inv_det,  (a * e - b * d) * inv_det],
    ]


def _rgb_to_xyz_matrix(primaries: tuple, whitepoint: tuple) -> list[list[float]]:
    """Build RGB→XYZ matrix from primaries + whitepoint (D65)."""
    # Columns: each primary's (x, y) lifted to (X, 1, Z).
    M = [[0.0, 0.0, 0.0] for _ in range(3)]
    XYZs = [_xy_to_XYZ(p, Y=1.0) for p in primaries]
    for col, xyz in enumerate(XYZs):
        for row in range(3):
            M[row][col] = xyz[row]
    # Scale columns so M @ [1,1,1]^T = whitepoint XYZ.
    W = _xy_to_XYZ(whitepoint, Y=1.0)
    M_inv = _mat3_inv(M)
    S = [sum(M_inv[i][j] * W[j] for j in range(3)) for i in range(3)]
    # Scale each column j by S[j].
    return [[M[i][j] * S[j] for j in range(3)] for i in range(3)]


def _matrix_rgb_to_rgb(src_primaries, src_white, dst_primaries, dst_white) -> list[list[float]]:
    """src RGB → dst RGB via XYZ. Both whitepoints assumed D65 (no CAT)."""
    M_src = _rgb_to_xyz_matrix(src_primaries, src_white)
    M_dst = _rgb_to_xyz_matrix(dst_primaries, dst_white)
    return _mat3_mul(_mat3_inv(M_dst), M_src)


def _agx_compressed_primaries(primaries, whitepoint, compression=0.20):
    """Sobotka AgX.py `AgX_compressed_matrix`: push primaries AWAY from
    the whitepoint by `scale = 1 / (1 - compression)` along the
    (primary − white) chromaticity ray. With `compression = 0.20`,
    `scale = 1.25` — the chromaticity gamut widens by 25%. When this
    wider colourspace is used as an *inset* target (Rec.2020 →
    AgX-Base-Rec.2020), the Rec.2020 → AgX-Base RGB→RGB matrix is a
    per-channel *desaturating* transform on saturated inputs, which is
    the AgX behaviour we want before the sigmoid.
    """
    wx, wy = whitepoint
    scale = 1.0 / (1.0 - compression)
    return tuple(
        ((px - wx) * scale + wx, (py - wy) * scale + wy)
        for (px, py) in primaries
    )


def derive_inset_outset() -> tuple[list[list[float]], list[list[float]]]:
    """Compute INSET (Rec.2020 → AgX-Base-Rec.2020) and OUTSET (inverse)."""
    compressed = _agx_compressed_primaries(REC2020_PRIMARIES, D65_WHITE, COMPRESSION)
    inset = _matrix_rgb_to_rgb(REC2020_PRIMARIES, D65_WHITE, compressed, D65_WHITE)
    outset = _mat3_inv(inset)
    return inset, outset


# ── LUT generation ────────────────────────────────────────────────────────
def build_lut() -> list[float]:
    """Sample agx_sigmoid over LUT_SIZE evenly-spaced normalized-log positions
    in [0, 1]. Callers interpolate linearly between entries at runtime."""
    lut = []
    for i in range(LUT_SIZE):
        x = i / (LUT_SIZE - 1)
        y = agx_sigmoid(x)
        # Clamp to [0, 1]: the analytic Jed Smith sigmoid can land a few
        # ULPs outside the unit interval near the endpoints due to fp
        # rounding (and AgX's `Y_PIVOT + scale * hyperbolic` form has
        # no hard upper anchor). The Rust runtime's `sample_lut` and the
        # GLSL fragment both clamp post-outset, so storing pre-clamped
        # LUT bytes keeps the LUT itself within the [0, 1] contract that
        # `lut_anchors_are_zero_and_near_one` (agx.rs) asserts.
        lut.append(max(0.0, min(1.0, y)))
    # The Jed Smith sigmoid is analytically monotone; this is just an
    # in-case-of-fp-rounding cumulative-max sweep.
    for i in range(1, LUT_SIZE):
        if lut[i] < lut[i - 1]:
            lut[i] = lut[i - 1]
    return lut


def emit_bin(lut: list[float], path: Path) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    with path.open("wb") as f:
        for v in lut:
            f.write(struct.pack("<f", v))


def emit_rs(path: Path) -> None:
    """Rust constants file. Kept alongside agx_lut.bin for co-versioning."""
    inset, outset = derive_inset_outset()
    mid_norm = (0.0 - MIN_EV) / EV_RANGE
    # AGX_MID_DISPLAY = sigmoid at the mid-gray pivot; with Y_PIVOT=0.18
    # this is exactly 0.18 by construction.
    mid_display_norm = agx_sigmoid(mid_norm)

    def fmt_row(row):
        return ", ".join(f"{v: .15e}_f32" for v in row)

    def fmt_matrix_block(name: str, M, doc: str) -> str:
        body = ",\n    ".join(f"[{fmt_row(r)}]" for r in M)
        return (
            f"/// {doc}\n"
            f"#[rustfmt::skip]\n"
            f"pub const {name}: [[f32; 3]; 3] = [\n"
            f"    {body},\n"
            f"];\n"
        )

    inset_doc = (
        "Inset matrix: scene-linear Rec.2020 → AgX-Base-Rec.2020. The "
        "AgX-Base primaries are constructed by pushing each Rec.2020 "
        "primary AWAY from D65 by scale 1/(1-0.20) = 1.25 along the "
        "(primary - white) chromaticity ray (the gamut triangle widens "
        "by 25%); the resulting Rec.2020 -> AgX-Base RGB->RGB transform "
        "is per-channel desaturating on saturated inputs, which is the "
        "AgX inset behaviour. Computed by "
        "`src/scripts/derive_agx_lut.py::derive_inset_outset()`; "
        "construction mirrors `AgX_compressed_matrix(compression=0.20)` "
        "in https://github.com/sobotka/AgX-S2O3/blob/main/AgX.py L17-50. "
        "Row sums are 1.0 (numerically), so neutral triples pass through "
        "the inset unchanged — load-bearing for mid-gray preservation."
    )
    outset_doc = (
        "Outset matrix: numerical inverse of `AGX_INSET_MATRIX`. Applied "
        "after the per-channel sigmoid LUT to map back from AgX-Base-Rec.2020 "
        "to scene-linear Rec.2020 primaries (restoring chroma the inset "
        "compressed). Row sums are 1.0 — neutrals unchanged."
    )

    src = (
        "//! Generated by src/scripts/derive_agx_lut.py — DO NOT EDIT BY HAND.\n"
        "//!\n"
        "//! Canonical Sobotka AgX constants for the Rust raw-core view\n"
        "//! transform. The pipeline is:\n"
        "//!\n"
        "//! ```text\n"
        "//!     scene-linear Rec.2020\n"
        "//!         → AGX_INSET_MATRIX\n"
        "//!         → per-channel log2 encode + normalize\n"
        "//!         → ratio-preserving sigmoid: the sigmoid LUT (agx_lut.bin)\n"
        "//!           is evaluated on max(R,G,B), then RGB is scaled by\n"
        "//!           sigmoid_norm / norm so hue is invariant (post-#435)\n"
        "//!         → AGX_OUTSET_MATRIX\n"
        "//!         → Oklab hue-preserving gamut compression to [0, 1] =\n"
        "//!           display-linear Rec.2020\n"
        "//! ```\n"
        "//!\n"
        "//! Re-run the derivation script when coefficients change; bump\n"
        "//! `viewTransformVersion` in RenderedPreviewCache (spec\n"
        "//! § 05-performance.md) at the same time.\n"
        "\n"
        "/// AgX log-encode domain: scene values below MID_GRAY * 2^MIN_EV\n"
        "/// clamp to the toe; values above MID_GRAY * 2^MAX_EV clamp to the\n"
        "/// shoulder.\n"
        f"pub const AGX_MIN_EV: f32 = {MIN_EV:.6};\n"
        f"pub const AGX_MAX_EV: f32 = {MAX_EV:.6};\n"
        "\n"
        "/// Scene-linear middle gray — the AgX log-encoding reference point.\n"
        f"pub const AGX_MID_GRAY: f32 = {MID_GRAY:.6};\n"
        "\n"
        "/// Display-linear value at the mid-gray log pivot. With Y_PIVOT\n"
        "/// set to MID_GRAY (Maple photography-tuned), this is 0.18 exactly:\n"
        "/// scene 0.18 → display 0.18 along the neutral axis.\n"
        f"pub const AGX_MID_DISPLAY: f32 = {mid_display_norm:.6};\n"
        "\n"
        "/// Jed Smith / Sobotka sigmoid pivot in normalized-log space.\n"
        "/// `AGX_X_PIVOT = |MIN_EV| / (MAX_EV - MIN_EV)` so the pivot sits\n"
        "/// exactly at scene-linear mid-gray on the log axis.\n"
        f"pub const AGX_X_PIVOT: f32 = {X_PIVOT:.10};\n"
        "\n"
        "/// Sigmoid pivot in display-linear space. Maple sets this to\n"
        "/// `AGX_MID_GRAY` to preserve mid-gray through the curve. Sobotka's\n"
        "/// cinematic default is 0.50.\n"
        f"pub const AGX_Y_PIVOT: f32 = {Y_PIVOT:.6};\n"
        "\n"
        "/// Slope at the pivot (Jed Smith `slope_pivot`). Sobotka's AgX-S2O3\n"
        "/// default is 2.0, but the Jed Smith scale equation requires\n"
        "/// slope > (1 - Y_PIVOT) / (1 - X_PIVOT) ≈ 2.08 with Y_PIVOT=0.18,\n"
        "/// so 2.4 is the smallest slope that produces a real sigmoid at\n"
        "/// the chosen pivot. Photography-tuned.\n"
        f"pub const AGX_BASE_SLOPE: f32 = {SLOPE:.6};\n"
        "\n"
        "/// Toe / shoulder powers in the Jed Smith sigmoid (Sobotka\n"
        "/// AgX-S2O3 defaults: `limits_contrast=[3.0, 3.25]`).\n"
        f"pub const AGX_TOE_POWER: f32 = {TOE_POWER:.6};\n"
        f"pub const AGX_SHOULDER_POWER: f32 = {SHOULDER_POWER:.6};\n"
        "\n"
        "/// Size of the per-channel sigmoid LUT embedded in agx_lut.bin.\n"
        f"pub const AGX_LUT_SIZE: usize = {LUT_SIZE};\n"
        "\n"
        f"{fmt_matrix_block('AGX_INSET_MATRIX', inset, inset_doc)}"
        "\n"
        f"{fmt_matrix_block('AGX_OUTSET_MATRIX', outset, outset_doc)}"
        "\n"
        "/// Cache-invalidation key — every time this file's bytes change\n"
        "/// (due to coefficient edits or LUT recompute), bump this. It is\n"
        "/// propagated into RenderedPreviewCache's viewTransformVersion\n"
        "/// so every cached preview re-renders on the next cold open.\n"
        f"pub const AGX_VERSION: u32 = {AGX_VERSION};\n"
    )
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(src)


# ── WGSL emitter (epic #925 P2 / #990) ────────────────────────────────────
# `emit_wgsl` (the matrices + log-encode scalars baked into raw-gpu's AgX
# kernel) was moved to the sibling leaf module `_agx_emit.py` to keep this
# file under the file-size budget — see the import near the top. The single
# source of truth for the coefficients stays here; `emit_wgsl` is fed the
# constants + the derived inset/outset matrices at the call site in `main`.


# ── Sanity checks ─────────────────────────────────────────────────────────
def _apply_matrix(M: list[list[float]], v: tuple) -> list[float]:
    return [sum(M[i][j] * v[j] for j in range(3)) for i in range(3)]


def _open_domain_to_normalized_log2(x: float) -> float:
    """Mirror of Sobotka AgX.py `open_domain_to_normalized_log2`."""
    import math
    if x <= 0.0:
        x = 2.2250738585072014e-308  # numpy.finfo(float).eps surrogate
    log_v = math.log2(x / MID_GRAY)
    log_v = max(MIN_EV, min(MAX_EV, log_v))
    return (log_v - MIN_EV) / EV_RANGE


def sanity_check(lut: list[float]) -> None:
    """Confirm load-bearing invariants before writing the LUT to disk."""
    # 1. Endpoint anchors.
    assert abs(lut[0]) < 1e-3, f"LUT[0] = {lut[0]:.6f}, expected ~0"
    assert lut[-1] >= 0.97, f"LUT[-1] = {lut[-1]:.6f}, expected ≥ 0.97"

    # 2. Sigmoid value at the X pivot must equal Y_PIVOT (= MID_GRAY = 0.18)
    #    within fp tolerance. This is the load-bearing claim of the new
    #    pipeline — without it, scene 0.18 won't land at display 0.18.
    sig_at_pivot = agx_sigmoid(X_PIVOT)
    assert abs(sig_at_pivot - Y_PIVOT) < 1e-9, (
        f"sigmoid(X_PIVOT={X_PIVOT:.6f}) = {sig_at_pivot:.10f}, "
        f"expected Y_PIVOT={Y_PIVOT}. Sigmoid feasibility broken?"
    )

    # 3. Full-pipeline mid-gray invariant: scene 0.18 neutral → display 0.18
    #    neutral within 1e-3 (the ticket's acceptance bar).
    inset, outset = derive_inset_outset()
    mid_in = (MID_GRAY, MID_GRAY, MID_GRAY)
    inset_out = _apply_matrix(inset, mid_in)
    log_norm = [_open_domain_to_normalized_log2(c) for c in inset_out]
    sig_out = [agx_sigmoid(x) for x in log_norm]
    final = _apply_matrix(outset, tuple(sig_out))
    for c in final:
        assert abs(c - MID_GRAY) < 1e-3, (
            f"mid-gray invariant failed: scene 0.18 → display {final}, "
            f"want ~0.18 (channel diff {abs(c - MID_GRAY):.6e} ≥ 1e-3)"
        )

    # 4. Monotonicity (cumulative max is applied in build_lut; just verify).
    for i in range(1, LUT_SIZE):
        assert lut[i] >= lut[i - 1] - 1e-9, (
            f"non-monotone LUT at {i}: {lut[i-1]:.6f} → {lut[i]:.6f}"
        )

    # 5. INSET / OUTSET row-sum = 1 (neutral preservation). This is *the*
    #    structural guarantee that makes neutral mid-gray map to neutral
    #    mid-gray; if it ever fails, the matrix construction broke.
    for name, M in (("INSET", inset), ("OUTSET", outset)):
        for row_idx, row in enumerate(M):
            s = sum(row)
            assert abs(s - 1.0) < 1e-9, (
                f"{name} row {row_idx} sum = {s:.10f}, expected 1.0 "
                "(neutral preservation broken)"
            )


def main() -> int:
    p = argparse.ArgumentParser()
    # All output targets are optional so callers can emit a subset (e.g.
    # tools/codegen.sh emits ONLY --wgsl: the Rust .rs / .bin / Apple .bin are
    # intentionally left to the existing AgX-derivation workflow — see the
    # codegen.sh note). At least one output flag is required (checked below).
    p.add_argument("--bin", default=None, help="output .bin path (Rust raw-core)")
    p.add_argument("--rs",  default=None, help="output coeffs.rs path")
    p.add_argument(
        "--apple-bin",
        required=False,
        default=None,
        help=(
            "optional output .bin path for the Apple SwiftPM-bundled LUT "
            "(consumed by parity tests). Identical bytes to --bin; writing "
            "both keeps the Apple side from drifting behind Rust."
        ),
    )
    p.add_argument(
        "--wgsl",
        required=False,
        default=None,
        help=(
            "optional output .wgsl path for the raw-gpu AgX kernel constants "
            "(inset/outset matrices + log-encode scalars). The SAME "
            "coefficients as --rs; rides the codegen-drift gate via "
            "tools/codegen.sh. The sigmoid LUT is uploaded from --bin at "
            "runtime, not baked into this WGSL."
        ),
    )
    args = p.parse_args()

    if not (args.bin or args.rs or args.wgsl or args.apple_bin):
        p.error("nothing to do: pass at least one of --bin/--rs/--wgsl/--apple-bin")

    # The LUT is only needed for the .bin / Apple-.bin outputs; the .rs and
    # .wgsl emitters derive matrices + scalars directly. Build it lazily so a
    # WGSL-only run (codegen.sh) still runs the sanity_check invariants.
    lut = build_lut()
    sanity_check(lut)
    if args.bin:
        emit_bin(lut, Path(args.bin))
        print(f"wrote {args.bin} ({LUT_SIZE} f32 entries, {LUT_SIZE * 4} bytes)")
    if args.rs:
        emit_rs(Path(args.rs))
        print(f"wrote {args.rs}  (constants, version={AGX_VERSION})")
    if args.wgsl:
        inset, outset = derive_inset_outset()
        emit_wgsl(
            Path(args.wgsl),
            MIN_EV=MIN_EV,
            MAX_EV=MAX_EV,
            MID_GRAY=MID_GRAY,
            EV_RANGE=EV_RANGE,
            LUT_SIZE=LUT_SIZE,
            inset=inset,
            outset=outset,
        )
        print(f"wrote {args.wgsl} (raw-gpu AgX matrices + scalars)")
    if args.apple_bin:
        emit_bin(lut, Path(args.apple_bin))
        print(
            f"wrote {args.apple_bin} ({LUT_SIZE} f32 entries, "
            f"{LUT_SIZE * 4} bytes; Apple-bundled mirror)"
        )
    return 0


if __name__ == "__main__":
    sys.exit(main())
