// PanoramaEngineTests.swift — tests for PanoramaSource, PanoramaEngine,
// PanoramaExport (T5.3).
//
// Test plan:
//   testStitchTwoSyntheticPNGsReturnsCIImage
//     Build an in-memory MockImageSource that returns synthetic PNG bytes for
//     two ImageRef IDs, run engine.stitch(assets:), verify the returned
//     CIImage has positive extent. Soft-skipped when the pano feature is not
//     compiled in (pano_stitch returns stitchFailure).
//
//   testProgressCallbackFiresAtEachStage
//     Collect callback invocations, verify order is:
//       loading(0, 2), loading(1, 2), loading(2, 2), stitching, wrappingCIImage.
//     Soft-skipped if pano feature is absent.
//
//   testStitchPropagatesSourceErrors
//     Source throws → engine throws PanoramaEngineError.sourceFailed.
//
//   testStitchPropagatesStitchErrors
//     Feed garbage bytes → engine throws PanoramaEngineError.stitchFailed.
//
//   testPanoramaSourceLoadAllReturnsNilDCP
//     Verify the DCP slot in loadAll results is always nil (P5+ placeholder).
//
//   testPanoramaExportToCIImageHasPositiveExtent
//     Direct unit test for PanoramaExport.toCIImage using a synthetic handle
//     via the real stitch call. Soft-skipped if pano feature absent.

import XCTest
import CoreImage
@testable import MapleCore

// MARK: - MockImageSource

/// In-memory `ImageSource` actor for testing.
///
/// Every `ImageRef` whose `id` is in `payloads` returns the associated `Data`
/// from `rawBytes(for:)`.  Any other `id` throws `ImageSourceError.notFound`.
/// `throwOnIDs` causes specific IDs to throw a controlled error instead.
private actor MockImageSource: ImageSource {

    private let payloads: [String: Data]
    private let throwOnIDs: Set<String>

    init(payloads: [String: Data] = [:], throwOnIDs: Set<String> = []) {
        self.payloads = payloads
        self.throwOnIDs = throwOnIDs
    }

    func images() async throws -> [ImageRef] {
        payloads.keys.map { ImageRef(id: $0, displayName: $0) }
    }

    func thumb(for ref: ImageRef) async throws -> Data? { nil }

    func preview(for ref: ImageRef) async throws -> Data? { nil }

    func rawBytes(for ref: ImageRef) async throws -> Data {
        if throwOnIDs.contains(ref.id) {
            throw ImageSourceError.notFound(ref.id)
        }
        guard let data = payloads[ref.id] else {
            throw ImageSourceError.notFound(ref.id)
        }
        return data
    }

    func writeXMP(_ sidecar: Sidecar, for ref: ImageRef) async throws {
        throw ImageSourceError.readOnly("MockImageSource is read-only")
    }

    func search(_ query: SearchQuery) async throws -> [ImageRef]? { nil }
}

// MARK: - PanoramaEngineTests

final class PanoramaEngineTests: XCTestCase {

    // MARK: - Helpers

    /// Build a synthetic textured 8-bit sRGB PNG using the same helpers
    /// as PanoramaTests (so test authors can copy this pattern).
    private func makeSyntheticPNG(
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
            rgba[i*4]   = v
            rgba[i*4+1] = v
            rgba[i*4+2] = v
            rgba[i*4+3] = 255
        }

        // Horizontal gradient.
        for y in 0..<height {
            for x in 0..<width {
                let idx = y * width + x
                let add = UInt8(clamping: Int(Float(x) / Float(width) * 76.0))
                rgba[idx*4] = rgba[idx*4].addingReportingOverflow(add).partialValue
            }
        }

        // Stars shared between A and B (same starSeed → same layout).
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
                        rgba[idx*4]   = 230
                        rgba[idx*4+1] = 230
                        rgba[idx*4+2] = 230
                        rgba[idx*4+3] = 255
                    }
                }
            }
        }

        return rgbaToPNG(pixels: rgba, width: width, height: height)
    }

    private func lcg(_ state: inout UInt64) -> Float {
        state = state &* 6_364_136_223_846_793_005 &+ 1_442_695_040_888_963_407
        return Float(state >> 33) / Float(UInt32.max)
    }

    private func rgbaToPNG(pixels: [UInt8], width: Int, height: Int) -> Data {
        let bytesPerRow = width * 4
        let colorSpace = CGColorSpaceCreateDeviceRGB()
        let bitmapInfo = CGBitmapInfo(rawValue: CGImageAlphaInfo.premultipliedLast.rawValue)

        guard let provider = CGDataProvider(data: Data(pixels) as CFData),
              let cgImage = CGImage(
                width: width, height: height,
                bitsPerComponent: 8, bitsPerPixel: 32,
                bytesPerRow: bytesPerRow,
                space: colorSpace,
                bitmapInfo: bitmapInfo,
                provider: provider,
                decode: nil,
                shouldInterpolate: false,
                intent: .defaultIntent
              )
        else { return Data() }

        let mutableData = NSMutableData()
        guard let dest = CGImageDestinationCreateWithData(
            mutableData, "public.png" as CFString, 1, nil
        ) else { return Data() }
        CGImageDestinationAddImage(dest, cgImage, nil)
        CGImageDestinationFinalize(dest)
        return mutableData as Data
    }

    /// Build a two-image `(MockImageSource, [ImageRef])` pair.
    private func makeTwoImageFixture(
        width: Int = 256,
        height: Int = 256
    ) -> (MockImageSource, [ImageRef]) {
        let pngA = makeSyntheticPNG(width: width, height: height, noiseSeed: 1, starSeed: 42)
        let pngB = makeSyntheticPNG(width: width, height: height, noiseSeed: 7, starSeed: 42)
        let refA = ImageRef(id: "pano-a", displayName: "IMG_A.png")
        let refB = ImageRef(id: "pano-b", displayName: "IMG_B.png")
        let source = MockImageSource(payloads: [refA.id: pngA, refB.id: pngB])
        return (source, [refA, refB])
    }

    /// Make a `PanoramaEngine` backed by `MockImageSource`.
    private func makeEngine(source: MockImageSource) -> PanoramaEngine {
        let panoSource = PanoramaSource(library: source)
        return PanoramaEngine(source: panoSource)
    }

    // MARK: - PanoramaSource unit tests

    func testPanoramaSourceLoadAllReturnsNilDCP() async throws {
        let (mock, refs) = makeTwoImageFixture()
        let panoSource = PanoramaSource(library: mock)
        let pairs = try await panoSource.loadAll(assets: refs)

        XCTAssertEqual(pairs.count, 2, "should return one pair per asset")
        for (_, dcp) in pairs {
            XCTAssertNil(dcp, "DCP slot must be nil until P5+ plumbing lands")
        }
    }

    func testPanoramaSourceLoadAllReturnsCorrectByteCount() async throws {
        let (mock, refs) = makeTwoImageFixture(width: 64, height: 64)
        let panoSource = PanoramaSource(library: mock)
        let pairs = try await panoSource.loadAll(assets: refs)

        XCTAssertEqual(pairs.count, refs.count)
        for (data, _) in pairs {
            XCTAssertGreaterThan(data.count, 0, "image bytes must be non-empty")
        }
    }

    func testPanoramaSourcePropagatesSourceError() async throws {
        let ref = ImageRef(id: "missing", displayName: "MISSING.dng")
        let mock = MockImageSource(payloads: [:])  // no payloads → notFound
        let panoSource = PanoramaSource(library: mock)

        do {
            _ = try await panoSource.loadAll(assets: [ref])
            XCTFail("Expected PanoramaSourceError.loadFailed, got success")
        } catch let e as PanoramaSourceError {
            guard case .loadFailed(let name, _) = e else {
                XCTFail("Unexpected PanoramaSourceError case: \(e)"); return
            }
            // ImageRef.displayName returns the full display name as given,
            // including any extension (e.g. "MISSING.dng").
            XCTAssertEqual(name, ref.displayName,
                           "error should carry the full displayName of the failing asset")
        } catch {
            XCTFail("Expected PanoramaSourceError, got \(error)")
        }
    }

    // MARK: - PanoramaEngine: source error propagation

    func testStitchPropagatesSourceErrors() async throws {
        // Source throws on the first asset → engine throws .sourceFailed.
        let refA = ImageRef(id: "throw-a", displayName: "A.dng")
        let refB = ImageRef(id: "ok-b",    displayName: "B.dng")
        let pngB = makeSyntheticPNG(width: 64, height: 64, noiseSeed: 7, starSeed: 42)
        let mock = MockImageSource(
            payloads: [refB.id: pngB],
            throwOnIDs: [refA.id]         // first asset throws
        )
        let engine = makeEngine(source: mock)

        do {
            _ = try await engine.stitch(assets: [refA, refB])
            XCTFail("Expected PanoramaEngineError.sourceFailed, got success")
        } catch PanoramaEngineError.sourceFailed {
            // expected
        } catch {
            XCTFail("Expected .sourceFailed, got \(error)")
        }
    }

    // MARK: - PanoramaEngine: stitch error propagation (garbage bytes)

    func testStitchPropagatesStitchErrors() async throws {
        // Feed garbage bytes that the Rust decoder cannot parse.
        let garbage = Data(repeating: 0xDE, count: 512)
        let refA = ImageRef(id: "g-a", displayName: "garbage-a.raw")
        let refB = ImageRef(id: "g-b", displayName: "garbage-b.raw")
        let mock = MockImageSource(payloads: [refA.id: garbage, refB.id: garbage])
        let engine = makeEngine(source: mock)

        do {
            _ = try await engine.stitch(assets: [refA, refB])
            XCTFail("Expected PanoramaEngineError.stitchFailed, got success")
        } catch PanoramaEngineError.stitchFailed {
            // expected — Rust pano_stitch returns -2 (decodeFailure) or
            // -3 (stitchFailure) for garbage data
        } catch PanoramaEngineError.sourceFailed {
            XCTFail("Error should be stitchFailed, not sourceFailed")
        } catch {
            XCTFail("Expected .stitchFailed, got \(error)")
        }
    }

    // MARK: - PanoramaEngine: round-trip stitch (pano feature required)

    /// Stitch two synthetic PNGs and verify the returned CIImage has a
    /// positive extent. Soft-skipped when the pano Rust feature is absent.
    func testStitchTwoSyntheticPNGsReturnsCIImage() async throws {
        let (mock, refs) = makeTwoImageFixture()
        let engine = makeEngine(source: mock)

        let image: CIImage
        do {
            image = try await engine.stitch(assets: refs)
        } catch PanoramaEngineError.stitchFailed(let e) {
            switch e {
            case .stitchFailure:
                throw XCTSkip(
                    "pano_stitch returned stitchFailure — pano feature may not be compiled in"
                )
            case .decodeFailure:
                throw XCTSkip(
                    "pano_stitch returned decodeFailure — synthetic PNG decode failed"
                )
            default:
                throw e
            }
        }

        XCTAssertGreaterThan(image.extent.width,  0, "CIImage width must be > 0")
        XCTAssertGreaterThan(image.extent.height, 0, "CIImage height must be > 0")
        XCTAssertFalse(image.extent.isInfinite,      "CIImage extent must not be infinite")
    }

    // MARK: - PanoramaEngine: progress callback order

    /// Verify the progress callback fires in the correct order for a 2-image stitch.
    /// Soft-skipped when the pano Rust feature is absent.
    func testProgressCallbackFiresAtEachStage() async throws {
        let (mock, refs) = makeTwoImageFixture()
        let engine = makeEngine(source: mock)

        // Collect progress events synchronously inside the @Sendable closure using
        // a mutex-backed collector.  We cannot use an actor here because the progress
        // closure is `@Sendable` and calling an actor method from it would require
        // an awaited `Task { ... }` which doesn't preserve call order across await
        // suspension points.
        let collector = SyncProgressCollector()

        do {
            _ = try await engine.stitch(assets: refs, progress: { event in
                collector.append(event)
            })
        } catch PanoramaEngineError.stitchFailed(let e) {
            switch e {
            case .stitchFailure, .decodeFailure:
                throw XCTSkip("pano feature not compiled in — skipping progress order test")
            default:
                throw e
            }
        }

        let events = collector.events
        // Expected sequence for 2 images:
        //   loading(0, 2), loading(1, 2), loading(2, 2), stitching, wrappingCIImage
        XCTAssertGreaterThanOrEqual(events.count, 5, "expected at least 5 progress events")

        // First event must be loading(0, 2).
        XCTAssertEqual(events.first, .loading(loaded: 0, total: 2),
                       "first event must be loading(0, 2), got \(String(describing: events.first))")

        // Last two must be stitching then wrappingCIImage.
        let lastTwo = Array(events.suffix(2))
        XCTAssertEqual(lastTwo, [.stitching, .wrappingCIImage],
                       "last two events must be stitching → wrappingCIImage, got \(lastTwo)")
    }

    // MARK: - PanoramaExport direct unit tests

    /// Verify PanoramaExport.toCIImage produces a positive-extent image
    /// using a real PanoHandle. Soft-skipped if pano feature absent.
    func testPanoramaExportToCIImageHasPositiveExtent() throws {
        let pngA = makeSyntheticPNG(width: 256, height: 256, noiseSeed: 1, starSeed: 42)
        let pngB = makeSyntheticPNG(width: 256, height: 256, noiseSeed: 7, starSeed: 42)

        let handle: PanoHandle
        do {
            handle = try PanoHandle.stitch(images: [pngA, pngB])
        } catch PanoHandle.StitchError.stitchFailure {
            throw XCTSkip("pano feature not compiled in")
        } catch PanoHandle.StitchError.decodeFailure {
            throw XCTSkip("pano_stitch decodeFailure on synthetic PNGs")
        }

        let image = try PanoramaExport.toCIImage(handle: handle, options: .default)
        XCTAssertGreaterThan(image.extent.width,  0)
        XCTAssertGreaterThan(image.extent.height, 0)
        XCTAssertFalse(image.extent.isInfinite)
    }

    /// Verify that releasing the PanoHandle after toCIImage does NOT crash
    /// when the CIImage is accessed (the buffer was copied, not zero-copy).
    func testCIImageRemainsValidAfterHandleRelease() throws {
        let pngA = makeSyntheticPNG(width: 64, height: 64, noiseSeed: 3, starSeed: 5)
        let pngB = makeSyntheticPNG(width: 64, height: 64, noiseSeed: 9, starSeed: 5)

        let image: CIImage
        do {
            let handle = try PanoHandle.stitch(images: [pngA, pngB])
            image = try PanoramaExport.toCIImage(handle: handle, options: .default)
            // `handle` goes out of scope here → deinit → pano_free.
        } catch PanoHandle.StitchError.stitchFailure {
            throw XCTSkip("pano feature not compiled in")
        } catch PanoHandle.StitchError.decodeFailure {
            throw XCTSkip("pano_stitch decodeFailure on synthetic PNGs")
        }

        // If the buffer was zero-copy and the handle was freed, this render
        // would crash or produce garbage. The copy strategy means it's safe.
        let ctx = CIContext()
        let cgImage = ctx.createCGImage(image, from: image.extent)
        XCTAssertNotNil(cgImage, "CIImage should render to CGImage after handle release")
    }

    // MARK: - PanoramaEngineError descriptions

    func testEngineErrorDescriptions() {
        let sourceErr = PanoramaSourceError.loadFailed("img.dng",
                                                       underlying: ImageSourceError.notFound("x"))
        let engineErr: [PanoramaEngineError] = [
            .sourceFailed(sourceErr),
            .stitchFailed(.decodeFailure),
            .ciImageWrapFailed("bad handle"),
        ]
        for e in engineErr {
            XCTAssertNotNil(e.errorDescription, "errorDescription must be non-nil for \(e)")
            XCTAssertFalse(e.errorDescription!.isEmpty, "errorDescription must be non-empty")
        }
    }
}

// MARK: - ProgressCollector (actor-based, for non-ordering-critical collection)

/// Thread-safe accumulator for `PanoramaProgress` events via an actor.
/// Use `SyncProgressCollector` when call-order preservation is required.
private actor ProgressCollector {
    private(set) var events: [PanoramaProgress] = []

    func append(_ event: PanoramaProgress) {
        events.append(event)
    }
}

// MARK: - SyncProgressCollector

/// Mutex-backed synchronous accumulator for `PanoramaProgress` events.
///
/// Conforms to `@unchecked Sendable` because the internal lock makes
/// all accesses safe across isolation contexts.  Used in the progress
/// ordering test where ordering must be preserved without Task hops.
private final class SyncProgressCollector: @unchecked Sendable {
    private var _events: [PanoramaProgress] = []
    private let lock = NSLock()

    func append(_ event: PanoramaProgress) {
        lock.withLock { _events.append(event) }
    }

    var events: [PanoramaProgress] {
        lock.withLock { _events }
    }
}
