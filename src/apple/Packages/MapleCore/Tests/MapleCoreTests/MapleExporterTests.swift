import XCTest
import CoreImage
import ImageIO
import CoreGraphics
@testable import MapleCore

/// Exercises the single encode path that `MapleExporter.exportData` now uses
/// for *every* image size. Before that path was unified (issue #922), exports
/// above ~50MP went through a separate `tiledExport` branch that called
/// `createCGImage(image, from:)` with no `format:`/`colorSpace:` and so
/// silently collapsed every format to 8-bit sRGB. These tests pin each
/// format's container type, pixel dimensions, and bit depth so that
/// regression can't return.
///
/// Core Image + ImageIO are Apple-only, so this suite runs on macOS / iOS (the
/// only platforms MapleCore builds for). No fixtures are involved — the source
/// image is synthesised in-process, so the tests are deterministic and fast.
final class MapleExporterTests: XCTestCase {

    /// A finite, solid-colour CIImage of the given pixel size.
    private func sampleImage(width: Int, height: Int) -> CIImage {
        CIImage(color: CIColor(red: 0.4, green: 0.6, blue: 0.8))
            .cropped(to: CGRect(x: 0, y: 0, width: width, height: height))
    }

    /// Decode encoded export bytes back into a container UTI + the first image.
    private func decode(_ data: Data) throws -> (type: String, image: CGImage) {
        let src = try XCTUnwrap(
            CGImageSourceCreateWithData(data as CFData, nil),
            "encoded bytes are not a readable image container")
        let type = try XCTUnwrap(
            CGImageSourceGetType(src).map { $0 as String },
            "decoded container has no UTI")
        let image = try XCTUnwrap(
            CGImageSourceCreateImageAtIndex(src, 0, nil),
            "decoded container has no image at index 0")
        return (type, image)
    }

    func testJpegSRGBEncodesEightBitNonWideGamut() throws {
        let data = try MapleExporter.encodeImage(
            sampleImage(width: 64, height: 48),
            options: ExportOptions(format: .jpegSRGB))
        let (type, image) = try decode(data)
        XCTAssertEqual(type, ExportFileFormat.jpegSRGB.uti as String)
        XCTAssertEqual(image.width, 64)
        XCTAssertEqual(image.height, 48)
        XCTAssertEqual(image.bitsPerComponent, 8)
        if let cs = image.colorSpace {
            XCTAssertFalse(
                CGColorSpaceIsWideGamutRGB(cs),
                "sRGB JPEG must not round-trip as wide-gamut")
        }
    }

    func testJpegP3PreservesWideGamut() throws {
        // The regression that motivated #922: > 50MP JPEG P3 used to come out
        // sRGB. The encode path must tag Display P3 regardless of size.
        let data = try MapleExporter.encodeImage(
            sampleImage(width: 80, height: 60),
            options: ExportOptions(format: .jpegP3))
        let (type, image) = try decode(data)
        XCTAssertEqual(type, ExportFileFormat.jpegP3.uti as String)
        XCTAssertEqual(image.width, 80)
        XCTAssertEqual(image.height, 60)
        XCTAssertEqual(image.bitsPerComponent, 8)
        if let cs = image.colorSpace {
            XCTAssertTrue(
                CGColorSpaceIsWideGamutRGB(cs),
                "P3 JPEG must round-trip as wide-gamut")
        }
    }

    func testPngEncodesEightBit() throws {
        let data = try MapleExporter.encodeImage(
            sampleImage(width: 32, height: 32),
            options: ExportOptions(format: .png))
        let (type, image) = try decode(data)
        XCTAssertEqual(type, ExportFileFormat.png.uti as String)
        XCTAssertEqual(image.width, 32)
        XCTAssertEqual(image.height, 32)
        XCTAssertEqual(image.bitsPerComponent, 8)
    }

    func testTiff16PreservesSixteenBit() throws {
        // The clearest #922 regression: > 50MP TIFF used to drop to 8-bit.
        let data = try MapleExporter.encodeImage(
            sampleImage(width: 48, height: 24),
            options: ExportOptions(format: .tiff16))
        let (type, image) = try decode(data)
        XCTAssertEqual(type, ExportFileFormat.tiff16.uti as String)
        XCTAssertEqual(image.width, 48)
        XCTAssertEqual(image.height, 24)
        XCTAssertEqual(
            image.bitsPerComponent, 16,
            "16-bit TIFF must encode 16 bits per component, not 8")
    }

    /// HEIC depends on a platform encoder that isn't present on every host;
    /// treat its absence as a skip rather than a failure, mirroring the repo's
    /// fixture-absent skip-pass convention.
    func testHeicP3PreservesWideGamutWhenAvailable() throws {
        let data: Data
        do {
            data = try MapleExporter.encodeImage(
                sampleImage(width: 64, height: 64),
                options: ExportOptions(format: .heicP3))
        } catch {
            throw XCTSkip("HEIC encoder unavailable on this host: \(error)")
        }
        let (type, image) = try decode(data)
        XCTAssertEqual(type, ExportFileFormat.heicP3.uti as String)
        XCTAssertEqual(image.width, 64)
        XCTAssertEqual(image.height, 64)
        if let cs = image.colorSpace {
            XCTAssertTrue(
                CGColorSpaceIsWideGamutRGB(cs),
                "P3 HEIC must round-trip as wide-gamut")
        }
    }

    /// `maxSidePixels` resizes the long edge before encoding — exercises the
    /// `scaledImage` path via the public-ish encode seam.
    func testMaxSidePixelsHonouredByEncodePath() throws {
        // 200x100 long edge clamped to 100 -> 100x50.
        let scaled = MapleExporter.scaledImage(
            sampleImage(width: 200, height: 100), maxSide: 100)
        let data = try MapleExporter.encodeImage(
            scaled, options: ExportOptions(format: .jpegSRGB))
        let (_, image) = try decode(data)
        XCTAssertEqual(image.width, 100)
        XCTAssertEqual(image.height, 50)
    }
}
