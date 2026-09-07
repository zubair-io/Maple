// MaskAffine.swift — the map between a render buffer's normalized
// coordinates and the full frame's (#355).
//
// raw-core evaluates every mask in FULL-FRAME normalized coordinates: the
// buffer's pixel `(x, y)` reads the mask at `(x / (W − 1), y / (H − 1))` with
// `W × H` the whole oriented image (`stages::local_adjustments::apply_core`).
// Two Apple render paths hand the chain a buffer that is NOT the whole frame:
//
// - The GPU-live present crops (and straightens) the decoded buffer BEFORE
//   the upload (#1617), so the wgpu chain's `(0, 0)…(1, 1)` span the crop.
// - The 100% native-detail path develops one viewport patch and runs the
//   per-tick chain on that patch alone, so its `(0, 0)…(1, 1)` span the
//   patch.
//
// A `MaskAffine` is the exact map `p = M p′ + o` from the buffer's normalized
// point `p′` back to the full-frame normalized point `p`. `MaskRemap` uses it
// to rewrite each layer so that evaluating the remapped mask at `p′` yields
// the weight raw-core gets from the original mask at `p` — the CPU refine,
// the export and every other platform all evaluate at `p`.

import CoreGraphics
import Foundation

/// A 2-D affine map `p = M p′ + o` with `M = [[a, c], [b, d]]` — the same
/// member convention as `CGAffineTransform` (`x = a·x′ + c·y′ + tx`,
/// `y = b·x′ + d·y′ + ty`).
public struct MaskAffine: Equatable, Hashable, Sendable {
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
    /// frame's, for `crop` applied to an image of `nativeSize` oriented
    /// pixels — identity when the crop doesn't apply or the size is unknown.
    ///
    /// Derived by pushing the crop-space origin and unit vectors through
    /// `WhiteBalancePickGeometry.uncroppedPoint`, the inverse of
    /// `CropImageStage.apply`'s own geometry (the canonical integer crop rect
    /// rounded against `nativeSize`, cut from the frame rotated clockwise
    /// about its centre by the straighten angle). Sharing that one function
    /// is what keeps the mask placement, the WB picker and the crop stage
    /// from drifting; the pixel-space rotation — anisotropic in normalized
    /// space on a non-square image — is captured exactly rather than
    /// approximated.
    public static func cropToFullFrame(_ crop: Crop, nativeSize: CGSize) -> MaskAffine {
        guard CropImageStage.shouldApply(crop),
              nativeSize.width > 0, nativeSize.height > 0,
              nativeSize.width.isFinite, nativeSize.height.isFinite
        else { return .identity }
        let map: (Double, Double) -> MaskPoint = { u, v in
            let p = WhiteBalancePickGeometry.uncroppedPoint(
                x: CGFloat(u), y: CGFloat(v), nativeSize: nativeSize, crop: crop)
            return MaskPoint(x: Double(p.x), y: Double(p.y))
        }
        let origin = map(0, 0)
        let unitX = map(1, 0)
        let unitY = map(0, 1)
        return MaskAffine(
            a: unitX.x - origin.x, b: unitX.y - origin.y,
            c: unitY.x - origin.x, d: unitY.y - origin.y,
            tx: origin.x, ty: origin.y)
    }

    /// The map from an axis-aligned pixel WINDOW's normalized coordinates to
    /// the full frame's — the native-detail patch (`EditSession
    /// .refineNativeDetail`), whose chain buffer is `window` cut from an
    /// image of `fullSize` oriented pixels at 1:1.
    ///
    /// Index-based, reproducing raw-core's windowed rule exactly
    /// (`local_adjustments::apply_windowed`): buffer pixel `x` sits at frame
    /// pixel `window.minX + x`, both axes normalised by `1 / (dim − 1)`, so a
    /// patch rendered through this map is bit-for-bit the weight the tile
    /// path would evaluate. A one-pixel axis normalises to 0 on both sides
    /// (raw-core's `inv = 0` degenerate rule), which the zero scale here
    /// reproduces. Identity when the window IS the frame, or the sizes are
    /// degenerate.
    public static func windowToFullFrame(window: CGRect, fullSize: CGSize) -> MaskAffine {
        let fullW = Double(fullSize.width)
        let fullH = Double(fullSize.height)
        guard fullW > 1, fullH > 1, fullW.isFinite, fullH.isFinite,
              !window.isNull, !window.isEmpty
        else { return .identity }
        let winW = Double(window.width)
        let winH = Double(window.height)
        let originX = Double(window.minX)
        let originY = Double(window.minY)
        guard originX != 0 || originY != 0 || winW != fullW || winH != fullH else { return .identity }
        let scale: (Double) -> Double = { extent in extent > 1 ? (extent - 1) : 0 }
        return MaskAffine(
            a: scale(winW) / (fullW - 1), b: 0,
            c: 0, d: scale(winH) / (fullH - 1),
            tx: originX / (fullW - 1), ty: originY / (fullH - 1))
    }
}
