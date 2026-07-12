// RenderedPreviewCacheTests.swift — the post-adjustment rendered-preview
// disk cache key contract (RenderedPreviewCache.swift).
//
// Focus of #1928: the key must include the PRIMARY file's mtime, not only the
// sidecar's — otherwise a pixel change that leaves the sidecar untouched
// (re-import / external sync / filesystem restore) serves a preview developed
// from the old bytes under an identical key.
//
// Every case uses a fresh `RenderedPreviewCache()` instance pointed at a temp
// `.maple/previews/` dir so lookups exercise the DISK path (the shared
// in-memory front would otherwise mask a key change) and never touch the app's
// real cache. Real files in a temp directory throughout.

import CoreImage
import Foundation
import XCTest

@testable import MapleCore

final class RenderedPreviewCacheTests: XCTestCase {

    private var tmpDir: URL!

    override func setUpWithError() throws {
        tmpDir = FileManager.default.temporaryDirectory
            .appendingPathComponent("rendered-preview-cache-tests-\(UUID().uuidString)")
        try FileManager.default.createDirectory(at: tmpDir, withIntermediateDirectories: true)
    }

    override func tearDownWithError() throws {
        try? FileManager.default.removeItem(at: tmpDir)
    }

    // MARK: - Helpers

    private func writeFile(_ name: String, contents: String = "x") throws -> URL {
        let url = tmpDir.appendingPathComponent(name)
        try Data(contents.utf8).write(to: url)
        return url
    }

    private func setMtime(_ url: URL, _ date: Date) throws {
        try FileManager.default.setAttributes(
            [.modificationDate: date], ofItemAtPath: url.path)
    }

    private func swatch() -> CIImage {
        CIImage(color: CIColor(red: 0.4, green: 0.5, blue: 0.6))
            .cropped(to: CGRect(x: 0, y: 0, width: 64, height: 48))
    }

    /// A cache configured against the temp folder. Fresh instance per call so
    /// the read path can't be served by another instance's memory front.
    private func freshCache() async -> RenderedPreviewCache {
        let cache = RenderedPreviewCache()
        await cache.configure(folderURL: tmpDir)
        return cache
    }

    // MARK: - Round-trip

    func testStoredPreviewIsReadBackFromDisk() async throws {
        let asset = try writeFile("a.dng")
        await freshCache().storePreview(swatch(), for: asset, screenWidth: 800)

        // A DIFFERENT instance — the entry can only come from disk.
        let hit = await freshCache().preview(for: asset, screenWidth: 800)
        XCTAssertNotNil(hit, "a stored preview must survive to disk and read back")
    }

    func testDifferentScreenWidthMisses() async throws {
        let asset = try writeFile("b.dng")
        await freshCache().storePreview(swatch(), for: asset, screenWidth: 800)
        let hit = await freshCache().preview(for: asset, screenWidth: 1600)
        XCTAssertNil(hit, "screen width is a key component — a different bucket must miss")
    }

    // MARK: - #1928: primary mtime is in the key

    func testPrimaryMtimeChangeInvalidates() async throws {
        let asset = try writeFile("c.dng")
        try setMtime(asset, Date(timeIntervalSince1970: 1_000_000))
        await freshCache().storePreview(swatch(), for: asset, screenWidth: 800)

        // Same bytes-path asset, sidecar still absent, but the primary file's
        // mtime moved (re-import / restore). The stale preview must NOT serve.
        try setMtime(asset, Date(timeIntervalSince1970: 2_000_000))
        let hit = await freshCache().preview(for: asset, screenWidth: 800)
        XCTAssertNil(hit, "a primary-file mtime change must invalidate the rendered preview (#1928)")
    }

    func testUnchangedPrimaryMtimeStillHits() async throws {
        let asset = try writeFile("d.dng")
        try setMtime(asset, Date(timeIntervalSince1970: 1_500_000))
        await freshCache().storePreview(swatch(), for: asset, screenWidth: 800)

        // Re-stat at the same mtime → same key → disk hit.
        let hit = await freshCache().preview(for: asset, screenWidth: 800)
        XCTAssertNotNil(hit, "an unchanged primary mtime must still hit")
    }

    // MARK: - Sidecar mtime is in the key (adjustment-version proxy)

    func testSidecarMtimeChangeInvalidates() async throws {
        let asset = try writeFile("e.dng")
        await freshCache().storePreview(swatch(), for: asset, screenWidth: 800)

        // A slider change rewrites the sidecar; its mtime becomes part of the
        // key, so the previously-cached (sidecar-absent) entry must miss.
        let sidecar = SidecarPath.sidecarURL(for: asset)
        try Data("<xmp/>".utf8).write(to: sidecar)
        let hit = await freshCache().preview(for: asset, screenWidth: 800)
        XCTAssertNil(hit, "writing/altering the sidecar must invalidate the rendered preview")
    }

    // MARK: - Explicit invalidate

    func testInvalidateRemovesAllWidths() async throws {
        let asset = try writeFile("f.dng")
        let cache = await freshCache()
        await cache.storePreview(swatch(), for: asset, screenWidth: 800)
        await cache.storePreview(swatch(), for: asset, screenWidth: 1600)

        await cache.invalidate(assetURL: asset)

        let a = await freshCache().preview(for: asset, screenWidth: 800)
        let b = await freshCache().preview(for: asset, screenWidth: 1600)
        XCTAssertNil(a)
        XCTAssertNil(b)
    }

    // MARK: - #1926: the single-sourced pipeline-output version is in the key

    /// The `variantToken` that seeds the cache key carries the codegen-sourced
    /// `AdjustmentModel.pipelineOutputVersion`, so a raw-core pipeline-output
    /// change (which bumps that constant) participates in the key.
    func testPipelineOutputVersionIsFoldedIntoKey() {
        let token = RenderedPreviewCache.variantToken(
            primaryMtime: "1000",
            sidecarMtime: "0",
            screenWidth: 800,
            viewTransformVersion: 7,
            pipelineOutputVersion: AdjustmentModel.pipelineOutputVersion)
        XCTAssertTrue(
            token.contains("_pv\(AdjustmentModel.pipelineOutputVersion)"),
            "the variant token must carry the single-sourced pipelineOutputVersion (#1926)")
    }

    /// Bumping `pipelineOutputVersion` changes the variant token — and thus the
    /// hashed key — so previews rendered under an older pipeline version can no
    /// longer be served. This is the invalidation guarantee the single source
    /// exists to provide.
    func testBumpingPipelineOutputVersionChangesTheKey() {
        func token(_ pv: UInt32) -> String {
            RenderedPreviewCache.variantToken(
                primaryMtime: "1000",
                sidecarMtime: "0",
                screenWidth: 800,
                viewTransformVersion: 7,
                pipelineOutputVersion: pv)
        }
        let current = AdjustmentModel.pipelineOutputVersion
        XCTAssertNotEqual(
            token(current), token(current + 1),
            "a pipelineOutputVersion bump must change the cache key (#1926)")
    }
}
