// RawCoreBridgeTests.swift — verifies the Apple-GPU strip helper (moved
// from Rust into the Swift binding under ticket #124) zeros the right
// fields, keeps the right ones, and produces an XMP that round-trips
// through `XMPParser` back to the same stripped model.

import Foundation
import XCTest
@testable import MapleCore

final class RawCoreBridgeTests: XCTestCase {

    /// Sample model with every field perturbed away from defaults so we
    /// can detect both "wasn't stripped" and "shouldn't have been
    /// stripped" mistakes in one test.
    private func sampleModel() -> AdjustmentModel {
        AdjustmentModel(
            temperature: 5200,
            tint: 8,
            exposure: 1.5,
            contrast: 25,
            highlights: -40,
            shadows: 30,
            whites: 12,
            blacks: -15,
            vibrance: 20,
            saturation: -10,
            clarity: 35,
            texture: 12,
            dehaze: 18,
            sharpenAmount: 70,
            sharpenRadius: 1.5,
            sharpenDetail: 60,
            sharpenMasking: 20,
            captureSharpeningAmount: 55,
            captureSharpeningSigma: 1.5,
            nrLuminance: 18,
            nrColor: 33,
            highlightRecovery: .blend
        )
    }

    func test_strip_zeroes_chain_replayed_fields() {
        let stripped = RawCoreBridge.stripAppleGPUStages(sampleModel())
        let d = AdjustmentModel()
        // White balance
        XCTAssertEqual(stripped.temperature, d.temperature)
        XCTAssertEqual(stripped.tint, d.tint)
        // Scene tone controls + AgX contrast
        XCTAssertEqual(stripped.exposure, d.exposure)
        XCTAssertEqual(stripped.contrast, d.contrast)
        XCTAssertEqual(stripped.highlights, d.highlights)
        XCTAssertEqual(stripped.shadows, d.shadows)
        XCTAssertEqual(stripped.whites, d.whites)
        XCTAssertEqual(stripped.blacks, d.blacks)
        // Presence
        XCTAssertEqual(stripped.vibrance, d.vibrance)
        XCTAssertEqual(stripped.saturation, d.saturation)
        XCTAssertEqual(stripped.clarity, d.clarity)
        XCTAssertEqual(stripped.texture, d.texture)
        XCTAssertEqual(stripped.dehaze, d.dehaze)
        // Noise reduction. nrLuminance default is 0, so the strip leaving
        // it at the default also leaves it at 0 (decode early-exits).
        XCTAssertEqual(stripped.nrLuminance, d.nrLuminance)
        XCTAssertEqual(stripped.nrLuminance, 0)
        // nrColor / sharpenAmount are forced to LITERAL 0 (#973), NOT the
        // 25 / 40 model defaults. Their defaults are non-zero and the Rust
        // decode only early-exits below 1e-3, so defaulting would run the
        // stage in the decode AND have Metal re-apply it post-AgX (a
        // ~9.3 s double-apply / over-process). Assert 0 explicitly so a
        // future reader doesn't "fix" the strip back to `d.nrColor` /
        // `d.sharpenAmount`.
        XCTAssertEqual(stripped.nrColor, 0)
        XCTAssertNotEqual(stripped.nrColor, d.nrColor,
                          "nrColor must be zeroed, not defaulted (#973)")
        // Sharpen amount only (radius / detail / masking are read by
        // Metal, not the chain, and Rust decode ignores them — kept as
        // pass-through for completeness; see test_strip_preserves_*).
        XCTAssertEqual(stripped.sharpenAmount, 0)
        XCTAssertNotEqual(stripped.sharpenAmount, d.sharpenAmount,
                          "sharpenAmount must be zeroed, not defaulted (#973)")
    }

    func test_strip_preserves_apple_irreplaceable_fields() {
        let original = sampleModel()
        let stripped = RawCoreBridge.stripAppleGPUStages(original)
        // highlightRecovery is pre-DCP — no Apple Metal equivalent.
        XCTAssertEqual(stripped.highlightRecovery, original.highlightRecovery)
        // sharpenRadius / sharpenDetail / sharpenMasking are read by the
        // post-chain Metal kernel using the live model; the decode
        // ignores them, so the strip leaves them alone.
        XCTAssertEqual(stripped.sharpenRadius, original.sharpenRadius)
        XCTAssertEqual(stripped.sharpenDetail, original.sharpenDetail)
        XCTAssertEqual(stripped.sharpenMasking, original.sharpenMasking)
        // captureSharpening* run inside the Rust decode (post-DCP) and have
        // no Apple Metal equivalent — kept so the live slider value reaches
        // the FFI decode.
        XCTAssertEqual(stripped.captureSharpeningAmount, original.captureSharpeningAmount)
        XCTAssertEqual(stripped.captureSharpeningSigma, original.captureSharpeningSigma)
    }

    func test_strip_is_idempotent() {
        let once = RawCoreBridge.stripAppleGPUStages(sampleModel())
        let twice = RawCoreBridge.stripAppleGPUStages(once)
        XCTAssertEqual(once, twice)
    }

    func test_withStrippedXMP_nil_input_passes_nil_through() throws {
        var observed: URL? = URL(fileURLWithPath: "/sentinel")
        try RawCoreBridge.withStrippedXMP(nil) { url in
            observed = url
        }
        XCTAssertNil(observed, "nil input must pass nil to body — FFI treats null as default model")
    }

    func test_withStrippedXMP_writes_temp_file_with_stripped_model_and_cleans_up() throws {
        // Write a real XMP at the input URL.
        let original = sampleModel()
        let originalXML = XMPSerializer.serialize(model: original, culling: CullingState())
        let inputURL = FileManager.default.temporaryDirectory
            .appendingPathComponent("rawcorebridge-test-\(UUID().uuidString).xmp")
        try originalXML.write(to: inputURL, atomically: true, encoding: .utf8)
        defer { try? FileManager.default.removeItem(at: inputURL) }

        // Capture the temp URL the helper hands the body and verify it
        // exists / round-trips correctly while body is running.
        var capturedTemp: URL?
        try RawCoreBridge.withStrippedXMP(inputURL) { tempURL in
            capturedTemp = tempURL
            guard let tempURL else {
                XCTFail("expected a temp XMP URL, got nil")
                return
            }
            XCTAssertTrue(FileManager.default.fileExists(atPath: tempURL.path),
                          "temp XMP must exist while body runs")
            let tempXML = try String(contentsOf: tempURL, encoding: .utf8)
            let (parsed, _) = try XMPParser.parse(tempXML)
            XCTAssertEqual(parsed, RawCoreBridge.stripAppleGPUStages(original),
                           "temp XMP must round-trip to the stripped model")
        }
        // After the body returns, the temp file must be gone.
        if let capturedTemp {
            XCTAssertFalse(FileManager.default.fileExists(atPath: capturedTemp.path),
                           "temp XMP must be deleted on body return")
        } else {
            XCTFail("temp URL was never captured")
        }
    }

    func test_withStrippedModelXMP_uses_live_model_and_cleans_up() throws {
        var original = sampleModel()
        original.profile = .auto
        var expected = RawCoreBridge.stripAppleGPUStages(original)
        expected.profile = .neutral
        expected.look = .default

        var capturedTemp: URL?
        try RawCoreBridge.withStrippedModelXMP(
            original,
            profileOverride: .neutral
        ) { tempURL in
            capturedTemp = tempURL
            guard let tempURL else {
                return XCTFail("live-model strip must produce a temp XMP")
            }
            let xml = try String(contentsOf: tempURL, encoding: .utf8)
            let (parsed, _) = try XMPParser.parse(xml)
            XCTAssertEqual(parsed, expected)
        }

        guard let capturedTemp else {
            return XCTFail("temp URL was never captured")
        }
        XCTAssertFalse(FileManager.default.fileExists(atPath: capturedTemp.path))
    }
}
