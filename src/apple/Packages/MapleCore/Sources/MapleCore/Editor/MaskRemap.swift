// MaskRemap.swift — re-expressing a mask's geometry in a cropped buffer's
// coordinate space (#355).
//
// raw-core evaluates every mask in FULL-FRAME normalized coordinates and
// applies the user crop in the geometry tail, AFTER the scene-linear chain
// (`docs/pipeline.md` § geometry tail). The Apple GPU-live path does the
// opposite: it crops (and straightens) the decoded buffer BEFORE uploading
// it (#1617), so the wgpu chain's `(x, y) ∈ [0, 1]²` are crop-normalized.
// Handing it the model's full-frame masks unchanged would place every mask
// relative to the crop instead of the frame — a silent parity break against
// the CPU refine, the export, and every other platform.
//
// `MaskAffine` is the exact map the crop stage implies between the two
// spaces, and `MaskRemap` rewrites each layer so that evaluating the
// remapped mask at a crop-normalized point gives the SAME weight raw-core
// gets from the original mask at the corresponding full-frame point. Both
// mask shapes survive an arbitrary affine map exactly:
//
// - A linear gradient's weight is a smoothstep of the parametric position
//   `t = ((p − start) · D) / |D|²`. Under `p = M p' + o` that is still linear
//   in `p'`, so the remapped gradient has `start' = M⁻¹(start − o)` and
//   `D' = Mᵀ D · |D|² / |Mᵀ D|²` (feather is in `t` units and is unchanged).
// - A radial mask's weight is a function of the quadratic form
//   `|S R(−α) (p − c)|²`. Under the same substitution the form becomes
//   `(p' − c')ᵀ G (p' − c')` with `G = Nᵀ N`, `N = S R(−α) M`; diagonalising
//   the symmetric 2×2 `G` gives the remapped angle and radii (feather is a
//   fraction of the radius in that normalized distance and is unchanged).
//
// The map itself is derived numerically from `CropImageStage`'s own
// semantics (rotate the full frame clockwise about its center by the
// straighten angle, then cut the axis-aligned rect) so the two cannot
// drift. `MaskRemapTests` asserts the weight identity at sample points for
// aspect-changing crops with and without a straighten angle.

import CoreGraphics
import Foundation

/// A 2-D affine map `p = M p' + o` with `M = [[a, c], [b, d]]` — the same
/// member convention as `CGAffineTransform` (`x = a·x' + c·y' + tx`,
/// `y = b·x' + d·y' + ty`).
public struct MaskAffine: Equatable, Sendable {
    public var a: Double
    public var b: Double
    public var c: Double
    public var d: Double
    public var tx: Double
    public var ty: Double

    public init(a: Double, b: Double, c: Double, d: Double, tx: Double, ty: Double) {
        self.a = a
        self.b = b
        self.c = c
        self.d = d
        self.tx = tx
        self.ty = ty
    }

    public static let identity = MaskAffine(a: 1, b: 0, c: 0, d: 1, tx: 0, ty: 0)

    public var isIdentity: Bool { self == .identity }

    public func apply(_ p: MaskPoint) -> MaskPoint {
        MaskPoint(x: a * p.x + c * p.y + tx, y: b * p.x + d * p.y + ty)
    }

    /// `Mᵀ v` — the linear part transposed, no translation.
    func transposeApplied(_ v: MaskPoint) -> MaskPoint {
        MaskPoint(x: a * v.x + b * v.y, y: c * v.x + d * v.y)
    }

    /// The inverse map, or `nil` when `M` is singular.
    public func inverted() -> MaskAffine? {
        let det = a * d - b * c
        guard abs(det) > 1e-12 else { return nil }
        let ia = d / det
        let ib = -b / det
        let ic = -c / det
        let id = a / det
        return MaskAffine(a: ia, b: ib, c: ic, d: id, tx: -(ia * tx + ic * ty), ty: -(ib * tx + id * ty))
    }

    /// The map from a cropped buffer's normalized coordinates to the full
    /// frame's, for `crop` applied to an image of `nativeSize` pixels —
    /// identity when the crop doesn't apply or the size is unknown.
    ///
    /// Derived by pushing the crop-space origin and unit vectors through
    /// the forward geometry (`CropImageStage`'s "rotate clockwise about the
    /// center, then cut the axis-aligned rect"), so the pixel-space
    /// straighten rotation — anisotropic in normalized space on a
    /// non-square image — is captured exactly rather than approximated.
    public static func cropToFullFrame(_ crop: Crop, nativeSize: CGSize) -> MaskAffine {
        guard CropImageStage.shouldApply(crop),
              nativeSize.width > 0, nativeSize.height > 0,
              nativeSize.width.isFinite, nativeSize.height.isFinite
        else { return .identity }
        let w = Double(nativeSize.width)
        let h = Double(nativeSize.height)
        let cw = crop.right - crop.left
        let ch = crop.bottom - crop.top
        let theta = crop.angle * .pi / 180
        let cosT = cos(theta)
        let sinT = sin(theta)
        // Crop-normalized (u', v') → the point on the ROTATED frame in pixels,
        // then un-rotate about the frame center (screen-clockwise rotation by
        // θ in y-down pixel space is `[[cos, −sin], [sin, cos]]`; its inverse
        // is the transpose) to reach the source pixel, then normalize.
        let map: (Double, Double) -> MaskPoint = { u, v in
            let rx = (crop.left + u * cw) * w - w / 2
            let ry = (crop.top + v * ch) * h - h / 2
            let sx = cosT * rx + sinT * ry + w / 2
            let sy = -sinT * rx + cosT * ry + h / 2
            return MaskPoint(x: sx / w, y: sy / h)
        }
        let origin = map(0, 0)
        let unitX = map(1, 0)
        let unitY = map(0, 1)
        return MaskAffine(
            a: unitX.x - origin.x, b: unitX.y - origin.y,
            c: unitY.x - origin.x, d: unitY.y - origin.y,
            tx: origin.x, ty: origin.y)
    }
}

public enum MaskRemap {
    /// `layers` re-expressed in the coordinate space of `appliedCrop`'s
    /// output buffer. Returns `layers` unchanged when the crop doesn't apply,
    /// so the common uncropped case costs one predicate.
    public static func remapped(
        _ layers: [LocalAdjustment], appliedCrop: Crop, nativeSize: CGSize
    ) -> [LocalAdjustment] {
        let affine = MaskAffine.cropToFullFrame(appliedCrop, nativeSize: nativeSize)
        guard !affine.isIdentity, !layers.isEmpty, let inverse = affine.inverted() else { return layers }
        return layers.map { layer in
            LocalAdjustment(
                mask: remap(layer.mask, cropToFull: affine, fullToCrop: inverse),
                adjustments: layer.adjustments)
        }
    }

    /// One mask through the map — see the file header for the derivation.
    static func remap(_ mask: LocalMask, cropToFull m: MaskAffine, fullToCrop inverse: MaskAffine) -> LocalMask {
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
            // and the two eigenvalues (1/rx'², 1/ry'²).
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
        }
    }
}
