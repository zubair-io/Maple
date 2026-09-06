// MaskOverlayGeometryTests.swift — #3354.
//
// The overlay must land on the SAME pixels the canvas paints, at any zoom
// and pan. The first fix for this ticket assumed the canvas was at fit,
// which held for exactly as long as the user did not touch the zoom.

import CoreGraphics
import XCTest

@testable import MapleCore

final class MaskOverlayGeometryTests: XCTestCase {
    /// At fit with no pan the image is simply centred — the one case the
    /// old `fitFootprint` placement also got right.
    func testCentredAtFitWithNoPan() {
        let r = MaskOverlayGeometry.displayRect(
            containerSize: CGSize(width: 1000, height: 800),
            displayFrame: CGSize(width: 800, height: 600),
            panOffset: .zero)
        XCTAssertEqual(r, CGRect(x: 100, y: 100, width: 800, height: 600))
    }

    /// Zoomed past the container and panned: the rect follows the canvas
    /// (larger than the container, shifted by the pan) instead of staying
    /// at the fit footprint — the bug in the screenshot.
    func testFollowsZoomAndPan() {
        let r = MaskOverlayGeometry.displayRect(
            containerSize: CGSize(width: 1000, height: 800),
            displayFrame: CGSize(width: 2400, height: 1800),
            panOffset: CGSize(width: 50, height: -30))
        XCTAssertEqual(r, CGRect(x: -650, y: -530, width: 2400, height: 1800))
    }

    /// Identity crop: full frame == displayed rect.
    func testIdentityCropIsTheDisplayRect() throws {
        let container = CGSize(width: 1000, height: 800)
        let frame = CGSize(width: 800, height: 600)
        let full = try XCTUnwrap(
            MaskOverlayGeometry.fullFrameRect(
                containerSize: container, displayFrame: frame, panOffset: .zero,
                crop: .identity))
        XCTAssertEqual(
            full,
            MaskOverlayGeometry.displayRect(
                containerSize: container, displayFrame: frame, panOffset: .zero))
    }

    /// With a crop, the canvas shows only the crop's sub-rect. The full-
    /// frame rect must be the one whose crop sub-rect is exactly what is
    /// on screen — otherwise the raster (full-frame) drifts off the pixels.
    func testCropExpandsBackToTheFullFrame() throws {
        let container = CGSize(width: 1000, height: 800)
        let frame = CGSize(width: 400, height: 300)  // the cropped image, on screen
        let crop = Crop(top: 0.25, left: 0.5, bottom: 0.75, right: 1.0)  // right half, middle band
        let shown = MaskOverlayGeometry.displayRect(
            containerSize: container, displayFrame: frame, panOffset: .zero)
        let full = try XCTUnwrap(
            MaskOverlayGeometry.fullFrameRect(
                containerSize: container, displayFrame: frame, panOffset: .zero, crop: crop))

        // Full frame is twice as wide and twice as tall as the shown part.
        XCTAssertEqual(full.width, 800)
        XCTAssertEqual(full.height, 600)
        // And the crop's sub-rect of it is what is on screen.
        let sub = CGRect(
            x: full.minX + crop.left * full.width,
            y: full.minY + crop.top * full.height,
            width: (crop.right - crop.left) * full.width,
            height: (crop.bottom - crop.top) * full.height)
        XCTAssertEqual(sub, shown)
    }

    /// An inverted crop is what the renderer treats as identity, so the
    /// overlay must too rather than producing a negative-size rect.
    func testInvalidCropFallsBackToIdentity() throws {
        let container = CGSize(width: 1000, height: 800)
        let frame = CGSize(width: 800, height: 600)
        let bad = Crop(top: 0.9, left: 0.9, bottom: 0.1, right: 0.1)
        let full = try XCTUnwrap(
            MaskOverlayGeometry.fullFrameRect(
                containerSize: container, displayFrame: frame, panOffset: .zero, crop: bad))
        XCTAssertEqual(full.size, frame)
    }
}
