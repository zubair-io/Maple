// ThumbnailLoaderNonRawSlowPathTests.swift — #1366: the thumbnail slow-path
// fallback for non-RAW bitmaps (imported JPEG/PNG/HEIF, stitched pano PNGs)
// that have no embedded preview.
//
// Real files in a temp directory throughout, no mocks. Two things are
// under test:
//   1. `PipelineRenderer.render(rawPath:)` — the RAW developer — throws for
//      a genuine non-RAW file. This documents the root cause: routing
//      every slow-path miss through the RAW developer was never going to
//      work for non-RAW assets.
//   2. `ThumbnailLoader.nonRawSlowPathAVIF(at:)` — the new dedicated path —
//      decodes the same kind of file correctly (downscale, orientation,
//      graceful nil on genuinely undecodable bytes), and the full
//      `ThumbnailLoader.shared.load(for:)` entry point returns real bytes
//      end to end instead of the blank-grey-tile nil the ticket describes.

import CoreGraphics
import CoreImage
import Foundation
import ImageIO
import UniformTypeIdentifiers
import XCTest

@testable import MapleCore

final class ThumbnailLoaderNonRawSlowPathTests: XCTestCase {

    private var tmpDir: URL!

    override func setUpWithError() throws {
        tmpDir = FileManager.default.temporaryDirectory
            .appendingPathComponent("non-raw-slow-path-tests-\(UUID().uuidString)")
        try FileManager.default.createDirectory(at: tmpDir, withIntermediateDirectories: true)
    }

    override func tearDownWithError() throws {
        try? FileManager.default.removeItem(at: tmpDir)
    }

    // MARK: - Helpers

    /// Write a solid-color image with no embedded ImageIO thumbnail (plain
    /// `CGImageDestinationAddImage` never writes one) — the exact "slow
    /// path" trigger condition from the ticket.
    private func writeImage(
        named name: String, width: Int, height: Int,
        uti: UTType, orientation: UInt32? = nil
    ) throws -> URL {
        let url = tmpDir.appendingPathComponent(name)
        let space = CGColorSpace(name: CGColorSpace.sRGB)!
        let ctx = try XCTUnwrap(CGContext(
            data: nil, width: width, height: height,
            bitsPerComponent: 8, bytesPerRow: 0, space: space,
            bitmapInfo: CGImageAlphaInfo.noneSkipLast.rawValue
        ))
        ctx.setFillColor(CGColor(red: 0.2, green: 0.7, blue: 0.4, alpha: 1))
        ctx.fill(CGRect(x: 0, y: 0, width: width, height: height))
        let image = try XCTUnwrap(ctx.makeImage())
        let dest = try XCTUnwrap(CGImageDestinationCreateWithURL(
            url as CFURL, uti.identifier as CFString, 1, nil
        ))
        let props: [CFString: Any]? = orientation.map { [kCGImagePropertyOrientation: $0] }
        CGImageDestinationAddImage(dest, image, props as CFDictionary?)
        XCTAssertTrue(CGImageDestinationFinalize(dest))
        return url
    }

    private func extent(of avifData: Data) throws -> CGSize {
        let src = try XCTUnwrap(CGImageSourceCreateWithData(avifData as CFData, nil))
        let image = try XCTUnwrap(CGImageSourceCreateImageAtIndex(src, 0, nil))
        return CGSize(width: image.width, height: image.height)
    }

    // MARK: - Root cause: the RAW developer cannot handle non-RAW input

    func testPipelineRendererThrowsForNonRawFile() throws {
        // This is the bug the ticket describes: before the fix, ANY
        // slow-path miss — RAW or not — fell through to
        // `PipelineRenderer.render(rawPath:)`. For a real non-RAW bitmap
        // that call throws, which the old code turned into a bare `nil`
        // (blank grey grid tile).
        let url = try writeImage(named: "root-cause.jpg", width: 400, height: 300, uti: .jpeg)
        XCTAssertThrowsError(try PipelineRenderer.render(rawPath: url, quality: .preview)) { error in
            guard let pipelineError = error as? PipelineError,
                case .renderFailed = pipelineError
            else {
                XCTFail("expected PipelineError.renderFailed, got \(error)")
                return
            }
        }
    }

    // MARK: - nonRawSlowPathAVIF

    func testDecodesJPEGWithNoEmbeddedThumbnail() throws {
        let url = try writeImage(named: "a.jpg", width: 2_400, height: 1_600, uti: .jpeg)
        let data = try XCTUnwrap(
            ThumbnailLoader.nonRawSlowPathAVIF(at: url),
            "non-RAW slow path must produce a thumbnail, not nil")
        // AVIF container (`ftyp` box at offset 4), matching every other
        // thumbnail tier in this codebase.
        XCTAssertEqual(data[4..<8], Data("ftyp".utf8))
    }

    func testDecodesPNGWithNoEmbeddedThumbnail() throws {
        let url = try writeImage(named: "b.png", width: 1_800, height: 1_200, uti: .png)
        let data = try XCTUnwrap(ThumbnailLoader.nonRawSlowPathAVIF(at: url))
        XCTAssertEqual(data[4..<8], Data("ftyp".utf8))
    }

    func testDownscalesToThumbnailLongEdge() throws {
        let url = try writeImage(named: "large.png", width: 4_800, height: 3_200, uti: .png)
        let data = try XCTUnwrap(ThumbnailLoader.nonRawSlowPathAVIF(at: url))
        let size = try extent(of: data)
        XCTAssertEqual(max(size.width, size.height), ThumbnailDiskCache.defaultThumbSize.width)
    }

    func testNeverUpscalesSmallSource() throws {
        let url = try writeImage(named: "small.png", width: 120, height: 80, uti: .png)
        let data = try XCTUnwrap(ThumbnailLoader.nonRawSlowPathAVIF(at: url))
        let size = try extent(of: data)
        XCTAssertEqual(size.width, 120, accuracy: 1)
        XCTAssertEqual(size.height, 80, accuracy: 1)
    }

    /// Orientation 6 = "rotate 90° CW for display" — stored (sensor) pixels
    /// are landscape but the displayed image must come back portrait.
    /// Mirrors `NonRawSupportTests.testDecodeSceneLinearNonRawAppliesExifOrientation`.
    func testAppliesExifOrientation() throws {
        let url = try writeImage(
            named: "rotated.jpg", width: 320, height: 240, uti: .jpeg, orientation: 6)
        let data = try XCTUnwrap(ThumbnailLoader.nonRawSlowPathAVIF(at: url))
        let size = try extent(of: data)
        XCTAssertLessThan(size.width, size.height, "rotated thumbnail should be portrait")
    }

    func testReturnsNilForUndecodableBytes() throws {
        let url = tmpDir.appendingPathComponent("not-an-image.png")
        try Data("this is not image data".utf8).write(to: url)
        XCTAssertNil(ThumbnailLoader.nonRawSlowPathAVIF(at: url))
    }

    // MARK: - End to end: ThumbnailLoader.shared.load(for:)

    func testLoadProducesThumbnailForNonRawAssetWithoutEmbeddedPreview() async throws {
        let url = try writeImage(named: "grid-cell.jpg", width: 2_000, height: 1_333, uti: .jpeg)
        let result = await ThumbnailLoader.shared.load(for: url)
        let data = try XCTUnwrap(result, "non-RAW asset must produce a thumbnail, not nil")
        XCTAssertFalse(data.isEmpty)
        let size = try extent(of: data)
        XCTAssertEqual(max(size.width, size.height), ThumbnailDiskCache.defaultThumbSize.width)
    }
}
