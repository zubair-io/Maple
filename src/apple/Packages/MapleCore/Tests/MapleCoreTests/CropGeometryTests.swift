// CropGeometryTests.swift — unit coverage for the crop/straighten overlay
// math (#638). Mirrors the web `crop-geometry.spec.ts` invariants so the
// two platforms can't drift on hit-testing, aspect locks, or the centered
// aspect rects. Plus a couple of Apple-only checks on `CropImageStage`
// (cropped-size derivation) and `CropAspect.resolveAspect`.

import XCTest
import CoreGraphics
@testable import MapleCore

final class CropGeometryTests: XCTestCase {
    private let identity = Crop(top: 0, left: 0, bottom: 1, right: 1, angle: 0)

    // MARK: - fitFootprint

    func testFitFootprintCentersWideViewport() {
        let fp = CropGeometry.fitFootprint(wrapW: 1000, wrapH: 400, imgW: 600, imgH: 400)
        XCTAssertEqual(fp.height, 400, accuracy: 1e-6)
        XCTAssertEqual(fp.width, 600, accuracy: 1e-6)
        XCTAssertEqual(fp.left, 200, accuracy: 1e-6)
        XCTAssertEqual(fp.top, 0, accuracy: 1e-6)
    }

    func testFitFootprintNeverUpscales() {
        let fp = CropGeometry.fitFootprint(wrapW: 4000, wrapH: 4000, imgW: 600, imgH: 400)
        XCTAssertEqual(fp.width, 600, accuracy: 1e-6)
        XCTAssertEqual(fp.height, 400, accuracy: 1e-6)
    }

    // MARK: - cropRectToPx / pxToNormalized round-trip

    func testCropRectRoundTrip() {
        let fp = CropGeometry.fitFootprint(wrapW: 1000, wrapH: 400, imgW: 600, imgH: 400)
        let crop = Crop(top: 0.1, left: 0.25, bottom: 0.9, right: 0.75, angle: 0)
        let rect = CropGeometry.cropRectToPx(crop, fp)
        XCTAssertEqual(rect.x, fp.left + 0.25 * fp.width, accuracy: 1e-6)
        XCTAssertEqual(rect.width, 0.5 * fp.width, accuracy: 1e-6)

        let tl = CropGeometry.pxToNormalized(rect.x, rect.y, fp)
        XCTAssertEqual(tl.nx, 0.25, accuracy: 1e-6)
        XCTAssertEqual(tl.ny, 0.1, accuracy: 1e-6)
    }

    func testPxToNormalizedClampsOutside() {
        let fp = CropGeometry.fitFootprint(wrapW: 1000, wrapH: 400, imgW: 600, imgH: 400)
        let p = CropGeometry.pxToNormalized(-50, 99999, fp)
        XCTAssertEqual(p.nx, 0, accuracy: 1e-9)
        XCTAssertEqual(p.ny, 1, accuracy: 1e-9)
    }

    // MARK: - hitTestHandle

    func testHitTestCorners() {
        let rect = CropGeometry.PxRect(x: 100, y: 100, width: 200, height: 200)
        XCTAssertEqual(CropGeometry.hitTestHandle(100, 100, rect, 12), .tl)
        XCTAssertEqual(CropGeometry.hitTestHandle(300, 100, rect, 12), .tr)
        XCTAssertEqual(CropGeometry.hitTestHandle(100, 300, rect, 12), .bl)
        XCTAssertEqual(CropGeometry.hitTestHandle(300, 300, rect, 12), .br)
    }

    func testHitTestEdgesAndInterior() {
        let rect = CropGeometry.PxRect(x: 100, y: 100, width: 200, height: 200)
        XCTAssertEqual(CropGeometry.hitTestHandle(200, 100, rect, 12), .t)
        XCTAssertEqual(CropGeometry.hitTestHandle(100, 200, rect, 12), .l)
        XCTAssertEqual(CropGeometry.hitTestHandle(200, 200, rect, 12), .move)
    }

    func testHitTestOutsideReturnsNil() {
        let rect = CropGeometry.PxRect(x: 100, y: 100, width: 200, height: 200)
        XCTAssertNil(CropGeometry.hitTestHandle(10, 10, rect, 12))
    }

    // MARK: - resizeCrop

    func testResizeTopLeftNoInvert() {
        let out = CropGeometry.resizeCrop(
            identity, .tl, 0.3, 0.2,
            CropGeometry.ResizeOptions(aspect: nil, imgW: 600, imgH: 400)
        )
        XCTAssertEqual(out.left, 0.3, accuracy: 1e-6)
        XCTAssertEqual(out.top, 0.2, accuracy: 1e-6)
        XCTAssertEqual(out.right, 1, accuracy: 1e-9)
        XCTAssertEqual(out.bottom, 1, accuracy: 1e-9)
    }

    func testResizeEnforcesMinimum() {
        let out = CropGeometry.resizeCrop(
            identity, .r, 0.0, 0.5,
            CropGeometry.ResizeOptions(aspect: nil, imgW: 600, imgH: 400)
        )
        XCTAssertEqual(out.right, CropGeometry.minCropFraction, accuracy: 1e-6)
    }

    func testResizeLocksSquareAspectOnCorner() {
        let out = CropGeometry.resizeCrop(
            identity, .br, 0.5, 0.9,
            CropGeometry.ResizeOptions(aspect: 1, imgW: 400, imgH: 400)
        )
        let w = (out.right - out.left) * 400
        let h = (out.bottom - out.top) * 400
        XCTAssertEqual(w, h, accuracy: 1e-4)
    }

    // MARK: - moveCrop

    func testMoveCropClampsAtEdge() {
        let crop = Crop(top: 0.1, left: 0.1, bottom: 0.5, right: 0.5, angle: 0)
        let moved = CropGeometry.moveCrop(crop, 0.7, 0)
        XCTAssertEqual(moved.right, 1, accuracy: 1e-6)
        XCTAssertEqual(moved.left, 0.6, accuracy: 1e-6)
        XCTAssertEqual(moved.bottom - moved.top, 0.4, accuracy: 1e-6)
    }

    // MARK: - centeredCropForAspect

    func testCenteredCropPanoramicSpansFullWidth() {
        let crop = CropGeometry.centeredCropForAspect(2.0 / 1.0, 600, 400, 0)
        XCTAssertEqual(crop.left, 0, accuracy: 1e-6)
        XCTAssertEqual(crop.right, 1, accuracy: 1e-6)
        XCTAssertGreaterThan(crop.top, 0)
        let w = (crop.right - crop.left) * 600
        let h = (crop.bottom - crop.top) * 400
        XCTAssertEqual(w / h, 2, accuracy: 1e-4)
    }

    func testCenteredCropTallSpansFullHeight() {
        let crop = CropGeometry.centeredCropForAspect(1.0 / 2.0, 600, 400, 0)
        XCTAssertEqual(crop.top, 0, accuracy: 1e-6)
        XCTAssertEqual(crop.bottom, 1, accuracy: 1e-6)
        let w = (crop.right - crop.left) * 600
        let h = (crop.bottom - crop.top) * 400
        XCTAssertEqual(w / h, 0.5, accuracy: 1e-4)
    }

    func testCenteredCropPreservesAngle() {
        let crop = CropGeometry.centeredCropForAspect(1, 600, 400, 7.5)
        XCTAssertEqual(crop.angle, 7.5, accuracy: 1e-9)
    }

    // MARK: - CropAspect

    func testResolveAspectFreeIsNil() {
        XCTAssertNil(CropAspect.resolveAspect(CropAspect.preset(for: .free), imgW: 600, imgH: 400))
    }

    func testResolveAspectOriginalUsesImageDims() {
        let r = CropAspect.resolveAspect(
            CropAspect.preset(for: .original), imgW: 600, imgH: 400
        )
        XCTAssertEqual(r ?? 0, 1.5, accuracy: 1e-9)
    }

    func testResolveAspectFixed() {
        let r = CropAspect.resolveAspect(
            CropAspect.preset(for: .sixteenNine), imgW: 600, imgH: 400
        )
        XCTAssertEqual(r ?? 0, 16.0 / 9.0, accuracy: 1e-9)
    }

    // MARK: - CropImageStage

    func testShouldApplyIdentityIsFalse() {
        XCTAssertFalse(CropImageStage.shouldApply(.identity))
    }

    func testShouldApplyPureAngleIsTrue() {
        XCTAssertTrue(CropImageStage.shouldApply(Crop(angle: 5)))
    }

    func testShouldApplyInvertedRectIsFalse() {
        // right < left → invalid rect → falls back to identity.
        let bad = Crop(top: 0, left: 0.8, bottom: 1, right: 0.2, angle: 0)
        XCTAssertFalse(CropImageStage.shouldApply(bad))
    }

    func testCroppedSizeHalfFrame() {
        let crop = Crop(top: 0.25, left: 0.25, bottom: 0.75, right: 0.75, angle: 0)
        let size = CropImageStage.croppedSize(crop, nativeSize: CGSize(width: 4000, height: 3000))
        XCTAssertEqual(size.width, 2000, accuracy: 1e-6)
        XCTAssertEqual(size.height, 1500, accuracy: 1e-6)
    }

    func testCroppedSizePureAngleKeepsFullFrame() {
        // A pure-straighten crop (full-frame rect) keeps the full extent —
        // the renderer cuts the same axis-aligned rect out of the rotated
        // frame.
        let size = CropImageStage.croppedSize(
            Crop(angle: 10), nativeSize: CGSize(width: 4000, height: 3000)
        )
        XCTAssertEqual(size.width, 4000, accuracy: 1e-6)
        XCTAssertEqual(size.height, 3000, accuracy: 1e-6)
    }

    func testCroppedSizeIdentityIsNative() {
        let size = CropImageStage.croppedSize(.identity, nativeSize: CGSize(width: 4000, height: 3000))
        XCTAssertEqual(size, CGSize(width: 4000, height: 3000))
    }

    // MARK: - Resolution-independent crop rect (#2117)

    /// The fast (viewport-res) and refine (~2×) phases develop at DIFFERENT
    /// buffer resolutions, then cut the crop and stretch each to the SAME
    /// canvas leaf frame. If the crop rect is rounded in each buffer's own
    /// pixel space, the SAME fraction rounds to a different NORMALIZED region
    /// at the two resolutions, so the image shifts when the sharp refine
    /// render replaces the blurry fast one. The invariant: `rect ÷ bufferSize`
    /// must be equal across resolutions.
    func testCropRectNormalizedRegionIsResolutionIndependent() {
        // A deliberately non-round fractional crop — edges that do NOT land
        // on integer pixels at either resolution, so per-buffer `.integral`
        // rounding diverges between the fast and refine buffers.
        let crop = Crop(top: 0.09, left: 0.137, bottom: 0.77, right: 0.861, angle: 0)
        // Oriented native full-frame size — the canvas/leaf reference.
        let native = CGSize(width: 8064, height: 10752)
        let fast = CGSize(width: 1179, height: 1572)
        let refine = CGSize(width: 2358, height: 3144) // exactly 2× fast

        guard let rFast = CropImageStage.cropRect(crop, bufferSize: fast, nativeSize: native),
              let rRefine = CropImageStage.cropRect(crop, bufferSize: refine, nativeSize: native)
        else { return XCTFail("crop rect should be non-nil for a valid crop") }

        // Sub-pixel tolerance: ≤ ~0.5px at the higher resolution, normalized.
        let eps = 0.5 / refine.height
        XCTAssertEqual(rFast.origin.x / fast.width, rRefine.origin.x / refine.width,
                       accuracy: eps, "normalized origin.x diverges across resolutions")
        XCTAssertEqual(rFast.origin.y / fast.height, rRefine.origin.y / refine.height,
                       accuracy: eps, "normalized origin.y diverges across resolutions")
        XCTAssertEqual(rFast.width / fast.width, rRefine.width / refine.width,
                       accuracy: eps, "normalized width diverges across resolutions")
        XCTAssertEqual(rFast.height / fast.height, rRefine.height / refine.height,
                       accuracy: eps, "normalized height diverges across resolutions")
    }

    /// The resolution-independent rect must still select the correct region:
    /// against a buffer that equals the native reference, it reproduces the
    /// expected y-up flipped crop rect (left·w, (1-bottom)·h, …).
    func testCropRectMatchesFractionsAtNativeResolution() {
        let crop = Crop(top: 0.25, left: 0.25, bottom: 0.75, right: 0.75, angle: 0)
        let native = CGSize(width: 4000, height: 3000)
        guard let rect = CropImageStage.cropRect(crop, bufferSize: native, nativeSize: native)
        else { return XCTFail("crop rect should be non-nil") }
        XCTAssertEqual(rect.origin.x, 1000, accuracy: 1e-6)
        XCTAssertEqual(rect.origin.y, (1.0 - 0.75) * 3000, accuracy: 1e-6) // 750
        XCTAssertEqual(rect.width, 2000, accuracy: 1e-6)
        XCTAssertEqual(rect.height, 1500, accuracy: 1e-6)
    }
}
