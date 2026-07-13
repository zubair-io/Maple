// ThumbnailEncoderTests.swift — round-trips `ThumbnailEncoder` through real
// ImageIO encode + decode, not just a magic-byte check. This is the one
// unverified assumption the JPEG→AVIF thumbnail migration plan flagged:
// `public.avif` is ImageIO-writable on this deployment floor (confirmed via
// `sips --formats` during planning), but nothing previously asserted that
// the bytes ImageIO writes are also bytes ImageIO (or any AVIF decoder) can
// read back.

import CoreGraphics
import ImageIO
import XCTest

@testable import MapleCore

final class ThumbnailEncoderTests: XCTestCase {

    /// A solid-color CGImage of the given size, for encode round-trips.
    private func makeCGImage(width: Int, height: Int) throws -> CGImage {
        let space = CGColorSpace(name: CGColorSpace.sRGB)!
        let ctx = try XCTUnwrap(CGContext(
            data: nil, width: width, height: height,
            bitsPerComponent: 8, bytesPerRow: 0, space: space,
            bitmapInfo: CGImageAlphaInfo.noneSkipLast.rawValue
        ))
        ctx.setFillColor(CGColor(red: 0.2, green: 0.6, blue: 0.9, alpha: 1))
        ctx.fill(CGRect(x: 0, y: 0, width: width, height: height))
        return try XCTUnwrap(ctx.makeImage())
    }

    // MARK: - Magic bytes

    func testEncodeProducesAvifFtypBox() throws {
        let image = try makeCGImage(width: 64, height: 32)
        let data = try XCTUnwrap(ThumbnailEncoder.encode(image))
        XCTAssertGreaterThan(data.count, 12)
        XCTAssertEqual(Array(data[4..<8]), [0x66, 0x74, 0x79, 0x70], "expected ISOBMFF ftyp box")
        XCTAssertEqual(Array(data[8..<12]), [0x61, 0x76, 0x69, 0x66], "expected avif major brand")
    }

    // MARK: - Real decode round-trip

    func testEncodedBytesDecodeBackToSameDimensions() throws {
        let image = try makeCGImage(width: 256, height: 171)
        let data = try XCTUnwrap(ThumbnailEncoder.encode(image))

        let source = try XCTUnwrap(CGImageSourceCreateWithData(data as CFData, nil))
        XCTAssertEqual(CGImageSourceGetCount(source), 1)
        let decoded = try XCTUnwrap(CGImageSourceCreateImageAtIndex(source, 0, nil))

        XCTAssertEqual(decoded.width, 256)
        XCTAssertEqual(decoded.height, 171)
    }

    func testDecodedPixelIsApproximatelyTheEncodedColor() throws {
        // A larger solid field so lossy block artifacts at the edges don't
        // reach the sampled center pixel.
        let image = try makeCGImage(width: 64, height: 64)
        let data = try XCTUnwrap(ThumbnailEncoder.encode(image, quality: 0.9))

        let source = try XCTUnwrap(CGImageSourceCreateWithData(data as CFData, nil))
        let decoded = try XCTUnwrap(CGImageSourceCreateImageAtIndex(source, 0, nil))

        let space = CGColorSpace(name: CGColorSpace.sRGB)!
        var pixel = [UInt8](repeating: 0, count: 4)
        let ctx = try XCTUnwrap(CGContext(
            data: &pixel, width: 1, height: 1, bitsPerComponent: 8, bytesPerRow: 4,
            space: space, bitmapInfo: CGImageAlphaInfo.noneSkipLast.rawValue
        ))
        ctx.draw(decoded, in: CGRect(x: -31, y: -31, width: 64, height: 64))

        // Encoded fill was sRGB (0.2, 0.6, 0.9) ≈ (51, 153, 230) on the 0-255
        // scale. Allow slack for lossy AVIF quantization at quality 0.9.
        XCTAssertEqual(Double(pixel[0]), 51, accuracy: 20)
        XCTAssertEqual(Double(pixel[1]), 153, accuracy: 20)
        XCTAssertEqual(Double(pixel[2]), 230, accuracy: 20)
    }

    // MARK: - Quality knob

    func testLowerQualityProducesSmallerFiles() throws {
        let image = try makeCGImage(width: 256, height: 256)
        let high = try XCTUnwrap(ThumbnailEncoder.encode(image, quality: 0.9))
        let low = try XCTUnwrap(ThumbnailEncoder.encode(image, quality: 0.2))
        XCTAssertLessThan(low.count, high.count,
                          "lower ImageIO lossy-compression quality should encode smaller")
    }

    // MARK: - CIImage overload

    func testCIImageOverloadEncodesAndDecodes() throws {
        let cg = try makeCGImage(width: 48, height: 48)
        let ci = CIImage(cgImage: cg)
        let ctx = CIContext()
        let data = try XCTUnwrap(ThumbnailEncoder.encode(ci, ctx: ctx))

        let source = try XCTUnwrap(CGImageSourceCreateWithData(data as CFData, nil))
        let decoded = try XCTUnwrap(CGImageSourceCreateImageAtIndex(source, 0, nil))
        XCTAssertEqual(decoded.width, 48)
        XCTAssertEqual(decoded.height, 48)
    }
}
