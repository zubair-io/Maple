import XCTest
@testable import MapleCore

final class MapleCoreTests: XCTestCase {
    func testVersionStringIsSane() {
        let v = MapleCore.version()
        XCTAssertTrue(v.contains("MapleCore"), "version string was \(v)")
    }

    // MARK: - PipelineRenderer

    func testPipelineRendererNonExistentFile() {
        let fake = URL(fileURLWithPath: "/tmp/does_not_exist_maple_test.dng")
        XCTAssertThrowsError(try PipelineRenderer.render(rawPath: fake)) { error in
            guard let pe = error as? PipelineError,
                  case .renderFailed(let code, _) = pe else {
                XCTFail("Expected PipelineError.renderFailed, got \(error)")
                return
            }
            XCTAssertNotEqual(code, 0)
        }
    }

    func testMapleImageDataRgbAccessor() {
        // Build a synthetic 2x1 red image the manual way for unit-level coverage.
        let pixels = Data([255, 0, 0,  0, 255, 0]) // pixel 0 = red, pixel 1 = green
        let img = MapleImageData(width: 2, height: 1, pixels: pixels)
        XCTAssertEqual(img.pixelCount, 2)
        let (r0, g0, b0) = img.rgb(x: 0, y: 0)
        XCTAssertEqual(r0, 255); XCTAssertEqual(g0, 0); XCTAssertEqual(b0, 0)
        let (r1, g1, b1) = img.rgb(x: 1, y: 0)
        XCTAssertEqual(r1, 0); XCTAssertEqual(g1, 255); XCTAssertEqual(b1, 0)
    }

    /// Integration test — skipped if test fixture not present.
    func testPipelineRendererRealFile() throws {
        let fixture = URL(fileURLWithPath: #file)
            .deletingLastPathComponent()   // MapleCoreTests/
            .deletingLastPathComponent()   // Tests/
            .deletingLastPathComponent()   // maple-native/
            .deletingLastPathComponent()   // src/
            .appendingPathComponent("test-fixtures/raws/test_0002.dng")
        guard FileManager.default.fileExists(atPath: fixture.path) else {
            throw XCTSkip("test fixture not present: \(fixture.path)")
        }
        let image = try PipelineRenderer.render(rawPath: fixture)
        XCTAssertGreaterThan(image.width, 0)
        XCTAssertGreaterThan(image.height, 0)
        XCTAssertEqual(image.pixels.count, image.width * image.height * 3)
    }
}
