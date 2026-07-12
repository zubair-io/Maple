// ThumbnailLoaderDisplayPreviewTests.swift — the `.maple/previews` 1600 px
// display tier behind the Preview screen's thumbnail → hi-res swap
// (ThumbnailLoader+DisplayPreview.swift).
//
// Real files in a temp directory throughout — including real `.xmp`
// sidecars via `XMPSerializer` — per the "no mocks for the sidecar layer"
// convention.

import CoreGraphics
import Foundation
import ImageIO
import UniformTypeIdentifiers
import XCTest

@testable import MapleCore

final class ThumbnailLoaderDisplayPreviewTests: XCTestCase {

    private var tmpDir: URL!

    override func setUpWithError() throws {
        tmpDir = FileManager.default.temporaryDirectory
            .appendingPathComponent("display-preview-tests-\(UUID().uuidString)")
        try FileManager.default.createDirectory(at: tmpDir, withIntermediateDirectories: true)
    }

    override func tearDownWithError() throws {
        try? FileManager.default.removeItem(at: tmpDir)
    }

    // MARK: - Helpers

    /// Write a solid-color JPEG of the given size and return its URL.
    private func writeJPEG(
        named name: String, width: Int, height: Int
    ) throws -> URL {
        let url = tmpDir.appendingPathComponent(name)
        let space = CGColorSpace(name: CGColorSpace.sRGB)!
        let ctx = try XCTUnwrap(CGContext(
            data: nil, width: width, height: height,
            bitsPerComponent: 8, bytesPerRow: 0, space: space,
            bitmapInfo: CGImageAlphaInfo.noneSkipLast.rawValue
        ))
        ctx.setFillColor(CGColor(red: 0.4, green: 0.5, blue: 0.6, alpha: 1))
        ctx.fill(CGRect(x: 0, y: 0, width: width, height: height))
        let image = try XCTUnwrap(ctx.makeImage())
        let dest = try XCTUnwrap(CGImageDestinationCreateWithURL(
            url as CFURL, UTType.jpeg.identifier as CFString, 1, nil
        ))
        CGImageDestinationAddImage(dest, image, nil)
        XCTAssertTrue(CGImageDestinationFinalize(dest))
        return url
    }

    private func writeSidecar(
        for assetURL: URL, model: AdjustmentModel, culling: CullingState = CullingState()
    ) throws {
        let xml = XMPSerializer.serialize(model: model, culling: culling)
        try Data(xml.utf8).write(to: SidecarPath.sidecarURL(for: assetURL))
    }

    private func longEdge(of data: Data) throws -> Int {
        let src = try XCTUnwrap(CGImageSourceCreateWithData(data as CFData, nil))
        let image = try XCTUnwrap(CGImageSourceCreateImageAtIndex(src, 0, nil))
        return max(image.width, image.height)
    }

    // MARK: - Generation

    func testGeneratesPersistsAndServesDisplayPreviewForJPEG() async throws {
        let assetURL = try writeJPEG(named: "a.jpg", width: 2400, height: 1600)
        let data = await ThumbnailLoader.shared.loadDisplayPreview(
            for: AssetRef(url: assetURL))
        let bytes = try XCTUnwrap(data)

        // Display-res, not thumbnail-res: capped at the 1600 tier target and
        // well above the 256 px grid thumb.
        let edge = try longEdge(of: bytes)
        XCTAssertLessThanOrEqual(edge, Int(ThumbnailLoader.displayPreviewLongEdge))
        XCTAssertGreaterThanOrEqual(edge, 1_024)

        // Persisted at the canonical asset-relative location so the editor
        // cold-open seed + a later Preview open reuse it.
        let previewURL = MapleSidecarPaths.previewURL(for: assetURL)
        XCTAssertTrue(FileManager.default.fileExists(atPath: previewURL.path))
    }

    func testServesPreStagedFreshTierWithoutRegenerating() async throws {
        let assetURL = try writeJPEG(named: "b.jpg", width: 2400, height: 1600)
        let previewURL = MapleSidecarPaths.previewURL(for: assetURL)
        try FileManager.default.createDirectory(
            at: previewURL.deletingLastPathComponent(), withIntermediateDirectories: true)
        let staged = Data([0xFF, 0xD8, 0x01, 0x02, 0xFF, 0xD9])
        try staged.write(to: previewURL)

        let data = await ThumbnailLoader.shared.loadDisplayPreview(
            for: AssetRef(url: assetURL))
        XCTAssertEqual(data, staged)
    }

    // MARK: - Edited-photo gate

    func testRatingOnlySidecarStillGenerates() async throws {
        let assetURL = try writeJPEG(named: "c.jpg", width: 2400, height: 1600)
        // A culling save records the as-shot WB seed (non-default numbers)
        // but no visual edit — the common rate-in-Preview case.
        let seeded = AdjustmentModel(temperature: 5_230, tint: -12)
        try writeSidecar(
            for: assetURL, model: seeded,
            culling: CullingState(stars: 3, flag: .pick))

        let data = await ThumbnailLoader.shared.loadDisplayPreview(
            for: AssetRef(url: assetURL))
        XCTAssertNotNil(data, "a rated-but-unedited photo must still get the hi-res tier")
    }

    func testVisuallyEditedSidecarBlocksColdGeneration() async throws {
        let assetURL = try writeJPEG(named: "d.jpg", width: 2400, height: 1600)
        try writeSidecar(for: assetURL, model: AdjustmentModel(exposure: 1.2))

        let data = await ThumbnailLoader.shared.loadDisplayPreview(
            for: AssetRef(url: assetURL))
        XCTAssertNil(
            data,
            "camera-original pixels must not be served over an edited thumbnail")
        let previewURL = MapleSidecarPaths.previewURL(for: assetURL)
        XCTAssertFalse(FileManager.default.fileExists(atPath: previewURL.path))
    }

    func testEditedSidecarWithFreshRenderedTierServesIt() async throws {
        let assetURL = try writeJPEG(named: "e.jpg", width: 2400, height: 1600)
        try writeSidecar(for: assetURL, model: AdjustmentModel(exposure: 1.2))
        // The render-publish path wrote a developed preview (what
        // `updateDisplayPreviewFromRender` produces) — the gate only blocks
        // COLD generation from the camera original.
        let previewURL = MapleSidecarPaths.previewURL(for: assetURL)
        try FileManager.default.createDirectory(
            at: previewURL.deletingLastPathComponent(), withIntermediateDirectories: true)
        let developed = Data([0xFF, 0xD8, 0xAA, 0xBB, 0xFF, 0xD9])
        try developed.write(to: previewURL)

        let data = await ThumbnailLoader.shared.loadDisplayPreview(
            for: AssetRef(url: assetURL))
        XCTAssertEqual(data, developed)
    }

    // MARK: - Render refresh

    func testUpdateDisplayPreviewFromRenderWritesDownscaledTier() async throws {
        let assetURL = try writeJPEG(named: "f.jpg", width: 64, height: 64)
        let space = CGColorSpace(name: CGColorSpace.sRGB)!
        let ctx = try XCTUnwrap(CGContext(
            data: nil, width: 3_200, height: 2_000,
            bitsPerComponent: 8, bytesPerRow: 0, space: space,
            bitmapInfo: CGImageAlphaInfo.noneSkipLast.rawValue
        ))
        ctx.setFillColor(CGColor(red: 0.8, green: 0.2, blue: 0.1, alpha: 1))
        ctx.fill(CGRect(x: 0, y: 0, width: 3_200, height: 2_000))
        let rendered = CIImage(cgImage: try XCTUnwrap(ctx.makeImage()))

        await ThumbnailLoader.shared.updateDisplayPreviewFromRender(rendered, for: assetURL)

        let previewURL = MapleSidecarPaths.previewURL(for: assetURL)
        let bytes = try Data(contentsOf: previewURL)
        XCTAssertEqual(try longEdge(of: bytes), Int(ThumbnailLoader.displayPreviewLongEdge))
    }

    // MARK: - Non-image guards

    func testVideoAssetReturnsNil() async throws {
        let url = tmpDir.appendingPathComponent("clip.mov")
        try Data([0x00, 0x01]).write(to: url)
        let data = await ThumbnailLoader.shared.loadDisplayPreview(for: AssetRef(url: url))
        XCTAssertNil(data)
    }

    // MARK: - AdjustmentModel.isVisuallyEditedBeyondWhiteBalance

    func testWhiteBalanceOnlyModelIsNotVisuallyEdited() {
        XCTAssertFalse(AdjustmentModel().isVisuallyEditedBeyondWhiteBalance)
        XCTAssertFalse(
            AdjustmentModel(temperature: 3_800, tint: 40, wbScaleVersion: 1)
                .isVisuallyEditedBeyondWhiteBalance)
    }

    func testNonWhiteBalanceAdjustmentIsVisuallyEdited() {
        XCTAssertTrue(AdjustmentModel(exposure: 0.5).isVisuallyEditedBeyondWhiteBalance)
        XCTAssertTrue(AdjustmentModel(contrast: 10).isVisuallyEditedBeyondWhiteBalance)
        XCTAssertTrue(
            AdjustmentModel(crop: Crop(top: 0.1, left: 0.1, bottom: 0.9, right: 0.9, angle: 0))
                .isVisuallyEditedBeyondWhiteBalance)
    }
}
