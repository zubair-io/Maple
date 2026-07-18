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

}
