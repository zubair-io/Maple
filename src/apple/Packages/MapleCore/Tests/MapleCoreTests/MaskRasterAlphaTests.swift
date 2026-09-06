// MaskRasterAlphaTests.swift — #3354.
//
// The bug this covers was purely a channel mix-up: coverage stored in
// luminance, tinted by alpha. So the assertion that matters is that alpha
// tracks the source's luminance — including partial coverage, which is what
// keeps a feathered mask edge feathered instead of hard-clipping it.

import CoreGraphics
import XCTest

@testable import MapleCore

final class MaskRasterAlphaTests: XCTestCase {
    /// An 8-bit grayscale image from explicit per-pixel values — the shape
    /// `PersonSkinMaskService` writes (PNG colour type 0, no alpha).
    private func grayImage(_ values: [UInt8], width: Int, height: Int) throws -> CGImage {
        var bytes = values
        let ctx = try XCTUnwrap(
            bytes.withUnsafeMutableBytes { raw in
                CGContext(
                    data: raw.baseAddress, width: width, height: height,
                    bitsPerComponent: 8, bytesPerRow: width,
                    space: CGColorSpaceCreateDeviceGray(),
                    bitmapInfo: CGImageAlphaInfo.none.rawValue)
            })
        return try XCTUnwrap(ctx.makeImage())
    }

    private func rgba(_ image: CGImage) throws -> [UInt8] {
        let w = image.width, h = image.height
        var out = [UInt8](repeating: 0, count: w * h * 4)
        let ctx = try XCTUnwrap(
            out.withUnsafeMutableBytes { raw in
                CGContext(
                    data: raw.baseAddress, width: w, height: h, bitsPerComponent: 8,
                    bytesPerRow: w * 4, space: CGColorSpaceCreateDeviceRGB(),
                    bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue)
            })
        ctx.draw(image, in: CGRect(x: 0, y: 0, width: w, height: h))
        return out
    }

    /// Black luminance -> transparent, white -> opaque. Without this the
    /// overlay tints every pixel (the source has no alpha channel at all,
    /// so a template render treats the whole frame as covered).
    func testLuminanceBecomesAlpha() throws {
        // Row 0: black, black. Row 1: white, white.
        let source = try grayImage([0, 0, 255, 255], width: 2, height: 2)
        let converted = try XCTUnwrap(MaskRasterAlpha.alphaFromLuminance(source))
        let px = try rgba(converted)

        XCTAssertEqual(px[3], 0, "black coverage must be fully transparent")
        XCTAssertEqual(px[7], 0, "black coverage must be fully transparent")
        XCTAssertEqual(px[11], 255, "white coverage must be fully opaque")
        XCTAssertEqual(px[15], 255, "white coverage must be fully opaque")
    }

    /// Mid-grey stays mid-alpha — a feathered mask edge has to survive as a
    /// soft edge, not snap to on/off.
    func testPartialCoverageStaysPartial() throws {
        let source = try grayImage([128], width: 1, height: 1)
        let converted = try XCTUnwrap(MaskRasterAlpha.alphaFromLuminance(source))
        let px = try rgba(converted)
        XCTAssertEqual(Int(px[3]), 128, accuracy: 2, "feathered coverage must stay feathered")
    }

    func testDimensionsArePreserved() throws {
        let source = try grayImage([UInt8](repeating: 200, count: 12), width: 4, height: 3)
        let converted = try XCTUnwrap(MaskRasterAlpha.alphaFromLuminance(source))
        XCTAssertEqual(converted.width, 4)
        XCTAssertEqual(converted.height, 3)
    }
}
