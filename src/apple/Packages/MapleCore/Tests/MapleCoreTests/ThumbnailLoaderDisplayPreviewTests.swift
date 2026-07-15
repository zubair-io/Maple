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
        ThumbnailLoader.writeDisplayPreviewMarker(for: assetURL)

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

    func testPreviewSupersededByNewerEditedSidecarIsNotServed() async throws {
        let assetURL = try writeJPEG(named: "g.jpg", width: 2400, height: 1600)
        // A camera-original preview exists, then a visually-edited sidecar
        // arrives much later (e.g. synced from another device). The stale
        // preview must not swap camera-original pixels over the edited state.
        let previewURL = MapleSidecarPaths.previewURL(for: assetURL)
        try FileManager.default.createDirectory(
            at: previewURL.deletingLastPathComponent(), withIntermediateDirectories: true)
        try Data([0xFF, 0xD8, 0x01, 0x02, 0xFF, 0xD9]).write(to: previewURL)
        // Backdate the preview (and the asset, so the asset-mtime freshness
        // gate stays satisfied) beyond the autosave slack.
        let past = Date(timeIntervalSinceNow: -3_600)
        try FileManager.default.setAttributes(
            [.modificationDate: past], ofItemAtPath: previewURL.path)
        try FileManager.default.setAttributes(
            [.modificationDate: past], ofItemAtPath: assetURL.path)
        try writeSidecar(for: assetURL, model: AdjustmentModel(exposure: 1.2))

        let data = await ThumbnailLoader.shared.loadDisplayPreview(
            for: AssetRef(url: assetURL))
        XCTAssertNil(data)
    }

    func testEditedSidecarWithFreshRenderedTierServesIt() async throws {
        let assetURL = try writeJPEG(named: "e.jpg", width: 2400, height: 1600)
        try writeSidecar(for: assetURL, model: AdjustmentModel(exposure: 1.2))
        // The render-publish path wrote a developed preview (what
        // `updateDisplayPreviewFromRender` produces) to the LOCAL edited tier
        // (#2009) — the gate only blocks COLD generation from the camera
        // original into the canonical shared tier.
        let editedURL = MapleSidecarPaths.editedPreviewURL(for: assetURL)
        try FileManager.default.createDirectory(
            at: editedURL.deletingLastPathComponent(), withIntermediateDirectories: true)
        let developed = Data([0xFF, 0xD8, 0xAA, 0xBB, 0xFF, 0xD9])
        try developed.write(to: editedURL)
        ThumbnailLoader.writeEditedPreviewMarker(for: assetURL)

        let data = await ThumbnailLoader.shared.loadDisplayPreview(
            for: AssetRef(url: assetURL))
        XCTAssertEqual(data, developed)
    }

    func testEditedSidecarWithoutFreshEditedMarkerBlocksColdGeneration() async throws {
        let assetURL = try writeJPEG(named: "h.jpg", width: 2400, height: 1600)
        try writeSidecar(for: assetURL, model: AdjustmentModel(exposure: 1.2))
        // A LOCAL edited-tier file exists but its marker is stale (doesn't
        // match the current sidecar state) — must not be served, and must
        // NOT fall through to generating camera-original pixels either
        // (#2009: the existing edited-photo gate still applies).
        let editedURL = MapleSidecarPaths.editedPreviewURL(for: assetURL)
        try FileManager.default.createDirectory(
            at: editedURL.deletingLastPathComponent(), withIntermediateDirectories: true)
        try Data([0xFF, 0xD8, 0xAA, 0xBB, 0xFF, 0xD9]).write(to: editedURL)
        try "stale".write(
            to: MapleSidecarPaths.editedPreviewMarkerURL(for: assetURL),
            atomically: true, encoding: .utf8)

        let data = await ThumbnailLoader.shared.loadDisplayPreview(
            for: AssetRef(url: assetURL))
        XCTAssertNil(data)
        // The stale edited render is cleaned up eagerly rather than left for
        // cache-gc's backstop sweep.
        XCTAssertFalse(FileManager.default.fileExists(atPath: editedURL.path))
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

        // #2009: the render-publish path writes the LOCAL edited tier, never
        // the canonical shared `previewURL` (the camera-original contract
        // the server's describe/OCR pipeline reads).
        let editedURL = MapleSidecarPaths.editedPreviewURL(for: assetURL)
        let bytes = try Data(contentsOf: editedURL)
        XCTAssertEqual(try longEdge(of: bytes), Int(ThumbnailLoader.displayPreviewLongEdge))
        XCTAssertTrue(ThumbnailLoader.editedPreviewMarkerIsCurrent(for: assetURL))

        let previewURL = MapleSidecarPaths.previewURL(for: assetURL)
        XCTAssertFalse(
            FileManager.default.fileExists(atPath: previewURL.path),
            "an edited render must never land in the shared camera-original file")
    }

    // MARK: - Edited preview marker + cleanup (#2009)

    func testEditedPreviewMarkerInvalidatesWhenSidecarChanges() async throws {
        let assetURL = try writeJPEG(named: "i.jpg", width: 64, height: 64)
        try writeSidecar(for: assetURL, model: AdjustmentModel(exposure: 0.5))
        try FileManager.default.createDirectory(
            at: MapleSidecarPaths.editedPreviewMarkerURL(for: assetURL)
                .deletingLastPathComponent(),
            withIntermediateDirectories: true)
        ThumbnailLoader.writeEditedPreviewMarker(for: assetURL)
        XCTAssertTrue(ThumbnailLoader.editedPreviewMarkerIsCurrent(for: assetURL))

        // A new edit (slider move, crop, revert — any sidecar rewrite) must
        // invalidate the marker written for the OLD sidecar state, even
        // though `ThumbnailLoader.displayPreviewTierVersion` hasn't changed
        // — the two are independent invalidation triggers. Backdate past
        // `sidecarAutosaveSlack` (10s) so this reads as a genuine new edit,
        // not the debounced-autosave lag `editedPreviewMarkerIsCurrent`
        // deliberately tolerates (see the test below).
        try writeSidecar(for: assetURL, model: AdjustmentModel(exposure: 1.4))
        let sidecarURL = SidecarPath.sidecarURL(for: assetURL)
        try FileManager.default.setAttributes(
            [.modificationDate: Date(timeIntervalSinceNow: 20)],
            ofItemAtPath: sidecarURL.path)
        XCTAssertFalse(ThumbnailLoader.editedPreviewMarkerIsCurrent(for: assetURL))
    }

    /// #2009 / Jules review (PR #2013): the render-publish path captures
    /// whatever the sidecar says AT RENDER TIME, which routinely trails the
    /// live in-memory model by up to the 750 ms debounced-autosave window.
    /// The autosave landing a beat later for the SAME edit must not read as
    /// a sidecar change and self-invalidate the preview it just wrote.
    func testEditedPreviewMarkerTolerantOfDebouncedAutosaveLag() async throws {
        let assetURL = try writeJPEG(named: "l.jpg", width: 64, height: 64)
        try writeSidecar(for: assetURL, model: AdjustmentModel(exposure: 0.5))
        try FileManager.default.createDirectory(
            at: MapleSidecarPaths.editedPreviewMarkerURL(for: assetURL)
                .deletingLastPathComponent(),
            withIntermediateDirectories: true)
        ThumbnailLoader.writeEditedPreviewMarker(for: assetURL)

        // Simulate the debounced autosave landing ~1s after the render
        // captured the marker — well within `sidecarAutosaveSlack` (10s).
        let sidecarURL = SidecarPath.sidecarURL(for: assetURL)
        try FileManager.default.setAttributes(
            [.modificationDate: Date(timeIntervalSinceNow: 1)],
            ofItemAtPath: sidecarURL.path)

        XCTAssertTrue(
            ThumbnailLoader.editedPreviewMarkerIsCurrent(for: assetURL),
            "a same-edit autosave landing within the slack window must not invalidate the marker")
    }

    func testFreshEditedPreviewDataPrefersLocalEditedRenderOverCanonicalTier() async throws {
        let assetURL = try writeJPEG(named: "j.jpg", width: 2400, height: 1600)
        // Both tiers present + fresh — the local edited render must win.
        let previewURL = MapleSidecarPaths.previewURL(for: assetURL)
        try FileManager.default.createDirectory(
            at: previewURL.deletingLastPathComponent(), withIntermediateDirectories: true)
        try Data([0xFF, 0xD8, 0x01, 0x02, 0xFF, 0xD9]).write(to: previewURL)
        ThumbnailLoader.writeDisplayPreviewMarker(for: assetURL)

        let editedURL = MapleSidecarPaths.editedPreviewURL(for: assetURL)
        let developed = Data([0xFF, 0xD8, 0xAA, 0xBB, 0xFF, 0xD9])
        try developed.write(to: editedURL)
        ThumbnailLoader.writeEditedPreviewMarker(for: assetURL)

        let data = await ThumbnailLoader.shared.loadDisplayPreview(
            for: AssetRef(url: assetURL))
        XCTAssertEqual(data, developed)
    }

    func testRemoveEditedPreviewDeletesBothFiles() throws {
        let assetURL = try writeJPEG(named: "k.jpg", width: 64, height: 64)
        let editedURL = MapleSidecarPaths.editedPreviewURL(for: assetURL)
        try FileManager.default.createDirectory(
            at: editedURL.deletingLastPathComponent(), withIntermediateDirectories: true)
        try Data([0xFF, 0xD8]).write(to: editedURL)
        ThumbnailLoader.writeEditedPreviewMarker(for: assetURL)

        ThumbnailLoader.removeEditedPreview(for: assetURL)

        XCTAssertFalse(FileManager.default.fileExists(atPath: editedURL.path))
        XCTAssertFalse(
            FileManager.default.fileExists(
                atPath: MapleSidecarPaths.editedPreviewMarkerURL(for: assetURL).path))
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
