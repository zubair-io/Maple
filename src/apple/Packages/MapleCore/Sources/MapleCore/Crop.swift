// Crop.swift — geometry (crop + straighten) value type for `AdjustmentModel`.
//
// Split out of `AdjustmentModel.swift` in #366 to keep that file under
// CONTRIBUTING.md's 600-line hard budget once the four point-curve fields
// landed on the model. Pure move — the type is unchanged.

import Foundation

/// Geometry (crop + straighten) per spec § 3.12 / ticket #277. Mirror of
/// `raw_core::types::Crop`. Coordinates are normalised to `[0, 1]` against
/// the display-oriented image dimensions (post-EXIF rotation).
///
/// The XMP wire format is gated by `crs:HasCrop` — the serializer emits the
/// `crs:Crop*` group only when `isIdentity` is false, and the parser
/// silently drops a stale `crs:Crop*` rect when the marker is absent.
public struct Crop: Codable, Sendable, Equatable, Hashable {
    public var top: Double
    public var left: Double
    public var bottom: Double
    public var right: Double
    /// Straighten rotation in degrees, positive = clockwise (reference-renderer convention).
    public var angle: Double

    public init(
        top: Double = 0,
        left: Double = 0,
        bottom: Double = 1,
        right: Double = 1,
        angle: Double = 0
    ) {
        self.top = top
        self.left = left
        self.bottom = bottom
        self.right = right
        self.angle = angle
    }

    /// Identity (full frame, no rotation).
    public static let identity = Crop()

    /// True when the crop is the full-frame, zero-rotation identity. Used
    /// by the XMP serializer to omit the `crs:Crop*` group entirely.
    public var isIdentity: Bool {
        top == 0 && left == 0 && bottom == 1 && right == 1 && angle == 0
    }

    /// True when the rect (ignoring rotation) is well-formed: every edge
    /// in `[0, 1]` with `right > left` and `bottom > top`. Inverted or
    /// empty rects per spec § 3.12 are invalid and the renderer falls back
    /// to identity.
    public var rectIsValid: Bool {
        (0...1).contains(top)
            && (0...1).contains(left)
            && (0...1).contains(bottom)
            && (0...1).contains(right)
            && right > left
            && bottom > top
    }
}
