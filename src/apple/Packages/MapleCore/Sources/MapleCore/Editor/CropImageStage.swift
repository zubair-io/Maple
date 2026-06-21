// CropImageStage.swift — CoreImage crop + straighten stage (#638).
//
// Applies `model.crop` to the FINAL displayed CIImage produced by the
// develop chain (post-AgX, post-display-encode). This is the Apple
// equivalent of the web renderer's "rotate the frame, then cut an
// axis-aligned rect" step (spec § 3.12) — the crop is NOT in the Rust
// scene-linear core on Apple (no Rust changes for #638), so it rides here
// as a pure CoreImage geometry op on the developed pixels.
//
// Pipeline order within the stage:
//   1. Rotate the developed image about its center by `angle` (straighten).
//      A NEAR-edge crop may reveal an empty corner — by design, matching
//      the no-corner-fill preview and the web renderer (spec § 3.12).
//   2. Crop to the axis-aligned `Crop` rect, normalized against the
//      ORIENTED full-frame extent.
//   3. Translate the result so its extent origin is (0, 0), so downstream
//      framing / zoom anchors the cropped buffer at the origin like every
//      other publish (`decodedForNativeCanvas` already origin-normalizes
//      full-frame buffers).
//
// Coordinate spaces: `Crop` edges are top/left/bottom/right in [0, 1]
// against the DISPLAY-oriented image with the origin at the TOP-LEFT (the
// XMP / pipeline convention). CIImage is y-UP. The conversion flips `top`
// to a bottom-origin offset.

import Foundation
import CoreImage

public enum CropImageStage {
    /// The straighten-rotation sign. The `Crop.angle` convention is degrees,
    /// positive = clockwise as seen on screen (matching the reference
    /// renderer and the CSS / SwiftUI `.rotationEffect` preview). CIImage's
    /// coordinate space is y-UP, so a positive `CGAffineTransform`
    /// rotation turns the content counter-clockwise on screen. To rotate the
    /// developed content CLOCKWISE on screen we therefore rotate by
    /// `-angle` radians. This is the SAME visual direction the overlay's
    /// `.rotationEffect(.degrees(angle))` produces, so the live preview and
    /// the rendered output agree.
    static func rotationRadians(forAngleDegrees angle: Double) -> CGFloat {
        CGFloat(-angle * .pi / 180.0)
    }

    /// Whether the crop step should be applied for `crop`: a well-formed,
    /// non-identity rect or a non-zero straighten angle. An invalid rect
    /// (inverted / out of range) falls back to identity per spec § 3.12.
    public static func shouldApply(_ crop: Crop) -> Bool {
        guard !crop.isIdentity else { return false }
        // A pure-angle crop (rect == full frame, angle != 0) is valid and
        // must apply; `rectIsValid` is true for the full-frame rect.
        return crop.rectIsValid
    }

    /// Apply crop + straighten to a developed CIImage.
    ///
    /// `developed` is the final display-domain image whose extent spans the
    /// oriented full frame. `crop` is the rect+angle to apply. Returns the
    /// cropped CIImage with its extent origin at (0, 0); returns `developed`
    /// unchanged when the crop shouldn't apply or the extent is degenerate.
    public static func apply(_ crop: Crop, to developed: CIImage) -> CIImage {
        guard shouldApply(crop) else { return developed }
        let extent = developed.extent
        guard extent.width > 0, extent.height > 0, extent.width.isFinite, extent.height.isFinite
        else { return developed }

        // Normalize the developed image to a (0,0)-origin frame first so the
        // center-rotation + rect math is anchored consistently regardless of
        // any residual origin on the input buffer.
        let base = developed.transformed(by: CGAffineTransform(
            translationX: -extent.origin.x, y: -extent.origin.y
        ))
        let w = extent.width
        let h = extent.height

        // 1. Straighten: rotate about the image center.
        var image = base
        if crop.angle != 0 {
            let cx = w / 2
            let cy = h / 2
            let rot = CGAffineTransform(translationX: cx, y: cy)
                .rotated(by: rotationRadians(forAngleDegrees: crop.angle))
                .translatedBy(x: -cx, y: -cy)
            image = base.transformed(by: rot)
        }

        // 2. Axis-aligned crop rect, normalized against the full-frame
        //    extent. `Crop` is top-left-origin; CIImage is y-up, so flip the
        //    vertical edges: the rect's bottom edge in CIImage-y is
        //    (1 - crop.bottom) · h and its top edge is (1 - crop.top) · h.
        let left = CGFloat(crop.left)
        let right = CGFloat(crop.right)
        let top = CGFloat(crop.top)
        let bottom = CGFloat(crop.bottom)
        let cropX = left * w
        let cropW = (right - left) * w
        let cropYBottom = (1.0 - bottom) * h
        let cropH = (bottom - top) * h
        let cropRect = CGRect(x: cropX, y: cropYBottom, width: cropW, height: cropH)
            .integral
        guard cropRect.width > 0, cropRect.height > 0 else { return developed }

        let cropped = image.cropped(to: cropRect)

        // 3. Re-origin to (0, 0) so framing / zoom math sees a clean
        //    origin-anchored buffer (every other publish path normalizes
        //    origin the same way — see `decodedForNativeCanvas`).
        return cropped.transformed(by: CGAffineTransform(
            translationX: -cropRect.origin.x, y: -cropRect.origin.y
        ))
    }

    /// The oriented pixel size of the cropped output for a `crop` against a
    /// full-frame `nativeSize`. Drives the canvas/zoom extent so fit / 100% /
    /// pan use the CROPPED dimensions, not the full sensor. Returns
    /// `nativeSize` unchanged when the crop shouldn't apply.
    ///
    /// NOTE: the size reflects the axis-aligned crop RECT only — straighten
    /// does not change the output extent (the renderer cuts the same
    /// axis-aligned rect out of the rotated frame), matching `apply` above.
    public static func croppedSize(_ crop: Crop, nativeSize: CGSize) -> CGSize {
        guard shouldApply(crop),
              nativeSize.width > 0, nativeSize.height > 0
        else { return nativeSize }
        let w = (crop.right - crop.left) * Double(nativeSize.width)
        let h = (crop.bottom - crop.top) * Double(nativeSize.height)
        guard w > 0, h > 0 else { return nativeSize }
        return CGSize(width: w.rounded(), height: h.rounded())
    }
}
