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

    /// The axis-aligned crop rect (y-up / CIImage space, buffer pixels) for
    /// `crop` against a developed buffer of size `bufferSize`, using
    /// `nativeSize` as the RESOLUTION-INDEPENDENT rounding reference.
    ///
    /// Takes a `CGSize`, not a rect: the returned rect is always expressed
    /// against a (0,0)-origin buffer, so only the buffer's dimensions are
    /// input. `apply` normalizes its developed image to a (0,0) origin (the
    /// `base` transform) before calling this, so `base.extent.size` is the
    /// correct and sufficient input.
    ///
    /// The rect is rounded ONCE against the oriented native full-frame size —
    /// the same reference `croppedSize` and the canvas leaf frame use — then
    /// scaled proportionally onto `bufferSize`, rather than `.integral`-
    /// rounded in the buffer's own pixel space. This is what keeps the fast
    /// (viewport-res) and refine (~2×) phases cutting the IDENTICAL normalized
    /// region: because both derive their normalized origin/size from the SAME
    /// canonical native rect, `rect ÷ bufferSize` is equal across
    /// resolutions, so the two buffers (each re-origined to (0,0) and
    /// stretched to the same leaf frame) show pixel-aligned content and the
    /// image no longer shifts when the sharp refine render replaces the blurry
    /// fast one (#2117). The old per-buffer `.integral` rounded the same
    /// fraction to a different normalized rect at each resolution.
    ///
    /// `Crop` edges are top-left-origin; CIImage is y-up, so the vertical
    /// edges flip: the rect's bottom edge in CIImage-y is (1 - crop.bottom)·h.
    /// Returns `nil` for a degenerate buffer or an empty rect.
    nonisolated static func cropRect(
        _ crop: Crop, bufferSize: CGSize, nativeSize: CGSize
    ) -> CGRect? {
        let w = bufferSize.width
        let h = bufferSize.height
        guard w > 0, h > 0, w.isFinite, h.isFinite else { return nil }

        // Rounding reference: the oriented native full-frame size. Fall back
        // to the buffer's own extent when a native size hasn't seeded yet —
        // still deterministic, just not cross-resolution-shared for that one
        // frame (matches the pre-#2117 per-buffer behavior in the degenerate
        // case rather than dividing by zero).
        let refW = (nativeSize.width > 0 && nativeSize.width.isFinite) ? nativeSize.width : w
        let refH = (nativeSize.height > 0 && nativeSize.height.isFinite) ? nativeSize.height : h

        let left = CGFloat(crop.left)
        let right = CGFloat(crop.right)
        let top = CGFloat(crop.top)
        let bottom = CGFloat(crop.bottom)

        // Canonical integer crop rect in NATIVE pixels — the single source of
        // edge placement, rounded once (clean pixel edges relative to the
        // canvas reference). y-up flip on the vertical edges.
        let canonical = CGRect(
            x: left * refW,
            y: (1.0 - bottom) * refH,
            width: (right - left) * refW,
            height: (bottom - top) * refH
        ).integral
        guard canonical.width > 0, canonical.height > 0 else { return nil }

        // Normalized fractions of the native reference, mapped onto this
        // buffer WITHOUT a second independent `.integral` — so the normalized
        // region is identical at every resolution.
        let rect = CGRect(
            x: canonical.origin.x / refW * w,
            y: canonical.origin.y / refH * h,
            width: canonical.width / refW * w,
            height: canonical.height / refH * h
        )
        guard rect.width > 0, rect.height > 0 else { return nil }
        return rect
    }

    /// Apply crop + straighten to a developed CIImage.
    ///
    /// `developed` is the final display-domain image whose extent spans the
    /// oriented full frame (at whatever resolution the current phase
    /// developed). `crop` is the rect+angle to apply. `nativeSize` is the
    /// oriented native full-frame size — the resolution-independent reference
    /// the crop rect is rounded against so fast and refine phases cut the
    /// identical normalized region (#2117). Returns the cropped CIImage with
    /// its extent origin at (0, 0); returns `developed` unchanged when the
    /// crop shouldn't apply or the extent is degenerate.
    public static func apply(_ crop: Crop, to developed: CIImage, nativeSize: CGSize) -> CIImage {
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
        let image: CIImage
        if crop.angle != 0 {
            let cx = w / 2
            let cy = h / 2
            let rot = CGAffineTransform(translationX: cx, y: cy)
                .rotated(by: rotationRadians(forAngleDegrees: crop.angle))
                .translatedBy(x: -cx, y: -cy)
            image = base.transformed(by: rot)
        } else {
            image = base
        }

        // 2. Axis-aligned crop rect — resolution-independent (rounded against
        //    `nativeSize`, then scaled to this buffer). See `cropRect`.
        guard let rect = cropRect(
            crop, bufferSize: base.extent.size, nativeSize: nativeSize
        ) else { return developed }

        let cropped = image.cropped(to: rect)

        // 3. Re-origin to (0, 0) so framing / zoom math sees a clean
        //    origin-anchored buffer (every other publish path normalizes
        //    origin the same way — see `decodedForNativeCanvas`).
        return cropped.transformed(by: CGAffineTransform(
            translationX: -rect.origin.x, y: -rect.origin.y
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
