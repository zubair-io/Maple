import XCTest
@testable import MapleCore

/// Coverage for the on-device histogram path (`PipelineRenderer.histogram` +
/// `LocalHistogram.compute`) that backs the Info panel's HistogramBlock for
/// local / PhotoKit assets — i.e. the path that makes the histogram work on
/// Mac / iPad / iPhone without a Self-Hosted server.
final class LocalHistogramTests: XCTestCase {
    /// Repo-root `test-fixtures/raws/test_0002.dng`, mirroring the navigation
    /// in `MapleCoreTests.testPipelineRendererRealFile`.
    private func fixtureDNG() -> URL {
        URL(fileURLWithPath: #filePath)
            .deletingLastPathComponent()  // MapleCoreTests
            .deletingLastPathComponent()  // Tests
            .deletingLastPathComponent()  // MapleCore
            .deletingLastPathComponent()  // Packages
            .deletingLastPathComponent()  // apple
            .deletingLastPathComponent()  // src
            .deletingLastPathComponent()  // repo root
            .appendingPathComponent("test-fixtures/raws/test_0002.dng")
    }

    /// Undecodable bytes must surface a non-zero FFI status as a thrown
    /// `PipelineError.renderFailed`, never a partial/garbage histogram. No
    /// fixture required.
    func testHistogramGarbageBytesThrows() {
        let garbage = Data([0x00, 0x01, 0x02, 0x03, 0x04, 0x05, 0x06, 0x07])
        XCTAssertThrowsError(
            try PipelineRenderer.histogram(rawBytes: garbage, hint: "dng", xmpDocument: nil)
        ) { error in
            guard let pe = error as? PipelineError,
                  case .renderFailed(let code, _) = pe else {
                XCTFail("Expected PipelineError.renderFailed, got \(error)")
                return
            }
            XCTAssertNotEqual(code, 0)
        }
    }

    /// Happy path through the bytes FFI: three 256-bin channels, and — since
    /// every surviving pixel contributes exactly one sample per channel — all
    /// three channel sums are equal and non-zero. Fixture-gated.
    func testHistogramRealBytes() throws {
        let fixture = fixtureDNG()
        guard FileManager.default.fileExists(atPath: fixture.path) else {
            throw XCTSkip("test_0002.dng fixture not present: \(fixture.path)")
        }
        let bytes = try Data(contentsOf: fixture)
        let h = try PipelineRenderer.histogram(rawBytes: bytes, hint: "dng", xmpDocument: nil)
        XCTAssertEqual(h.r.count, 256)
        XCTAssertEqual(h.g.count, 256)
        XCTAssertEqual(h.b.count, 256)
        let rSum = h.r.reduce(0, +)
        let gSum = h.g.reduce(0, +)
        let bSum = h.b.reduce(0, +)
        XCTAssertGreaterThan(rSum, 0, "expected a non-empty histogram")
        XCTAssertEqual(rSum, gSum, "R and G sums must equal the pixel count")
        XCTAssertEqual(gSum, bSum, "G and B sums must equal the pixel count")
    }

    /// End-to-end local path a filesystem asset takes: `LocalHistogram.compute`
    /// reads the RAW off disk, serialises the (default) model to XMP, and bins
    /// the develop. Fixture-gated.
    func testLocalHistogramComputeRealFile() async throws {
        let fixture = fixtureDNG()
        guard FileManager.default.fileExists(atPath: fixture.path) else {
            throw XCTSkip("test_0002.dng fixture not present: \(fixture.path)")
        }
        let asset = AssetRef(url: fixture)
        let h = try await LocalHistogram.compute(
            asset: asset,
            model: .default,
            culling: CullingState()
        )
        XCTAssertEqual(h.r.count, 256)
        XCTAssertEqual(h.g.count, 256)
        XCTAssertEqual(h.b.count, 256)
        XCTAssertGreaterThan(h.r.reduce(0, +), 0, "expected a non-empty histogram")
    }
}
