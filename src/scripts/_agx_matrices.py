#!/usr/bin/env python3
"""Chromaticity → RGB matrix helpers for the AgX inset/outset derivation.

Split out of `derive_agx_lut.py` to keep that file under the file-size
headroom gate (tools/check-budget-headroom.sh), following the same precedent
as `_agx_emit.py` (#924). This is a **leaf** module — stdlib only, no
back-import of `derive_agx_lut` — so the script run (`derive_agx_lut.py` as
`__main__`) cannot hit a partially-initialized circular import.

Pure linear algebra over chromaticities: no AgX constants live here. The AgX
primaries, the compression factor and `derive_inset_outset()` itself stay in
`derive_agx_lut`, which calls into these helpers. Every function is unchanged
from its pre-split form, so the emitted matrices are byte-for-byte identical.
"""

from __future__ import annotations

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
