// NonRawExportTests.swift — non-RAW export-path color correctness.
//
// Split out of NonRawSupportTests.swift to stay under the file-size budget
// (tools/check-file-budget.sh, 600 LOC hard limit).

import XCTest
import CoreImage
import ImageIO
import UniformTypeIdentifiers
import CoreGraphics
@testable import MapleCore

@MainActor
final class NonRawExportTests: XCTestCase {

    /// #1511 (chromatic cast): a NEUTRAL non-RAW image must EXPORT neutral.
    /// The exporter's bespoke `linearSRGB`-working CIContext routed the real
    /// develop output (a Rec.2020-derived, sRGB-tagged buffer) through a D50 PCS,
    /// baking a D50↔D65 adaptation into the file — neutrals came out blue. This
    /// runs the FULL non-RAW develop path (decode → processSceneLinearNonRaw) and
    /// then the export encode, then asserts R≈G≈B. A pure synthetic CIColor does
    /// NOT reproduce the cast (it only bites the real develop buffer), so this
    /// end-to-end form is required — bit-depth/tag tests can't catch a cast.
    func testNonRawNeutralExportsNeutral() async throws {
        let tmp = URL(fileURLWithPath: NSTemporaryDirectory())
            .appendingPathComponent("\(UUID().uuidString).png")
        defer { try? FileManager.default.removeItem(at: tmp) }

        // A solid neutral mid-gray, sRGB-tagged (R=G=B).
        let w = 64, h = 64
        let cs = CGColorSpace(name: CGColorSpace.sRGB)!
        let ctx = CGContext(
            data: nil, width: w, height: h, bitsPerComponent: 8, bytesPerRow: w * 4,
            space: cs, bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue)!
        ctx.setFillColor(red: 0.5, green: 0.5, blue: 0.5, alpha: 1.0)
        ctx.fill(CGRect(x: 0, y: 0, width: w, height: h))
        let cg = try XCTUnwrap(ctx.makeImage())
        let dest = try XCTUnwrap(CGImageDestinationCreateWithURL(
            tmp as CFURL, UTType.png.identifier as CFString, 1, nil))
        CGImageDestinationAddImage(dest, cg, nil)
        XCTAssertTrue(CGImageDestinationFinalize(dest))

        // Full non-RAW develop path (the buffer that triggers the cast).
        let pipeline = ImageEditPipeline()
        let decodedOpt = await pipeline.decodeSceneLinearNonRaw(
            asset: AssetRef(url: tmp), targetSize: nil)
        let decoded = try XCTUnwrap(decodedOpt, "decode returned nil")
        let developed = pipeline.processSceneLinearNonRaw(
            decoded: decoded, model: .default, targetSize: nil)

        // Export through the real encode path, decode, read the centre pixel.
        let data = try MapleExporter.encodeImage(developed, options: ExportOptions(format: .png))
        let src = try XCTUnwrap(CGImageSourceCreateWithData(data as CFData, nil))
        let image = try XCTUnwrap(CGImageSourceCreateImageAtIndex(src, 0, nil))
        var px = [UInt8](repeating: 0, count: 4)
        // `&px` would only keep the pointer valid for the CGContext initializer
        // call; the context stores it and `draw` writes to it later → dangling
        // pointer / UB. Keep the buffer pinned for the context's whole lifetime.
        try px.withUnsafeMutableBytes { raw in
            let readCtx = try XCTUnwrap(CGContext(
                data: raw.baseAddress, width: 1, height: 1, bitsPerComponent: 8,
                bytesPerRow: 4, space: cs,
                bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue))
            readCtx.draw(image, in: CGRect(x: 0, y: 0, width: 1, height: 1))
        }
        let (r, g, b) = (Int(px[0]), Int(px[1]), Int(px[2]))

        XCTAssertEqual(Double(r), Double(g), accuracy: 3,
            "neutral non-RAW must export neutral (R≈G); D50/D65 cast tints it blue (#1511). got (\(r),\(g),\(b))")
        XCTAssertEqual(Double(g), Double(b), accuracy: 3,
            "neutral non-RAW must export neutral (G≈B); D50/D65 cast tints it blue (#1511). got (\(r),\(g),\(b))")
    }
}
