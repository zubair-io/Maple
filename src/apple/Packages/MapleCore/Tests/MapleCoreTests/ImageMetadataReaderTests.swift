import XCTest
import CoreGraphics
import ImageIO
import UniformTypeIdentifiers
@testable import MapleCore

final class ImageMetadataReaderTests: XCTestCase {
    func testOrientedPixelSizeKeepsLandscapeOrientation() {
        let size = ImageMetadataReader.orientedPixelSize(
            width: 6000,
            height: 4000,
            orientationValue: 1
        )

        XCTAssertEqual(size.width, 6000, accuracy: 0.01)
        XCTAssertEqual(size.height, 4000, accuracy: 0.01)
    }

    func testOrientedPixelSizeSwapsPortraitOrientation() {
        let size = ImageMetadataReader.orientedPixelSize(
            width: 6000,
            height: 4000,
            orientationValue: 6
        )

        XCTAssertEqual(size.width, 4000, accuracy: 0.01)
        XCTAssertEqual(size.height, 6000, accuracy: 0.01)
    }

    // MARK: - Sourceless readPixelSize

    /// The Data variant must surface the same dims as a synthetic PNG would
    /// expose through ImageIO. We round-trip a 256×128 image through
    /// `CGImageDestination` so the test has zero filesystem dependency.
    func testReadPixelSizeFromDataReturnsImageDimensions() throws {
        let data = try makeSyntheticPNG(width: 256, height: 128)
        let size = try XCTUnwrap(ImageMetadataReader.readPixelSize(from: data))
        XCTAssertEqual(size.width, 256, accuracy: 0.01)
        XCTAssertEqual(size.height, 128, accuracy: 0.01)
    }

    /// Fixture-gated regression for the multi-IFD DNG case: index 0 is the
    /// embedded JPEG preview, the largest subimage holds the sensor data.
    /// The Data variant must walk every subimage exactly like the URL
    /// variant — without this the PhotoKit / Self-Hosted path returns
    /// preview dims and `nativeImageSize` is set to the wrong scale.
    func testReadPixelSizeFromDataMatchesURLVariantOnDNG() throws {
        let fixture = repoRoot()
            .appendingPathComponent("test-fixtures/raws/test_0002.dng")
        guard FileManager.default.fileExists(atPath: fixture.path) else {
            throw XCTSkip("test fixture not present: \(fixture.path)")
        }
        let urlSize = try XCTUnwrap(ImageMetadataReader.readPixelSize(from: fixture))
        let data = try Data(contentsOf: fixture)
        let dataSize = try XCTUnwrap(
            ImageMetadataReader.readPixelSize(from: data, identifierHint: "dng")
        )
        XCTAssertEqual(dataSize.width, urlSize.width, accuracy: 0.01,
                       "Data variant must report the same width as URL variant")
        XCTAssertEqual(dataSize.height, urlSize.height, accuracy: 0.01,
                       "Data variant must report the same height as URL variant")
    }

    func testReadPixelSizeFromDataReturnsNilOnGarbage() {
        let garbage = Data([0x00, 0x01, 0x02, 0x03])
        XCTAssertNil(ImageMetadataReader.readPixelSize(from: garbage))
    }

    // MARK: - Helpers

    /// Repo root resolved from this file's path. Mirrors the pattern in
    /// `MapleCoreTests.testPipelineRendererRealFile` so fixture lookups
    /// work whether `swift test` is invoked from the package directory or
    /// from the repo root.
    private func repoRoot() -> URL {
        URL(fileURLWithPath: #filePath)
            .deletingLastPathComponent()  // Tests/MapleCoreTests
            .deletingLastPathComponent()  // Tests
            .deletingLastPathComponent()  // MapleCore
            .deletingLastPathComponent()  // Packages
            .deletingLastPathComponent()  // apple
            .deletingLastPathComponent()  // src
            .deletingLastPathComponent()  // <repo root>
    }

    /// Build a tiny synthetic PNG so the test never depends on RAW
    /// fixtures. Filled with a fixed gradient so the encoder writes the
    /// IDAT (a fully-zero buffer can be optimised to a 0-byte payload).
    private func makeSyntheticPNG(width: Int, height: Int) throws -> Data {
        let colorSpace = CGColorSpaceCreateDeviceRGB()
        let bitsPerComponent = 8
        let bytesPerRow = width * 4
        let bitmapInfo = CGImageAlphaInfo.premultipliedLast.rawValue
        guard let ctx = CGContext(
            data: nil,
            width: width,
            height: height,
            bitsPerComponent: bitsPerComponent,
            bytesPerRow: bytesPerRow,
            space: colorSpace,
            bitmapInfo: bitmapInfo
        ) else {
            XCTFail("failed to construct CGContext")
            throw NSError(domain: "ImageMetadataReaderTests", code: 1)
        }
        // Paint a horizontal gradient so encoders don't optimise the
        // bitmap away.
        for x in 0..<width {
            let v = CGFloat(x) / CGFloat(width)
            ctx.setFillColor(red: v, green: v, blue: v, alpha: 1)
            ctx.fill(CGRect(x: x, y: 0, width: 1, height: height))
        }
        guard let cg = ctx.makeImage() else {
            XCTFail("failed to materialise CGImage")
            throw NSError(domain: "ImageMetadataReaderTests", code: 2)
        }
        let mutable = NSMutableData()
        guard let dest = CGImageDestinationCreateWithData(
            mutable as CFMutableData,
            UTType.png.identifier as CFString,
            1,
            nil
        ) else {
            XCTFail("failed to create CGImageDestination")
            throw NSError(domain: "ImageMetadataReaderTests", code: 3)
        }
        CGImageDestinationAddImage(dest, cg, nil)
        guard CGImageDestinationFinalize(dest) else {
            XCTFail("failed to finalize PNG")
            throw NSError(domain: "ImageMetadataReaderTests", code: 4)
        }
        return mutable as Data
    }
}
