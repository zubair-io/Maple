// SMBFileOperationsCacheInvalidationTests.swift — the SMB counterpart of
// step 7 in LocalFileOperationsCacheAndIndexTests (issue #2689): a move
// clears the stale on-share thumb/preview entries at the OLD location
// (never on a copy, which leaves the original valid). The entries live ON
// THE SHARE — written there by the Self Hosted indexer, Web Hosted, or a
// Mac browsing the same share through a Finder mount — so the fake seeds
// them at the exact cross-layer paths `MapleSidecarPaths` defines.

import XCTest
import CoreImage
@testable import MapleCore

final class SMBFileOperationsCacheInvalidationTests: XCTestCase {

    /// `<dir>/.maple/thumbs/<sha256Prefix16(basename)>.avif` — the same
    /// derivation production uses (`MapleSidecarPaths.thumbURL`), spelled
    /// out here against share-relative string paths.
    private func thumbPath(dir: String, basename: String) -> String {
        "\(dir)/.maple/thumbs/\(MapleThumbCacheKey.thumbFilename(forRawBasename: basename))"
    }

    /// `<dir>/.maple/previews/<basename>.avif` (`MapleSidecarPaths.previewURL`).
    private func previewPath(dir: String, basename: String) -> String {
        "\(dir)/.maple/previews/\(basename).avif"
    }

    func testMoveClearsTheStaleThumbAndPreviewAtTheOldLocation() async throws {
        let t = FakeSMBTransport()
        await t.seed("pixels", at: "/Source/IMG_1.dng")
        await t.seed("thumb-bytes", at: thumbPath(dir: "/Source", basename: "IMG_1.dng"))
        await t.seed("preview-bytes", at: previewPath(dir: "/Source", basename: "IMG_1.dng"))

        _ = try await SMBFileOperations.relocate("/Source/IMG_1.dng", to: "/Album", mode: .move, transport: t)

        let thumbStillThere = await t.fileExists(at: thumbPath(dir: "/Source", basename: "IMG_1.dng"))
        XCTAssertFalse(thumbStillThere, "the old location's thumb entry is stale after a move")
        let previewStillThere = await t.fileExists(at: previewPath(dir: "/Source", basename: "IMG_1.dng"))
        XCTAssertFalse(previewStillThere, "the old location's preview entry is stale after a move")
    }

    func testCopyDoesNotTouchTheSourcesCache() async throws {
        let t = FakeSMBTransport()
        await t.seed("pixels", at: "/Source/IMG_1.dng")
        await t.seed("thumb-bytes", at: thumbPath(dir: "/Source", basename: "IMG_1.dng"))
        await t.seed("preview-bytes", at: previewPath(dir: "/Source", basename: "IMG_1.dng"))

        _ = try await SMBFileOperations.relocate("/Source/IMG_1.dng", to: "/Album", mode: .copy, transport: t)

        let thumbStillThere = await t.fileExists(at: thumbPath(dir: "/Source", basename: "IMG_1.dng"))
        XCTAssertTrue(thumbStillThere, "a copy leaves the original — and its cache — valid")
        let previewStillThere = await t.fileExists(at: previewPath(dir: "/Source", basename: "IMG_1.dng"))
        XCTAssertTrue(previewStillThere)
    }

    func testCaseOnlyRenameClearsTheOldCasingsEntries() async throws {
        // The basename is the hash input (thumbs) and the literal filename
        // (previews), so a case-only rename changes both keys — the
        // old-cased entries are exactly as stale as after a real move.
        let t = FakeSMBTransport()
        await t.seed("pixels", at: "/Source/IMG_1.dng")
        await t.seed("thumb-bytes", at: thumbPath(dir: "/Source", basename: "IMG_1.dng"))
        await t.seed("preview-bytes", at: previewPath(dir: "/Source", basename: "IMG_1.dng"))

        _ = try await SMBFileOperations.relocate(
            "/Source/IMG_1.dng", to: "/Source", newBasename: "img_1.dng", mode: .move, transport: t)

        let thumbStillThere = await t.fileExists(at: thumbPath(dir: "/Source", basename: "IMG_1.dng"))
        XCTAssertFalse(thumbStillThere, "a case-only rename changes the hash input — the old-cased entry is stale")
        let previewStillThere = await t.fileExists(at: previewPath(dir: "/Source", basename: "IMG_1.dng"))
        XCTAssertFalse(previewStillThere)
    }

    func testTrashClearsTheOldLocationEntries() async throws {
        // Trash routes through the same relocate primitive, so it inherits
        // the invalidation — locked in here so a future trash-specific
        // fast path can't silently drop it.
        let t = FakeSMBTransport()
        await t.seed("pixels", at: "/Source/IMG_1.dng")
        await t.seed("thumb-bytes", at: thumbPath(dir: "/Source", basename: "IMG_1.dng"))

        _ = try await SMBFileOperations.trash("/Source/IMG_1.dng", transport: t)

        let thumbStillThere = await t.fileExists(at: thumbPath(dir: "/Source", basename: "IMG_1.dng"))
        XCTAssertFalse(thumbStillThere)
    }

    // MARK: - `RenderedPreviewCache` invalidation (#2946)
    //
    // `RenderedPreviewCache` is a SEPARATE, per-device cache from the
    // on-share thumb/preview entries above — it is never seeded by this
    // fake transport, so these tests seed it directly the same way
    // `invalidateDerivedCaches` itself keys it: `URL(fileURLWithPath:)`
    // wrapping the OLD share-relative primary path.

    func testRelocateClearsTheLocalRenderedPreviewCacheEntryForTheOldURL() async throws {
        let t = FakeSMBTransport()
        await t.seed("pixels", at: "/Source/IMG_1.dng")
        let oldURL = URL(fileURLWithPath: "/Source/IMG_1.dng")
        let image = CIImage(color: .red).cropped(to: CGRect(x: 0, y: 0, width: 4, height: 4))
        await RenderedPreviewCache.shared.storePreview(image, for: oldURL, screenWidth: 100)
        let seeded = await RenderedPreviewCache.shared.preview(for: oldURL, screenWidth: 100)
        XCTAssertNotNil(seeded, "precondition: the entry exists before the relocate")

        _ = try await SMBFileOperations.relocate("/Source/IMG_1.dng", to: "/Album", mode: .move, transport: t)

        let afterRelocate = await RenderedPreviewCache.shared.preview(for: oldURL, screenWidth: 100)
        XCTAssertNil(afterRelocate, "the old URL's local rendered-preview entry must be gone after a move")
    }

    func testTrashClearsTheLocalRenderedPreviewCacheEntryForTheOldURL() async throws {
        let t = FakeSMBTransport()
        await t.seed("pixels", at: "/Source/IMG_1.dng")
        let oldURL = URL(fileURLWithPath: "/Source/IMG_1.dng")
        let image = CIImage(color: .red).cropped(to: CGRect(x: 0, y: 0, width: 4, height: 4))
        await RenderedPreviewCache.shared.storePreview(image, for: oldURL, screenWidth: 100)
        let seeded = await RenderedPreviewCache.shared.preview(for: oldURL, screenWidth: 100)
        XCTAssertNotNil(seeded, "precondition: the entry exists before the trash")

        _ = try await SMBFileOperations.trash("/Source/IMG_1.dng", transport: t)

        let afterTrash = await RenderedPreviewCache.shared.preview(for: oldURL, screenWidth: 100)
        XCTAssertNil(afterTrash, "the old URL's local rendered-preview entry must be gone after a trash")
    }
}
