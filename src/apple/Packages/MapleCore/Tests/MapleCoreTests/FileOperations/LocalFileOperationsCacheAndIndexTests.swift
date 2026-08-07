// LocalFileOperationsCacheAndIndexTests.swift — steps 5 & 7 of the relocate
// contract (issue #2631): the stale thumb/preview cache at the OLD location
// is cleared on a move (never on a copy, which leaves the original valid),
// and the non-authoritative `LibraryIndex` entry follows best-effort.

import CoreImage
import XCTest
@testable import MapleCore

final class LocalFileOperationsCacheAndIndexTests: XCTestCase {
    private var root: URL!

    override func setUp() {
        super.setUp()
        root = FileOperationsTestSupport.makeTempDir()
    }

    override func tearDown() {
        FileOperationsTestSupport.cleanup(root)
        root = nil
        super.tearDown()
    }

    func testMoveClearsTheStaleThumbAndPreviewCacheAtTheOldLocation() async throws {
        let source = FileOperationsTestSupport.write("pixels", to: root.appendingPathComponent("IMG_1.dng"))
        let oldThumb = MapleSidecarPaths.thumbURL(for: source)
        let oldPreview = MapleSidecarPaths.previewURL(for: source)
        FileOperationsTestSupport.write("thumb-bytes", to: oldThumb)
        FileOperationsTestSupport.write("preview-bytes", to: oldPreview)

        _ = try await LocalFileOperations.relocate(source, to: root.appendingPathComponent("Album"), mode: .move)

        XCTAssertFalse(FileOperationsTestSupport.exists(oldThumb))
        XCTAssertFalse(FileOperationsTestSupport.exists(oldPreview))
    }

    func testCopyDoesNotTouchTheSourcesCache() async throws {
        let source = FileOperationsTestSupport.write("pixels", to: root.appendingPathComponent("IMG_1.dng"))
        let oldThumb = MapleSidecarPaths.thumbURL(for: source)
        FileOperationsTestSupport.write("thumb-bytes", to: oldThumb)

        _ = try await LocalFileOperations.relocate(source, to: root.appendingPathComponent("Album"), mode: .copy)

        XCTAssertTrue(FileOperationsTestSupport.exists(oldThumb), "a copy leaves the original — and its cache — valid")
    }

    func testMoveRemovesTheOldFolderIndexEntryAndCarriesCullingToTheNewOne() async throws {
        let sourceFolder = root.appendingPathComponent("Source")
        let destFolder = root.appendingPathComponent("Dest")
        let source = FileOperationsTestSupport.write("pixels", to: sourceFolder.appendingPathComponent("IMG_1.dng"))

        let sourceStore = LibraryIndexStore(folderURL: sourceFolder)
        try await sourceStore.updateEntry(name: "IMG_1.dng", culling: CullingState(stars: 3, flag: .pick))

        _ = try await LocalFileOperations.relocate(source, to: destFolder, mode: .move)

        // A FRESH store, so the read genuinely goes to disk rather than to
        // `sourceStore`'s in-memory cache of its own earlier write — the
        // relocate's internal store is a separate actor instance from
        // `sourceStore` and only the on-disk file is shared between them.
        let freshSourceStore = LibraryIndexStore(folderURL: sourceFolder)
        let sourceIndex = try await freshSourceStore.load()
        XCTAssertNil(sourceIndex?.entries["IMG_1.dng"], "the stale entry must be removed from the old folder's index")

        let destStore = LibraryIndexStore(folderURL: destFolder)
        let destIndex = try await destStore.load()
        let entry = try XCTUnwrap(destIndex?.entries["IMG_1.dng"])
        XCTAssertEqual(entry.stars, 3)
        XCTAssertEqual(entry.flag, "pick")
    }

    // MARK: - #2659: RenderedPreviewCache (docs/caching.md § 3) is a SEPARATE
    // cache from the plain thumbURL/previewURL files above — its own
    // {urlHash}_{variantHash}.jpg naming, plus a 20-entry in-memory front.
    // `invalidateDerivedCaches` used to only remove the two files above and
    // never touched this cache at all, so a move left the OLD entry (both
    // the in-memory front AND the on-disk file) behind indefinitely — a
    // genuine unbounded leak the #2659 verification pass caught. This test
    // guards the fix (`invalidateDerivedCaches` now also awaits
    // `RenderedPreviewCache.shared.invalidate(assetURL:)`).

    func testMoveInvalidatesTheOldLocationsRenderedPreviewCacheMemoryAndDisk() async throws {
        let source = FileOperationsTestSupport.write("pixels", to: root.appendingPathComponent("IMG_1.dng"))
        // `invalidateDerivedCaches` invalidates against `.shared`'s CURRENT
        // configured folder — matches how the app actually configures this
        // singleton once per opened folder, never per-call.
        await RenderedPreviewCache.shared.configure(folderURL: root)
        let swatch = CIImage(color: CIColor(red: 0.4, green: 0.5, blue: 0.6))
            .cropped(to: CGRect(x: 0, y: 0, width: 64, height: 48))
        await RenderedPreviewCache.shared.storePreview(swatch, for: source, screenWidth: 800)

        // Sanity: the preview really was cached (memory front) before the
        // move — otherwise "gone after the move" would trivially pass.
        let hitBefore = await RenderedPreviewCache.shared.preview(for: source, screenWidth: 800)
        XCTAssertNotNil(hitBefore, "sanity: the preview was actually stored before the move")

        _ = try await LocalFileOperations.relocate(source, to: root.appendingPathComponent("Album"), mode: .move)

        let hitAfter = await RenderedPreviewCache.shared.preview(for: source, screenWidth: 800)
        XCTAssertNil(hitAfter, "the OLD url's rendered-preview entry (memory AND disk) must not survive a move")
    }

    func testCopyDoesNotTouchTheSourcesRenderedPreviewCache() async throws {
        let source = FileOperationsTestSupport.write("pixels", to: root.appendingPathComponent("IMG_1.dng"))
        await RenderedPreviewCache.shared.configure(folderURL: root)
        let swatch = CIImage(color: CIColor(red: 0.4, green: 0.5, blue: 0.6))
            .cropped(to: CGRect(x: 0, y: 0, width: 64, height: 48))
        await RenderedPreviewCache.shared.storePreview(swatch, for: source, screenWidth: 800)

        _ = try await LocalFileOperations.relocate(source, to: root.appendingPathComponent("Album"), mode: .copy)

        let hit = await RenderedPreviewCache.shared.preview(for: source, screenWidth: 800)
        XCTAssertNotNil(hit, "a copy leaves the original — and its rendered-preview cache — valid")
    }

    func testMoveWithNoPriorIndexEntryStillCreatesAFreshOneAtTheDestination() async throws {
        let sourceFolder = root.appendingPathComponent("Source")
        let destFolder = root.appendingPathComponent("Dest")
        let source = FileOperationsTestSupport.write("pixels", to: sourceFolder.appendingPathComponent("IMG_1.dng"))

        _ = try await LocalFileOperations.relocate(source, to: destFolder, mode: .move)

        let destStore = LibraryIndexStore(folderURL: destFolder)
        let destIndex = try await destStore.load()
        XCTAssertNotNil(destIndex?.entries["IMG_1.dng"])
    }
}
