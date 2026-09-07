// Perspective.swift — manual-geometry value type for `AdjustmentModel` (#3410).
//
// The seven `crs:Perspective*` scalars raw-core composes into one homography
// (`raw_core::stages::perspective`). raw-core declares them FLAT, as seven
// entries on `ADJUSTMENT_SCHEMA`; Swift groups them into this nested type the
// way it already groups the crop rect, because `AdjustmentModel.swift` cannot
// absorb seven more stored properties plus their memberwise-init parameters
// and assignments without breaching CONTRIBUTING.md's file budget — and its
// explicit `public init` is load-bearing (see that file's header), so the
// init cannot move to an extension to make room.
//
// The grouping is a Swift-side shape only. The generated `FieldName` cases
// stay flat and canonical (`perspectiveVertical`, …), the XMP keys are
// Adobe's, and `PresetAdjustmentBridge` maps each field name to
// `\.perspective.<member>` — so nothing outside this module can tell the
// difference.

import Foundation

/// Manual geometry: vertical and horizontal keystone, rotation, scale, aspect
/// stretch and X/Y offset. Mirror of `raw_core::stages::perspective::Perspective`.
///
/// Every member is normalised to the frame's own half-extents rather than to
/// pixels, so the same numbers describe the same correction on an image of any
/// size — which is what lets the live canvas, a downsampled preview and the
/// export master agree. The XMP serializer omits each key independently when it
/// still holds the value below.
public struct Perspective: Codable, Sendable, Equatable, Hashable {
    /// Vertical keystone, −100…100. Positive converges the bottom edge — the
    /// correction for a camera tilted up at a building. XMP
    /// `crs:PerspectiveVertical`.
    public var vertical: Double
    /// Horizontal keystone, −100…100. Positive converges the right edge. XMP
    /// `crs:PerspectiveHorizontal`.
    public var horizontal: Double
    /// Rotation in degrees, −10…10, positive = clockwise. Composes with
    /// `Crop.angle`'s ±45° straighten rather than replacing it: this one turns
    /// the frame the crop then samples. XMP `crs:PerspectiveRotate`.
    public var rotate: Double
    /// Uniform scale about the image centre, 50…150 percent. Above 100 pushes
    /// a keystone's transparent surround off-frame. XMP `crs:PerspectiveScale`.
    public var scale: Double
    /// Area-preserving aspect stretch, −100…100. Positive widens horizontally
    /// and compresses vertically by the reciprocal. XMP `crs:PerspectiveAspect`.
    public var aspect: Double
    /// Horizontal offset, −100…100, in hundredths of a half-extent — ±100 is
    /// half the frame width. XMP `crs:PerspectiveX`.
    public var x: Double
    /// Vertical offset, −100…100. XMP `crs:PerspectiveY`.
    public var y: Double

    public init(
        vertical: Double = 0,
        horizontal: Double = 0,
        rotate: Double = 0,
        scale: Double = 100,
        aspect: Double = 0,
        x: Double = 0,
        y: Double = 0
    ) {
        self.vertical = vertical
        self.horizontal = horizontal
        self.rotate = rotate
        self.scale = scale
        self.aspect = aspect
        self.x = x
        self.y = y
    }

    /// No manual geometry — every member at the value that makes its factor
    /// the identity matrix.
    public static let identity = Perspective()

    /// True when the composed homography is exactly the identity, which is
    /// what both render paths short-circuit on.
    public var isIdentity: Bool {
        self == .identity
    }
}
