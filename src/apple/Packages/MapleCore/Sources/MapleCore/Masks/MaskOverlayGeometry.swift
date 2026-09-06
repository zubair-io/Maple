// MaskOverlayGeometry.swift — where the mask raster goes on screen (#3354).
//
// The overlay used to place the raster with `CropGeometry.fitFootprint`,
// which is only right when the canvas is at fit zoom with zero pan. The
// canvas is at whatever zoom the user has — so the red silhouette came out
// a smaller, offset copy of the subject. This mirrors the canvas's own
// placement instead: `CanvasZoomHost` lays the image out at
// `displayFrameInPoints`, centred in its container, then `.offset(pan)`.
// A crop adds one more step — the canvas draws only the cropped sub-rect,
// while the raster covers the full frame, so the full-frame rect is
// recovered by expanding the cropped one back out by the crop's insets.

import CoreGraphics
import Foundation

public enum MaskOverlayGeometry {
    /// The on-screen rect (points, container coordinates) of the CROPPED
    /// image — exactly where the canvas paints it.
    public static func displayRect(
        containerSize: CGSize, displayFrame: CGSize, panOffset: CGSize
    ) -> CGRect {
        CGRect(
            x: (containerSize.width - displayFrame.width) / 2 + panOffset.width,
            y: (containerSize.height - displayFrame.height) / 2 + panOffset.height,
            width: displayFrame.width,
            height: displayFrame.height)
    }

    /// The on-screen rect of the FULL frame the raster covers. With an
    /// identity crop this is `displayRect` itself; with a crop it is the
    /// larger rect whose `crop` sub-rect lands on `displayRect`. Returns
    /// `nil` for a degenerate crop, which the renderer treats as identity
    /// anyway (`Crop.rectIsValid`).
    public static func fullFrameRect(
        containerSize: CGSize, displayFrame: CGSize, panOffset: CGSize, crop: Crop
    ) -> CGRect? {
        let shown = displayRect(
            containerSize: containerSize, displayFrame: displayFrame, panOffset: panOffset)
        let c = crop.rectIsValid ? crop : .identity
        let w = c.right - c.left
        let h = c.bottom - c.top
        guard w > 0, h > 0 else { return nil }
        let fullW = shown.width / w
        let fullH = shown.height / h
        return CGRect(
            x: shown.minX - c.left * fullW,
            y: shown.minY - c.top * fullH,
            width: fullW,
            height: fullH)
    }
}
