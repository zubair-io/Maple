// SceneLinearPipelineTests+Integration.swift — scene-linear decode + process integration
//
// Sibling to SceneLinearPipelineTests.swift. Extension methods on
// SceneLinearPipelineTests; shared helpers live on the base class.
// Split out of the original 3316-LOC file — see refs #134.

import XCTest
import CoreImage
import CoreGraphics
@testable import MapleCore

extension SceneLinearPipelineTests {

    /// End-to-end integration: synthesize a CIImage tagged
    /// extendedLinearITUR_2020, push it through `processSceneLinear`,
    /// and confirm the output extent matches `targetSize`. This locks
    /// down the Lanczos-prescale + AgX-kernel wire on a deterministic
    /// input (no fixture dependency).
    func testProcessSceneLinearAppliesPrescaleAndAgX() {
        let pipeline = ImageEditPipeline()
        let w = 100, h = 100
        // Synthesize a scene-linear Rec.2020 mid-gray (0.18 in all 3
        // channels) fp16 RGBA buffer.
        var pixels = [UInt16](repeating: 0, count: w * h * 4)
        let mid = Self.float32ToFloat16Bits(0.18)
        let one = Self.float32ToFloat16Bits(1.0)
        for i in stride(from: 0, to: pixels.count, by: 4) {
            pixels[i + 0] = mid
            pixels[i + 1] = mid
            pixels[i + 2] = mid
            pixels[i + 3] = one
        }
        let bytesPerRow = w * 4 * 2
        let data = pixels.withUnsafeBufferPointer {
            Data(bytes: $0.baseAddress!, count: $0.count * 2)
        }
        let space = CGColorSpace(name: CGColorSpace.extendedLinearITUR_2020)!
        let decoded = CIImage(
            bitmapData: data, bytesPerRow: bytesPerRow,
            size: CGSize(width: w, height: h),
            format: .RGBAh, colorSpace: space
        )
        let processed = pipeline.processSceneLinear(
            decoded: decoded,
            model: .default,
            targetSize: CGSize(width: 50, height: 50)
        )
        XCTAssertEqual(processed.extent.width, 50, accuracy: 0.01)
        XCTAssertEqual(processed.extent.height, 50, accuracy: 0.01)
    }

    /// EditSession routes through `processSceneLinear` when MAPLE_SCENE_LINEAR
    /// is set in the launching environment. We can't toggle env in-process,
    /// but we can invoke the pipeline directly — this test confirms that
    /// passing a pre-decoded scene-linear-tagged CIImage through
    /// `pipeline.processSceneLinear` produces a non-nil output extent that
    /// matches `targetSize`. The full env-gated EditSession flow is
    /// covered by manual A/B testing in Task 6 (the env var is set in the
    /// Maple.xcscheme).
    func testProcessSceneLinearProducesValidExtentForTargetSize() {
        let pipeline = ImageEditPipeline()
        let space = CGColorSpace(name: CGColorSpace.extendedLinearITUR_2020)!
        let decoded = CIImage(color: CIColor(red: 0.18, green: 0.18, blue: 0.18))
            .cropped(to: CGRect(x: 0, y: 0, width: 800, height: 600))
            .matchedToWorkingSpace(from: space) ?? CIImage(
                color: CIColor(red: 0.18, green: 0.18, blue: 0.18)
            ).cropped(to: CGRect(x: 0, y: 0, width: 800, height: 600))
        let out = pipeline.processSceneLinear(
            decoded: decoded,
            model: .default,
            targetSize: CGSize(width: 200, height: 200)
        )
        XCTAssertEqual(out.extent.width, 200, accuracy: 0.01)
        XCTAssertEqual(out.extent.height, 150, accuracy: 0.01)
    }

    /// Per ticket 06 § Acceptance Criteria, the sized FFI must:
    ///   - produce a buffer whose long edge equals the requested cap
    ///     (or stays at the source dimension if the source is smaller —
    ///      no upscale)
    ///   - return a non-nil CIImage with extent matching the buffer
    ///   - succeed for the standard EXIF orientation (smoke-tested via
    ///      the test_0002 fixture; orientation correctness on rotated
    ///      fixtures is covered by the existing apply_orientation tests
    ///      in raw-core)
    func testDecodeSceneLinearSizedRespectsCap() async throws {
        let fixturePath = URL(fileURLWithPath: #filePath)
            .deletingLastPathComponent().deletingLastPathComponent()
            .deletingLastPathComponent().deletingLastPathComponent()
            .deletingLastPathComponent().deletingLastPathComponent()
            .appendingPathComponent("raw-pipeline/test-fixtures/raws/test_0002.dng")
        guard FileManager.default.fileExists(atPath: fixturePath.path) else {
            throw XCTSkip("test_0002.dng absent — fixtures are gitignored")
        }
        let asset = AssetRef(url: fixturePath)
        let pipeline = ImageEditPipeline()
        let target = CGSize(width: 800, height: 600)
        guard let ci = await pipeline.decodeSceneLinearSized(asset: asset, targetSize: target).map(\.image) else {
            return XCTFail("decodeSceneLinearSized returned nil")
        }
        let w = ci.extent.width, h = ci.extent.height
        XCTAssertLessThanOrEqual(max(w, h), 800.001,
            "long edge \(max(w, h)) exceeds cap 800")
        XCTAssertGreaterThan(min(w, h), 0)
    }

    /// Per ticket 06 § Product Requirements 1: never upscale beyond
    /// the source. Demand 100k px on the long edge — far above any
    /// real RAW. The FFI must return at most the source's half-res
    /// dimensions.
    func testDecodeSceneLinearSizedNeverUpscalesBeyondSource() async throws {
        let fixturePath = URL(fileURLWithPath: #filePath)
            .deletingLastPathComponent().deletingLastPathComponent()
            .deletingLastPathComponent().deletingLastPathComponent()
            .deletingLastPathComponent().deletingLastPathComponent()
            .appendingPathComponent("raw-pipeline/test-fixtures/raws/test_0002.dng")
        guard FileManager.default.fileExists(atPath: fixturePath.path) else {
            throw XCTSkip("test_0002.dng absent")
        }
        let asset = AssetRef(url: fixturePath)
        let pipeline = ImageEditPipeline()
        guard let sized = await pipeline.decodeSceneLinearSized(
            asset: asset, targetSize: CGSize(width: 100_000, height: 100_000)
        ).map(\.image) else { return XCTFail("nil sized") }
        guard let unsized = await pipeline.decodeSceneLinear(
            asset: asset, quality: .preview
        ).map(\.image) else { return XCTFail("nil unsized") }
        XCTAssertEqual(sized.extent.width, unsized.extent.width, accuracy: 0.01)
        XCTAssertEqual(sized.extent.height, unsized.extent.height, accuracy: 0.01)
    }
}
