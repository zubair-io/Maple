// MaskRemap.swift — re-expressing a layer stack's geometric masks in a
// render buffer's coordinate space (#355).
//
// `MaskAffine` is the exact map `p = M p′ + o` from a buffer's normalized
// point `p′` to the full-frame point `p` raw-core evaluates masks at.
// `remappedGeometry` rewrites each linear / radial layer so that evaluating
// the remapped mask at `p′` gives the SAME weight the original gives at
// `p`. Both shapes survive an arbitrary affine map exactly:
//
// - A linear gradient's weight is a smoothstep of the parametric position
//   `t = ((p − start) · D) / |D|²`. Under `p = M p′ + o` that is still linear
//   in `p′`, so the remapped gradient has `start′ = M⁻¹(start − o)` and
//   `D′ = Mᵀ D · |D|² / |Mᵀ D|²` (feather is in `t` units and is unchanged).
// - A radial mask's weight is a function of the quadratic form
//   `|S R(−α) (p − c)|²`. Under the same substitution the form becomes
//   `(p′ − c′)ᵀ G (p′ − c′)` with `G = Nᵀ N`, `N = S R(−α) M`; diagonalising
//   the symmetric 2×2 `G` gives the remapped angle and radii (feather is a
//   fraction of the radius in that normalized distance and is unchanged).
//
// `.everywhere` weighs 1 at every point and passes through untouched, as
// does a `RangeRefinement` (a per-pixel colour gate, not geometry). A
// `.bitmap` layer's weight is a raster, not a parameter set — its remap is
// a resampled raster, owned by `MaskRemapRasterCache` and applied by
// `EditSession.remappedLocalAdjustments`; this file leaves it in place.

import Foundation

public enum MaskRemap {
    /// `layers` with every linear / radial mask re-expressed in the space
    /// `affine` maps back to the full frame. Returns `layers` unchanged for
    /// the identity map, so the uncropped whole-frame case costs one
    /// predicate and allocates nothing.
    public static func remappedGeometry(
        _ layers: [LocalAdjustment], through affine: MaskAffine
    ) -> [LocalAdjustment] {
        guard !affine.isIdentity, !layers.isEmpty, let inverse = affine.inverted() else { return layers }
        return layers.map { layer in
            var out = layer
            out.mask = remap(layer.mask, bufferToFull: affine, fullToBuffer: inverse)
            return out
        }
    }

    /// One mask through the map — see the file header for the derivation.
    static func remap(_ mask: LocalMask, bufferToFull m: MaskAffine, fullToBuffer inverse: MaskAffine) -> LocalMask {
        switch mask {
        case .linear(let start, let end, let feather):
            let direction = MaskPoint(x: end.x - start.x, y: end.y - start.y)
            let mapped = m.transposeApplied(direction)
            let mappedLenSq = mapped.x * mapped.x + mapped.y * mapped.y
            guard mappedLenSq > 1e-18 else { return mask }
            let k = (direction.x * direction.x + direction.y * direction.y) / mappedLenSq
            let start2 = inverse.apply(start)
            return .linear(
                start: start2,
                end: MaskPoint(x: start2.x + k * mapped.x, y: start2.y + k * mapped.y),
                feather: feather)
        case .radial(let center, let radii, let angle, let feather, let invert):
            guard abs(radii.x) > 1e-9, abs(radii.y) > 1e-9 else { return mask }
            let cosA = cos(angle)
            let sinA = sin(angle)
            // N = S · R(−α) · M, row by row (R(−α) = [[cos, sin], [−sin, cos]]).
            let n00 = (cosA * m.a + sinA * m.b) / radii.x
            let n01 = (cosA * m.c + sinA * m.d) / radii.x
            let n10 = (-sinA * m.a + cosA * m.b) / radii.y
            let n11 = (-sinA * m.c + cosA * m.d) / radii.y
            let g11 = n00 * n00 + n10 * n10
            let g12 = n00 * n01 + n10 * n11
            let g22 = n01 * n01 + n11 * n11
            // Eigen-decompose the symmetric form: the principal axis angle
            // and the two eigenvalues (1/rx′², 1/ry′²).
            let angle2 = 0.5 * atan2(2 * g12, g11 - g22)
            let c2 = cos(angle2)
            let s2 = sin(angle2)
            let lambda1 = g11 * c2 * c2 + 2 * g12 * s2 * c2 + g22 * s2 * s2
            let lambda2 = g11 * s2 * s2 - 2 * g12 * s2 * c2 + g22 * c2 * c2
            guard lambda1 > 1e-18, lambda2 > 1e-18 else { return mask }
            return .radial(
                center: inverse.apply(center),
                radii: MaskPoint(x: 1 / lambda1.squareRoot(), y: 1 / lambda2.squareRoot()),
                angle: angle2,
                feather: feather,
                invert: invert)
        case .bitmap, .everywhere:
            return mask
        }
    }
}
