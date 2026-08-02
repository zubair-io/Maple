// ThumbnailDecoderTests.swift
//
// Covers `ThumbnailDecoder` — the off-main, downsampling, decode-once helper
// that replaced the per-body synchronous `CGImageSource` decode inside
// `ThumbnailImage.body`. That old decode was the browse-grid jank source:
// it ran on the main actor, re-ran on every SwiftUI body evaluation, and used
// `CGImageSourceCreateImageAtIndex` (which returns a *lazily*-decoded image
// that decodes again at draw time, once more on the main thread).
//
// The decoder's contract, asserted here:
//   1. it downsamples to `maxPixelSize` on the long edge (eager bitmap),
//   2. it never upscales a smaller source,
//   3. it returns a cached instance for identical bytes (decode-once),
//   4. it returns nil for non-image bytes.
//
// Self-contained: the fixtures are synthesized in-memory (a solid-fill PNG
// encoded via CGImageDestination), so no committed RAW/AVIF fixture is needed
// and the test runs everywhere `swift test` does.

import XCTest
import ImageIO
import CoreGraphics
import UniformTypeIdentifiers
@testable import MapleCore

final class ThumbnailDecoderTests: XCTestCase {

    /// Synthesize a solid-colour PNG of the given pixel size, entirely in
    /// memory. Used as decodable input bytes.
    private func makePNG(width: Int, height: Int) throws -> Data {
        let colorSpace = CGColorSpaceCreateDeviceRGB()
        let context = try XCTUnwrap(
            CGContext(
                data: nil,
                width: width,
                height: height,
                bitsPerComponent: 8,
                bytesPerRow: 0,
                space: colorSpace,
                bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue
            ),
            "failed to create bitmap context"
        )
        context.setFillColor(CGColor(red: 0.2, green: 0.5, blue: 0.8, alpha: 1))
        context.fill(CGRect(x: 0, y: 0, width: width, height: height))
        let image = try XCTUnwrap(context.makeImage(), "failed to snapshot bitmap")

        let output = NSMutableData()
        let dest = try XCTUnwrap(
            CGImageDestinationCreateWithData(output, UTType.png.identifier as CFString, 1, nil),
            "failed to create PNG destination"
        )
        CGImageDestinationAddImage(dest, image, nil)
        XCTAssertTrue(CGImageDestinationFinalize(dest), "PNG encode failed")
        return output as Data
    }

    // MARK: - Downsampling

    func test_decodeSync_downsamplesLongEdgeToMaxPixelSize() throws {
        let bytes = try makePNG(width: 1000, height: 750)
        let decoded = try XCTUnwrap(
            ThumbnailDecoder.decodeSync(bytes),
            "valid PNG bytes must decode"
        )
        XCTAssertEqual(
            max(decoded.width, decoded.height),
            ThumbnailDecoder.maxPixelSize,
            "long edge must be clamped to maxPixelSize"
        )
        // Aspect ratio is preserved (1000:750 = 4:3 → 512:384).
        XCTAssertEqual(decoded.width, 512)
        XCTAssertEqual(decoded.height, 384)
    }

    func test_decodeSync_doesNotUpscaleSmallSource() throws {
        let bytes = try makePNG(width: 300, height: 200)
        let decoded = try XCTUnwrap(ThumbnailDecoder.decodeSync(bytes))
        XCTAssertEqual(decoded.width, 300, "a source smaller than maxPixelSize must not be upscaled")
        XCTAssertEqual(decoded.height, 200)
    }

    // MARK: - Decode-once cache

    func test_image_returnsCachedInstanceForIdenticalBytes() async throws {
        let bytes = try makePNG(width: 640, height: 640)
        let firstDecode = await ThumbnailDecoder.image(for: bytes)
        let secondDecode = await ThumbnailDecoder.image(for: bytes)
        let first = try XCTUnwrap(firstDecode)
        let second = try XCTUnwrap(secondDecode)
        XCTAssertTrue(
            first === second,
            "identical bytes must resolve to the same cached CGImage (decode-once)"
        )
    }

    // MARK: - Failure path

    func test_decodeSync_returnsNilForNonImageBytes() {
        XCTAssertNil(
            ThumbnailDecoder.decodeSync(Data([0x00, 0x01, 0x02, 0x03, 0xFF])),
            "garbage bytes must not decode to an image"
        )
    }

    func test_image_returnsNilForNonImageBytes() async {
        let result = await ThumbnailDecoder.image(for: Data([0xDE, 0xAD, 0xBE, 0xEF]))
        XCTAssertNil(result, "garbage bytes must not decode to an image")
    }

    // MARK: - Cancellation

    /// A decode whose caller was cancelled (the grid cell scrolled off-screen
    /// before the decode started) must bail rather than decode a tile that's no
    /// longer visible. Guards the structured-concurrency contract: `image(for:)`
    /// must inherit the caller's cancellation, which it can only do because it
    /// decodes inline (nonisolated async) rather than in an unstructured
    /// `Task.detached`.
    func test_image_bailsWhenCallerCancelled() async throws {
        // A size not decoded elsewhere in this suite, so the cache can't satisfy
        // the request before the cancellation guard is reached.
        let bytes = try makePNG(width: 123, height: 77)
        // Cancel synchronously before the first suspension point, so the task
        // body observes cancellation deterministically once it runs.
        let task = Task { await ThumbnailDecoder.image(for: bytes) }
        task.cancel()
        let result = await task.value
        XCTAssertNil(result, "a decode whose caller was cancelled must return nil")
    }
}
