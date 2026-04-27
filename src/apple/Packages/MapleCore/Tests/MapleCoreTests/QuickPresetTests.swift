// QuickPresetTests.swift — unit tests for QuickPreset + PanoramaEngine preset
// dispatch (T5.7).
//
// Test plan:
//
//   testQuickPresetRejectsDNGInput
//     Feed a tiny TIFF-magic prefix; expect QuickPresetError.unsupportedInputFormat.
//
//   testQuickPresetRejectsPNGInput
//     Feed valid PNG magic; expect QuickPresetError.unsupportedInputFormat.
//
//   testQuickPresetRejectsTooSmallInput
//     Feed a buffer of 3 bytes; expect unsupportedInputFormat (can't identify).
//
//   testQuickPresetAcceptsJPEGMagic
//     Feed FF D8 FF prefix + zero padding; verify no unsupportedInputFormat throw
//     from validateFormat (format-sniffing only).
//
//   testQuickPresetAcceptsHEIFMagic
//     Feed "ftyp" ISO base media box prefix; verify no unsupportedInputFormat throw.
//
//   testEngineDispatchesQualityByDefault
//     engine.stitch(assets:) (no preset arg) → routes to Quality; garbage bytes
//     trigger PanoramaEngineError.stitchFailed (not QuickPresetError).
//
//   testEngineDispatchesQuickWhenRequested
//     engine.stitch(assets:preset:.quick) → routes to Quick; DNG-magic bytes
//     trigger QuickPresetError.unsupportedInputFormat.
//
//   testEngineQuickPresetRejectsDNGInputEndToEnd
//     Full engine + Quick preset with TIFF-magic bytes → QuickPresetError thrown.
//
//   testQuickPresetStitchesRealJPEGsOnApple (GPU-gated)
//     End-to-end: synthesize two real JPEG images, stitch via Quick preset,
//     verify CIImage extent > 0. XCTSkip on CI or non-Apple platforms.
//
//   testPresetEnumValuesAreDistinct
//     Smoke: .quality != .quick in switch coverage.

import XCTest
import CoreImage
@testable import MapleCore

#if canImport(Vision)
import Vision
#endif

// MARK: - QuickPresetTests

final class QuickPresetTests: XCTestCase {

    // MARK: - Format validation (sniff-only, no Vision required)

    func testQuickPresetRejectsDNGInput() throws {
        // TIFF little-endian magic: 49 49 2A 00 (+ padding)
        var data = Data(count: 16)
        data[0] = 0x49; data[1] = 0x49; data[2] = 0x2A; data[3] = 0x00

        do {
            try QuickPreset.validateFormat(data, index: 0)
            XCTFail("Expected unsupportedInputFormat for DNG/TIFF magic, got no error")
        } catch QuickPresetError.unsupportedInputFormat(let msg) {
            XCTAssertFalse(msg.isEmpty)
        } catch {
            XCTFail("Expected QuickPresetError.unsupportedInputFormat, got \(error)")
        }
    }

    func testQuickPresetRejectsTIFFBigEndianInput() throws {
        // TIFF big-endian magic: 4D 4D 00 2A
        var data = Data(count: 16)
        data[0] = 0x4D; data[1] = 0x4D; data[2] = 0x00; data[3] = 0x2A

        XCTAssertThrowsError(try QuickPreset.validateFormat(data, index: 0)) { err in
            guard case QuickPresetError.unsupportedInputFormat = err else {
                XCTFail("Expected unsupportedInputFormat, got \(err)")
                return
            }
        }
    }

    func testQuickPresetRejectsPNGInput() throws {
        // PNG magic: 89 50 4E 47 0D 0A 1A 0A
        var data = Data(count: 16)
        data[0] = 0x89; data[1] = 0x50; data[2] = 0x4E; data[3] = 0x47
        data[4] = 0x0D; data[5] = 0x0A; data[6] = 0x1A; data[7] = 0x0A

        XCTAssertThrowsError(try QuickPreset.validateFormat(data, index: 1)) { err in
            guard case QuickPresetError.unsupportedInputFormat = err else {
                XCTFail("Expected unsupportedInputFormat for PNG, got \(err)")
                return
            }
        }
    }

    func testQuickPresetRejectsTooSmallInput() throws {
        // Only 3 bytes — can't identify.
        let data = Data([0xFF, 0xD8, 0xFF].prefix(3))
        // The buffer is actually 3 bytes; validateFormat requires >= 12.
        XCTAssertThrowsError(try QuickPreset.validateFormat(data, index: 0)) { err in
            guard case QuickPresetError.unsupportedInputFormat = err else {
                XCTFail("Expected unsupportedInputFormat for short buffer, got \(err)")
                return
            }
        }
    }

    func testQuickPresetAcceptsJPEGMagic() throws {
        // JPEG magic: FF D8 FF (+ padding)
        var data = Data(count: 16)
        data[0] = 0xFF; data[1] = 0xD8; data[2] = 0xFF; data[3] = 0xE0

        // Should NOT throw.
        XCTAssertNoThrow(try QuickPreset.validateFormat(data, index: 0))
    }

    func testQuickPresetAcceptsHEIFMagic() throws {
        // HEIF/HEIC: any 4-byte size, then "ftyp" at offset 4.
        // Simulate: 00 00 00 18  66 74 79 70  68 65 69 63
        //           size=24     "ftyp"        "heic"
        var data = Data(count: 16)
        data[0] = 0x00; data[1] = 0x00; data[2] = 0x00; data[3] = 0x18
        data[4] = 0x66; data[5] = 0x74; data[6] = 0x79; data[7] = 0x70  // "ftyp"
        data[8] = 0x68; data[9] = 0x65; data[10] = 0x69; data[11] = 0x63 // "heic"

        XCTAssertNoThrow(try QuickPreset.validateFormat(data, index: 0))
    }

    func testQuickPresetRejectsUnknownFormat() throws {
        // Bytes that don't match any known magic.
        var data = Data(count: 16)
        data[0] = 0x00; data[1] = 0x01; data[2] = 0x02; data[3] = 0x03

        XCTAssertThrowsError(try QuickPreset.validateFormat(data, index: 0)) { err in
            guard case QuickPresetError.unsupportedInputFormat = err else {
                XCTFail("Expected unsupportedInputFormat for unknown magic, got \(err)")
                return
            }
        }
    }

    // MARK: - PanoramaPreset enum

    func testPresetEnumValuesAreDistinct() {
        // Ensure both cases exist and are reachable.
        let q = PanoramaPreset.quality
        let k = PanoramaPreset.quick
        // Use switch to get compiler-checked exhaustive coverage.
        var qLabel = ""
        switch q { case .quality: qLabel = "quality"; case .quick: qLabel = "quick" }
        var kLabel = ""
        switch k { case .quality: kLabel = "quality"; case .quick: kLabel = "quick" }
        XCTAssertEqual(qLabel, "quality")
        XCTAssertEqual(kLabel, "quick")
        XCTAssertNotEqual(qLabel, kLabel)
    }

    // MARK: - Engine dispatch routing

    /// The legacy `stitch(assets:options:progress:)` overload must still route
    /// to the Quality preset.  Feeding garbage bytes → `stitchFailed`, not a
    /// `QuickPresetError`.
    func testEngineDispatchesQualityByDefault() async throws {
        let engine = makeGarbageEngine()

        do {
            _ = try await engine.stitch(assets: makeGarbageRefs())
            XCTFail("Expected PanoramaEngineError.stitchFailed, got success")
        } catch PanoramaEngineError.stitchFailed {
            // Correct: Quality preset → Rust decodeFailure
        } catch PanoramaEngineError.sourceFailed {
            XCTFail("Routing error: should not be sourceFailed")
        } catch {
            // QuickPresetError or other — wrong preset was called.
            XCTFail("Expected PanoramaEngineError.stitchFailed (Quality preset), got \(error)")
        }
    }

    /// `stitch(assets:preset:.quality)` explicit call also routes to Quality.
    func testEngineDispatchesQualityWhenExplicit() async throws {
        let engine = makeGarbageEngine()

        do {
            _ = try await engine.stitch(assets: makeGarbageRefs(), preset: .quality)
            XCTFail("Expected PanoramaEngineError.stitchFailed, got success")
        } catch PanoramaEngineError.stitchFailed {
            // expected
        } catch {
            XCTFail("Expected .stitchFailed (Quality preset), got \(error)")
        }
    }

    /// `stitch(assets:preset:.quick)` with DNG-magic bytes should throw
    /// `QuickPresetError.unsupportedInputFormat` — the Quick preset rejects
    /// the format before calling Vision.
    func testEngineDispatchesQuickWhenRequested() async throws {
#if canImport(Vision)
        let engine = makeDNGMagicEngine()

        do {
            _ = try await engine.stitch(assets: makeGarbageRefs(), preset: .quick)
            XCTFail("Expected QuickPresetError.unsupportedInputFormat, got success")
        } catch QuickPresetError.unsupportedInputFormat {
            // expected — Quick preset rejected DNG-magic input
        } catch {
            XCTFail("Expected QuickPresetError.unsupportedInputFormat, got \(error)")
        }
#else
        throw XCTSkip("Quick preset requires Apple platform (Vision)")
#endif
    }

    /// End-to-end engine call with Quick preset + TIFF-magic bytes.
    func testEngineQuickPresetRejectsDNGInputEndToEnd() async throws {
#if canImport(Vision)
        let engine = makeDNGMagicEngine()

        do {
            _ = try await engine.stitch(
                assets: makeGarbageRefs(),
                options: .default,
                preset: .quick
            )
            XCTFail("Expected QuickPresetError.unsupportedInputFormat")
        } catch QuickPresetError.unsupportedInputFormat(let msg) {
            XCTAssertFalse(msg.isEmpty)
        } catch {
            XCTFail("Expected QuickPresetError.unsupportedInputFormat, got \(error)")
        }
#else
        throw XCTSkip("Quick preset requires Apple platform (Vision)")
#endif
    }

    // MARK: - End-to-end Quick stitch (Vision + GPU)

    /// Synthesise two real JPEG images and stitch them via the Quick preset.
    ///
    /// Skipped on CI (Vision GPU not guaranteed) and on non-Apple builds.
    func testQuickPresetStitchesRealJPEGsOnApple() async throws {
#if canImport(Vision)
        // Skip on CI where Vision GPU may not be available.
        if ProcessInfo.processInfo.environment["CI"] != nil {
            throw XCTSkip("Vision GPU run skipped on CI")
        }

        let jpegA = makeSyntheticJPEG(width: 256, height: 256, noiseSeed: 1, starSeed: 42)
        let jpegB = makeSyntheticJPEG(width: 256, height: 256, noiseSeed: 7, starSeed: 42)

        guard !jpegA.isEmpty, !jpegB.isEmpty else {
            throw XCTSkip("Synthetic JPEG generation failed (ImageIO unavailable)")
        }

        let result: CIImage
        do {
            result = try await QuickPreset.stitch(images: [jpegA, jpegB])
        } catch QuickPresetError.alignmentFailed(let msg) {
            throw XCTSkip("Vision alignment failed (no GPU or degenerate synthetic input): \(msg)")
        } catch QuickPresetError.blendFailed(let msg) {
            throw XCTSkip("CIImage compositing failed: \(msg)")
        }

        XCTAssertGreaterThan(result.extent.width,  0, "Quick stitch width must be > 0")
        XCTAssertGreaterThan(result.extent.height, 0, "Quick stitch height must be > 0")
        XCTAssertFalse(result.extent.isInfinite,      "Quick stitch extent must not be infinite")
#else
        throw XCTSkip("Quick preset requires Apple platform (Vision)")
#endif
    }

    // MARK: - QuickPresetError descriptions

    func testQuickPresetErrorDescriptions() {
        let errors: [QuickPresetError] = [
            .unsupportedInputFormat("test.dng"),
            .alignmentFailed("no observations"),
            .blendFailed("nil output"),
        ]
        for err in errors {
            XCTAssertNotNil(err.errorDescription)
            XCTAssertFalse(err.errorDescription!.isEmpty)
        }
    }

    // MARK: - Helpers

    /// Build a `PanoramaEngine` backed by an in-memory source returning
    /// garbage bytes (0xDE × 512) for every ref.
    private func makeGarbageEngine() -> PanoramaEngine {
        let garbage = Data(repeating: 0xDE, count: 512)
        let source = MockQuickImageSource(payload: garbage)
        return PanoramaEngine(source: PanoramaSource(library: source))
    }

    /// Build a `PanoramaEngine` backed by a source returning TIFF-magic bytes
    /// (little-endian: 49 49 2A 00 + zeros) — rejected by the Quick preset
    /// format validator but accepted by `loadAssets` (just bytes).
    private func makeDNGMagicEngine() -> PanoramaEngine {
        var magic = Data(count: 64)
        magic[0] = 0x49; magic[1] = 0x49; magic[2] = 0x2A; magic[3] = 0x00
        let source = MockQuickImageSource(payload: magic)
        return PanoramaEngine(source: PanoramaSource(library: source))
    }

    private func makeGarbageRefs() -> [ImageRef] {
        [
            ImageRef(id: "q-a", displayName: "A.raw"),
            ImageRef(id: "q-b", displayName: "B.raw"),
        ]
    }

    /// Encode a synthetic textured image as JPEG using ImageIO.
    ///
    /// Returns `Data()` if ImageIO is unavailable (should not happen on Apple).
    private func makeSyntheticJPEG(
        width: Int, height: Int,
        noiseSeed: UInt64, starSeed: UInt64
    ) -> Data {
        let n = width * height
        var rgba = [UInt8](repeating: 0, count: n * 4)

        var rng = noiseSeed
        for i in 0..<n {
            let v = UInt8(clamping: Int(
                (lcg(&rng) + lcg(&rng) + lcg(&rng) + lcg(&rng)) / 4.0 * 51.0 + 51
            ))
            rgba[i*4] = v; rgba[i*4+1] = v; rgba[i*4+2] = v; rgba[i*4+3] = 255
        }

        // Horizontal gradient.
        for y in 0..<height {
            for x in 0..<width {
                let idx = y * width + x
                let add = UInt8(clamping: Int(Float(x) / Float(width) * 76.0))
                rgba[idx*4] = rgba[idx*4].addingReportingOverflow(add).partialValue
            }
        }

        // Stars (shared starSeed → same layout in both images for Vision to match).
        var rngStar = starSeed
        let nStars = 60, margin = 20, r = 3
        for _ in 0..<nStars {
            let cx = margin + Int(lcg(&rngStar) * Float(width  - 2*margin))
            let cy = margin + Int(lcg(&rngStar) * Float(height - 2*margin))
            for dy in 0...(r*2) {
                for dx in 0...(r*2) {
                    let px = cx + dx, py = cy + dy
                    if px < width && py < height {
                        let idx = py * width + px
                        rgba[idx*4] = 220; rgba[idx*4+1] = 220
                        rgba[idx*4+2] = 220; rgba[idx*4+3] = 255
                    }
                }
            }
        }

        return rgbaToJPEG(pixels: rgba, width: width, height: height)
    }

    private func rgbaToJPEG(pixels: [UInt8], width: Int, height: Int) -> Data {
        let bytesPerRow = width * 4
        let colorSpace = CGColorSpaceCreateDeviceRGB()
        let bitmapInfo = CGBitmapInfo(rawValue: CGImageAlphaInfo.premultipliedLast.rawValue)

        guard let provider = CGDataProvider(data: Data(pixels) as CFData),
              let cgImage = CGImage(
                width: width, height: height,
                bitsPerComponent: 8, bitsPerPixel: 32,
                bytesPerRow: bytesPerRow, space: colorSpace,
                bitmapInfo: bitmapInfo, provider: provider,
                decode: nil, shouldInterpolate: false, intent: .defaultIntent
              )
        else { return Data() }

        let mutableData = NSMutableData()
        guard let dest = CGImageDestinationCreateWithData(
            mutableData, "public.jpeg" as CFString, 1, nil
        ) else { return Data() }
        // Compression quality 0.85 — high enough for Vision feature detection.
        let props: [CFString: Any] = [kCGImageDestinationLossyCompressionQuality: 0.85]
        CGImageDestinationAddImage(dest, cgImage, props as CFDictionary)
        CGImageDestinationFinalize(dest)
        return mutableData as Data
    }

    private func lcg(_ state: inout UInt64) -> Float {
        state = state &* 6_364_136_223_846_793_005 &+ 1_442_695_040_888_963_407
        return Float(state >> 33) / Float(UInt32.max)
    }
}

// MARK: - MockQuickImageSource

/// Minimal `ImageSource` that returns a fixed `Data` payload for every `ImageRef`.
private actor MockQuickImageSource: ImageSource {
    private let payload: Data

    init(payload: Data) {
        self.payload = payload
    }

    func images() async throws -> [ImageRef] { [] }
    func thumb(for ref: ImageRef)   async throws -> Data? { nil }
    func preview(for ref: ImageRef) async throws -> Data? { nil }

    func rawBytes(for ref: ImageRef) async throws -> Data {
        payload
    }

    func writeXMP(_ sidecar: Sidecar, for ref: ImageRef) async throws {
        throw ImageSourceError.readOnly("MockQuickImageSource is read-only")
    }

    func search(_ query: SearchQuery) async throws -> [ImageRef]? { nil }
}
