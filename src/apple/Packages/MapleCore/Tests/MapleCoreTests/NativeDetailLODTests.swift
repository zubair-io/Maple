import CoreGraphics
import XCTest
@testable import MapleCore

final class NativeDetailLODTests: XCTestCase {
    func testNativeDetailStartsAtOneToOneOnly() {
        let visible = CGRect(x: 100, y: 200, width: 1200, height: 800)
        XCTAssertFalse(NativeDetailLOD.shouldRender(pixelScale: 0.999, visibleRect: visible))
        XCTAssertTrue(NativeDetailLOD.shouldRender(pixelScale: 1.0, visibleRect: visible))
        XCTAssertTrue(NativeDetailLOD.shouldRender(pixelScale: 2.0, visibleRect: visible))
        XCTAssertFalse(NativeDetailLOD.shouldRender(pixelScale: 1.0, visibleRect: .zero))
    }

    func testDetailRectRoundsOutwardAndClampsToSensor() {
        let detail = NativeDetailLOD.detailRect(
            visibleRect: CGRect(x: -0.4, y: 50.2, width: 1000.8, height: 799.3),
            imageSize: CGSize(width: 13000, height: 8000)
        )
        XCTAssertEqual(detail, CGRect(x: 0, y: 50, width: 1001, height: 800))
    }

    func testDecodeRectAddsOnlyBoundedHaloOnHundredMegapixelSource() {
        let detail = CGRect(x: 6000, y: 3500, width: 1200, height: 900)
        let decoded = NativeDetailLOD.decodeRect(
            detailRect: detail,
            imageSize: CGSize(width: 13000, height: 8000)
        )
        XCTAssertEqual(decoded, CGRect(x: 5904, y: 3404, width: 1392, height: 1092))
        XCTAssertLessThan(decoded.width * decoded.height, 1_600_000)
        XCTAssertLessThan(decoded.width * decoded.height, 13000 * 8000)
    }

    /// #2061d: a pathological viewport can produce a `detailRect` whose
    /// halo-expanded form exceeds Metal's 16384 texture-edge limit even
    /// after clamping to the image bounds. `decodeRect` must clamp its
    /// own output size (keeping origin fixed) so the tile FFI is never
    /// asked for a >16384 dimension.
    ///
    /// detail = (0,0,16300,9000); halo-inset grows to
    /// (-96,-96,16492,9192); intersecting with the 20000×12000 image
    /// bounds yields (0,0,16396,9096) — width 16396 is 12px over the
    /// 16384 ceiling, height 9096 is well under it.
    func testDecodeRectClampsToMetalMaxTextureEdge() {
        let detail = CGRect(x: 0, y: 0, width: 16300, height: 9000)
        let decoded = NativeDetailLOD.decodeRect(
            detailRect: detail,
            imageSize: CGSize(width: 20000, height: 12000)
        )
        XCTAssertEqual(
            decoded,
            CGRect(x: 0, y: 0, width: CanvasMath.metalMaxTextureEdge, height: 9096)
        )
    }

    func testDecodeRectClampsHaloAtImageEdges() {
        let detail = CGRect(x: 0, y: 0, width: 1000, height: 800)
        XCTAssertEqual(
            NativeDetailLOD.decodeRect(
                detailRect: detail,
                imageSize: CGSize(width: 4000, height: 3000)
            ),
            CGRect(x: 0, y: 0, width: 1096, height: 896)
        )
    }

    func testLocalCoreImageRectFlipsTopDownSourceY() {
        let decoded = CGRect(x: 900, y: 1800, width: 1200, height: 1000)
        let detail = CGRect(x: 1000, y: 2000, width: 800, height: 600)
        XCTAssertEqual(
            NativeDetailLOD.localCoreImageRect(
                detailRect: detail,
                decodeRect: decoded
            ),
            CGRect(x: 100, y: 200, width: 800, height: 600)
        )
    }

    // MARK: - #2063 pan-reuse margin (pure geometry)

    /// Unclamped case: 25% of the larger dimension (1600) is 400 — half of
    /// that (200) grows each edge.
    func testPanMarginIsQuarterOfLargerDimensionWhenUnclamped() {
        let visible = CGRect(x: 0, y: 0, width: 1600, height: 1000)
        XCTAssertEqual(NativeDetailLOD.panMargin(for: visible), 400, accuracy: 0.001)
    }

    /// Large viewport: 25% of 4000 is 1000, which exceeds the 512px
    /// ceiling — margin clamps to 512 regardless of dimension.
    func testPanMarginClampsToCeilingOnLargeViewport() {
        let visible = CGRect(x: 0, y: 0, width: 4000, height: 2600)
        XCTAssertEqual(NativeDetailLOD.panMargin(for: visible), 512, accuracy: 0.001)
    }

    /// Empty / null rects contribute no margin — no crash, no negative
    /// growth.
    func testPanMarginIsZeroForEmptyOrNullRect() {
        XCTAssertEqual(NativeDetailLOD.panMargin(for: .zero), 0)
        XCTAssertEqual(NativeDetailLOD.panMargin(for: .null), 0)
    }

    /// `patchRect` grows `detailRect` by half the margin on every edge —
    /// unclamped case, well away from any image boundary. The margin is
    /// sized from the LARGER dimension (1600) and applied to both axes, so
    /// the shorter (height) axis grows by the same absolute pixel count as
    /// the longer one, not by its own 25%.
    func testPatchRectGrowsDetailRectByHalfMarginPerEdge() {
        let visible = CGRect(x: 2000, y: 2000, width: 1600, height: 1000)
        let imageSize = CGSize(width: 13000, height: 8000)
        let base = NativeDetailLOD.detailRect(visibleRect: visible, imageSize: imageSize)
        let patch = NativeDetailLOD.patchRect(visibleRect: visible, imageSize: imageSize)
        // margin = 400 (25% of 1600) → 200px added to every edge.
        XCTAssertEqual(patch, base.insetBy(dx: -200, dy: -200))
    }

    /// For a SQUARE viewport the margin is 25% of both dimensions equally
    /// (there's no "shorter axis" to over-grow), so the developed area
    /// grows by exactly (1.25)^2 = 1.5625x — the representative "~1.5x"
    /// figure cited in the PR.
    func testPatchRectAreaGrowthOnSquareViewportMatchesQuotedMultiplier() {
        let visible = CGRect(x: 2000, y: 2000, width: 1200, height: 1200)
        let imageSize = CGSize(width: 13000, height: 8000)
        let base = NativeDetailLOD.detailRect(visibleRect: visible, imageSize: imageSize)
        let patch = NativeDetailLOD.patchRect(visibleRect: visible, imageSize: imageSize)
        let areaRatio = (patch.width * patch.height) / (base.width * base.height)
        XCTAssertEqual(areaRatio, 1.5625, accuracy: 0.001)
    }

    /// `patchRect` never exceeds the oriented image bounds — a viewport
    /// pinned to the top-left corner clamps the grown patch's origin at 0
    /// instead of going negative.
    func testPatchRectClampsToImageOriginAtTopLeftEdge() {
        let visible = CGRect(x: 0, y: 0, width: 1000, height: 800)
        let imageSize = CGSize(width: 4000, height: 3000)
        let patch = NativeDetailLOD.patchRect(visibleRect: visible, imageSize: imageSize)
        XCTAssertEqual(patch.minX, 0)
        XCTAssertEqual(patch.minY, 0)
        // margin = 250 (25% of 1000) → half-margin 125 grows the far edges.
        XCTAssertEqual(patch.width, 1125, accuracy: 0.001)
        XCTAssertEqual(patch.height, 925, accuracy: 0.001)
    }

    /// Same clamp at the bottom-right corner of the sensor.
    func testPatchRectClampsAtBottomRightEdge() {
        let imageSize = CGSize(width: 4000, height: 3000)
        let visible = CGRect(x: 3200, y: 2400, width: 800, height: 600)
        let patch = NativeDetailLOD.patchRect(visibleRect: visible, imageSize: imageSize)
        XCTAssertEqual(patch.maxX, 4000)
        XCTAssertEqual(patch.maxY, 3000)
    }

    /// A degenerate (empty) visible rect produces an empty patch — no
    /// margin is invented out of nothing.
    func testPatchRectIsEmptyForEmptyVisibleRect() {
        let patch = NativeDetailLOD.patchRect(
            visibleRect: .zero,
            imageSize: CGSize(width: 4000, height: 3000)
        )
        XCTAssertTrue(patch.isEmpty)
    }

    /// `patchRect`'s output always contains the un-grown `detailRect` for
    /// the same viewport — the containment fast path depends on the
    /// published patch being a strict superset of what was actually asked
    /// for.
    func testPatchRectAlwaysContainsUnmarginedDetailRect() {
        let imageSize = CGSize(width: 13000, height: 8000)
        let visible = CGRect(x: 5000, y: 3000, width: 1800, height: 1200)
        let base = NativeDetailLOD.detailRect(visibleRect: visible, imageSize: imageSize)
        let patch = NativeDetailLOD.patchRect(visibleRect: visible, imageSize: imageSize)
        XCTAssertTrue(patch.contains(base))
    }

    // MARK: - #2063 containment decision (as used by EditSession)

    /// A small pan whose new detail rect stays inside a previously
    /// published (margin-grown) patch is reported as contained.
    func testSmallPanDetailRectIsContainedInPublishedPatch() {
        let imageSize = CGSize(width: 13000, height: 8000)
        let firstViewport = CGRect(x: 2000, y: 2000, width: 1600, height: 1000)
        let publishedPatch = NativeDetailLOD.patchRect(visibleRect: firstViewport, imageSize: imageSize)
        // Pan 30px right, 20px down — well inside the ~200px margin.
        let pannedViewport = firstViewport.offsetBy(dx: 30, dy: 20)
        let newDetail = NativeDetailLOD.detailRect(visibleRect: pannedViewport, imageSize: imageSize)
        XCTAssertTrue(publishedPatch.contains(newDetail))
    }

    /// A pan larger than the margin escapes the published patch.
    func testLargePanDetailRectEscapesPublishedPatch() {
        let imageSize = CGSize(width: 13000, height: 8000)
        let firstViewport = CGRect(x: 2000, y: 2000, width: 1600, height: 1000)
        let publishedPatch = NativeDetailLOD.patchRect(visibleRect: firstViewport, imageSize: imageSize)
        // Pan 900px right — bigger than the ~200px margin on that edge.
        let pannedViewport = firstViewport.offsetBy(dx: 900, dy: 0)
        let newDetail = NativeDetailLOD.detailRect(visibleRect: pannedViewport, imageSize: imageSize)
        XCTAssertFalse(publishedPatch.contains(newDetail))
    }

}
