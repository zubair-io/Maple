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
    func testProjectionMapsPresentedPointThroughGeometryOffset() throws {
        let projection = MaskProjection.presentationToFrame(
            crop: .identity, perspective: Perspective(x: 50),
            nativeSize: CGSize(width: 400, height: 300))
        let centre = try XCTUnwrap(projection.apply(MaskPoint(x: 0.5, y: 0.5)))
        XCTAssertEqual(centre.x, 0.25, accuracy: 1e-9)
        XCTAssertEqual(centre.y, 0.5, accuracy: 1e-9)
    }

    func testProjectionMapsPresentedPointThroughKeystoneProjectively() throws {
        let projection = MaskProjection.presentationToFrame(
            crop: .identity, perspective: Perspective(vertical: 40),
            nativeSize: CGSize(width: 400, height: 300))
        let p = try XCTUnwrap(projection.apply(MaskPoint(x: 0.1, y: 0.2)))
        XCTAssertEqual(p.x, 0.1428571429, accuracy: 1e-9)
        XCTAssertEqual(p.y, 0.2321428571, accuracy: 1e-9)
        let q = try XCTUnwrap(projection.apply(MaskPoint(x: 0.3, y: 0.85)))
        XCTAssertEqual(q.x, 0.2674418605, accuracy: 1e-9)
        XCTAssertEqual(q.y, 0.9069767442, accuracy: 1e-9)
    }

    func testProjectionMapsPresentedPointThroughRotateOverCrop() throws {
        let crop = Crop(top: 0.1, left: 0.2, bottom: 0.9, right: 0.7, angle: 5)
        let projection = MaskProjection.presentationToFrame(
            crop: crop, perspective: Perspective(rotate: 10),
            nativeSize: CGSize(width: 6000, height: 4000))
        let p = try XCTUnwrap(projection.apply(MaskPoint(x: 0.1, y: 0.2)))
        XCTAssertEqual(p.x, 0.2171074962, accuracy: 5e-3)
        XCTAssertEqual(p.y, 0.3652349436, accuracy: 5e-3)
        let cropOnly = MaskProjection.presentationToFrame(
            crop: crop, perspective: .identity,
            nativeSize: CGSize(width: 6000, height: 4000))
        let c = try XCTUnwrap(cropOnly.apply(MaskPoint(x: 0.1, y: 0.2)))
        XCTAssertGreaterThan(abs(p.x - c.x) + abs(p.y - c.y), 0.05)
    }

    func testScreenMappingPlacesHandlesThroughGeometryAndInverts() throws {
        let display = CGRect(x: 100, y: 50, width: 600, height: 400)
        let projection = MaskProjection.presentationToFrame(
            crop: .identity, perspective: Perspective(x: 50),
            nativeSize: CGSize(width: 400, height: 300))
        let screen = try XCTUnwrap(
            MaskOverlayGeometry.screenPoint(
                MaskPoint(x: 0.25, y: 0.5), displayRect: display, projection: projection))
        XCTAssertEqual(screen.x, 400, accuracy: 1e-9)
        XCTAssertEqual(screen.y, 250, accuracy: 1e-9)
        let back = try XCTUnwrap(
            MaskOverlayGeometry.normalizedPoint(screen, displayRect: display, projection: projection))
        XCTAssertEqual(back.x, 0.25, accuracy: 1e-9)
        XCTAssertEqual(back.y, 0.5, accuracy: 1e-9)
    }
}
