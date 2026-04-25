// DeepZoomTileRenderingTests.swift — Plan 3 (Ticket 06 M4) integration
// tests for the tile FFI, MapleRawHandle wrapper, and
// `ImageEditPipeline.decodePreviewTile`.
//
// Cross-link:
//   docs/superpowers/plans/2026-04-25-deep-zoom-tile-rendering.md Task 4.
//
// Tests are split into two tiers:
//   - "no fixture" tier: exercises the wrapper APIs through their
//     null-pointer / empty-bytes error paths. These run in any
//     environment, including CI without the gitignored DNG fixtures.
//   - "fixture" tier: gated on `test-fixtures/raws/test_0002.dng`. When
//     absent, `XCTSkip` is thrown so the suite still passes overall.

import XCTest
import CoreImage
import CoreGraphics
@testable import MapleCore

final class DeepZoomTileRenderingTests: XCTestCase {

    // MARK: - Fixture lookup helper

    /// Resolve the gitignored test_0002.dng fixture by walking up from
    /// the test source file to the repository root, then into
    /// `test-fixtures/raws/`. Returns nil if absent.
    private func fixtureURL() -> URL? {
        let url = URL(fileURLWithPath: #filePath)
            .deletingLastPathComponent()  // MapleCoreTests/
            .deletingLastPathComponent()  // Tests/
            .deletingLastPathComponent()  // MapleCore/
            .deletingLastPathComponent()  // Packages/
            .deletingLastPathComponent()  // apple/
            .deletingLastPathComponent()  // src/
            .deletingLastPathComponent()  // repo root
            .appendingPathComponent("test-fixtures/raws/test_0002.dng")
        return FileManager.default.fileExists(atPath: url.path) ? url : nil
    }

    // MARK: - openRawHandle / renderTile error paths (no fixture needed)

    /// `openRawHandle` on a non-existent file throws renderFailed.
    func testOpenRawHandleNonExistentFileThrows() {
        let bogus = URL(fileURLWithPath: "/tmp/does_not_exist_maple_tile_test.dng")
        XCTAssertThrowsError(try PipelineRenderer.openRawHandle(rawPath: bogus)) { err in
            guard let pe = err as? PipelineError,
                  case .renderFailed(let code, _) = pe else {
                XCTFail("Expected PipelineError.renderFailed, got \(err)")
                return
            }
            // rc 6 = RAW read failed (file not found path).
            XCTAssertNotEqual(code, 0)
        }
    }

    /// One-shot `renderTile(rawPath:...)` on a non-existent file throws
    /// renderFailed.
    func testRenderTileFromFileNonExistentThrows() {
        let bogus = URL(fileURLWithPath: "/tmp/does_not_exist_maple_tile_test.dng")
        XCTAssertThrowsError(try PipelineRenderer.renderTile(
            rawPath: bogus,
            srcX: 0, srcY: 0, srcW: 256, srcH: 256,
            outW: 128, outH: 128
        )) { err in
            guard let pe = err as? PipelineError,
                  case .renderFailed(let code, _) = pe else {
                XCTFail("Expected PipelineError.renderFailed, got \(err)")
                return
            }
            XCTAssertNotEqual(code, 0)
        }
    }

    /// One-shot `renderTile(rawBytes:...)` with empty bytes throws
    /// renderFailed (rawler can't decode an empty byte slice).
    func testRenderTileFromEmptyBytesThrows() {
        XCTAssertThrowsError(try PipelineRenderer.renderTile(
            rawBytes: Data(),
            hint: "dng",
            srcX: 0, srcY: 0, srcW: 256, srcH: 256,
            outW: 128, outH: 128
        )) { err in
            guard let pe = err as? PipelineError,
                  case .renderFailed(let code, _) = pe else {
                XCTFail("Expected PipelineError.renderFailed, got \(err)")
                return
            }
            XCTAssertNotEqual(code, 0)
        }
    }

    // MARK: - Fixture-gated round-trip lifecycle

    /// Open a handle, render a single tile, and let the deinit close it.
    /// Verifies the wrapper's full lifecycle plus the FFI buffer shape.
    /// Skipped if the test fixture isn't present.
    func testRawHandleRoundTripRendersTile() throws {
        guard let url = fixtureURL() else {
            throw XCTSkip("test_0002.dng fixture not present; skipping")
        }
        let handle = try PipelineRenderer.openRawHandle(rawPath: url, xmpPath: nil)
        let tile = try PipelineRenderer.renderTile(
            handle: handle,
            srcX: 1024, srcY: 1024,
            srcW: 512, srcH: 512,
            outW: 256, outH: 256,
            quality: .full
        )
        XCTAssertEqual(tile.width, 256)
        XCTAssertEqual(tile.height, 256)
        XCTAssertEqual(tile.bytesPerPixel, 8)
        XCTAssertEqual(tile.channels, 4)
        XCTAssertEqual(tile.pixels.count, 256 * 256 * 8)
        // `handle` deinits at scope exit → maple_close_raw_handle.
    }

    /// Open once, render N tiles against the same handle. Validates
    /// that the cached decoded mosaic is reusable across multiple tile
    /// fetches without crashing or drifting in shape.
    func testRawHandleRendersMultipleTiles() throws {
        guard let url = fixtureURL() else {
            throw XCTSkip("test_0002.dng fixture not present; skipping")
        }
        let handle = try PipelineRenderer.openRawHandle(rawPath: url)
        let coords: [(UInt32, UInt32)] = [(0, 0), (1024, 0), (0, 1024)]
        for (sx, sy) in coords {
            let tile = try PipelineRenderer.renderTile(
                handle: handle,
                srcX: sx, srcY: sy,
                srcW: 512, srcH: 512,
                outW: 256, outH: 256
            )
            XCTAssertEqual(tile.width, 256, "tile (\(sx),\(sy)) width")
            XCTAssertEqual(tile.height, 256, "tile (\(sx),\(sy)) height")
            XCTAssertEqual(tile.pixels.count, 256 * 256 * 8)
        }
    }

    /// One-shot `renderTile(rawPath:...)` succeeds without an explicit
    /// handle. Same shape checks as the handle-based path.
    func testRenderTileFromFileRoundTrip() throws {
        guard let url = fixtureURL() else {
            throw XCTSkip("test_0002.dng fixture not present; skipping")
        }
        let tile = try PipelineRenderer.renderTile(
            rawPath: url,
            srcX: 1024, srcY: 1024,
            srcW: 512, srcH: 512,
            outW: 256, outH: 256
        )
        XCTAssertEqual(tile.width, 256)
        XCTAssertEqual(tile.height, 256)
    }

    /// `renderTile` rejects upscale (out > src) — surfaces the FFI rc=11.
    func testRenderTileRejectsUpscale() throws {
        guard let url = fixtureURL() else {
            throw XCTSkip("test_0002.dng fixture not present; skipping")
        }
        let handle = try PipelineRenderer.openRawHandle(rawPath: url)
        XCTAssertThrowsError(try PipelineRenderer.renderTile(
            handle: handle,
            srcX: 1024, srcY: 1024,
            srcW: 256, srcH: 256,
            outW: 512, outH: 512  // > src → rc=11
        )) { err in
            guard let pe = err as? PipelineError,
                  case .renderFailed(let code, _) = pe else {
                XCTFail("Expected PipelineError.renderFailed, got \(err)")
                return
            }
            XCTAssertEqual(code, 11, "expected upscale rc=11, got \(code)")
        }
    }

    /// `decodePreviewTile` returns a CIImage tagged
    /// extendedLinearITUR_2020 at the requested output dimensions.
    func testDecodePreviewTileReturnsTaggedRec2020CIImage() async throws {
        guard let url = fixtureURL() else {
            throw XCTSkip("test_0002.dng fixture not present; skipping")
        }
        let asset = AssetRef(url: url)
        let pipeline = ImageEditPipeline()
        let tile = await pipeline.decodePreviewTile(
            asset: asset,
            srcRect: CGRect(x: 1024, y: 1024, width: 512, height: 512),
            outSize: CGSize(width: 256, height: 256),
            quality: .full
        )
        let img = try XCTUnwrap(tile)
        XCTAssertEqual(Int(img.extent.size.width), 256)
        XCTAssertEqual(Int(img.extent.size.height), 256)
        // CIImage.colorSpace returns Optional<CGColorSpace>; check name.
        XCTAssertEqual(
            img.colorSpace?.name as String?,
            CGColorSpace.extendedLinearITUR_2020 as String,
            "decodePreviewTile must tag extendedLinearITUR_2020"
        )
    }
}
