// LocalFileOperationsTrashTests.swift — Delete → Trash for the local
// Filesystem source (issue #2631). macOS gets a real-Trash test (cleaned up
// immediately afterward — see its comment); the `.maple/trash/<rel>`
// fallback (iOS/iPadOS's actual path, and reachable directly on macOS too
// since it carries no `#if os` gate) gets full coverage on whichever
// platform runs the suite.

import XCTest
@testable import MapleCore

final class LocalFileOperationsTrashTests: XCTestCase {
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

    // MARK: - `.maple/trash/<rel>` fallback (all platforms)

    func testTrashToMapleFolderPreservesRelativeStructure() async throws {
        let source = FileOperationsTestSupport.write(
            "pixels", to: root.appendingPathComponent("2024/Paris/IMG_1.dng"))
        FileOperationsTestSupport.write("<xmp/>", to: SidecarPath.sidecarURL(for: source))

        let outcome = try await LocalFileOperations.trashToMapleFolder(source, libraryRoot: root)

        XCTAssertFalse(FileOperationsTestSupport.exists(source))
        XCTAssertEqual(outcome.primaryPath,
                       root.appendingPathComponent(".maple/trash/2024/Paris/IMG_1.dng").path)
        XCTAssertTrue(outcome.sidecarFollowed)
    }

    func testTrashToMapleFolderAutoSuffixesOnCollision() async throws {
        let first = FileOperationsTestSupport.write("first", to: root.appendingPathComponent("IMG_1.dng"))
        _ = try await LocalFileOperations.trashToMapleFolder(first, libraryRoot: root)

        let second = FileOperationsTestSupport.write("second", to: root.appendingPathComponent("IMG_1.dng"))
        let outcome = try await LocalFileOperations.trashToMapleFolder(second, libraryRoot: root)

        XCTAssertTrue(outcome.renamedDueToCollision)
        XCTAssertEqual(URL(fileURLWithPath: outcome.primaryPath).lastPathComponent, "IMG_1.1.dng")
    }

    func testTrashDestinationDirRejectsAnItemOutsideTheLibraryRoot() {
        let outsider = FileManager.default.temporaryDirectory.appendingPathComponent("outsider.dng")
        XCTAssertThrowsError(try LocalFileOperations.trashDestinationDir(for: outsider, libraryRoot: root))
    }

    // MARK: - Restore / list / purge (#2653)

    func testTrashToMapleFolderWritesATrashedDateMarker() async throws {
        let source = FileOperationsTestSupport.write("pixels", to: root.appendingPathComponent("IMG_1.dng"))
        let outcome = try await LocalFileOperations.trashToMapleFolder(source, libraryRoot: root)

        XCTAssertNotNil(LocalFileOperations.trashedDate(forItemAt: URL(fileURLWithPath: outcome.primaryPath)))
    }

    func testListMapleTrashFindsTrashedItemsAndSkipsMarkersAndSidecars() async throws {
        let source = FileOperationsTestSupport.write(
            "pixels", to: root.appendingPathComponent("2024/Paris/IMG_1.dng"))
        FileOperationsTestSupport.write("<xmp/>", to: SidecarPath.sidecarURL(for: source))
        _ = try await LocalFileOperations.trashToMapleFolder(source, libraryRoot: root)

        let items = LocalFileOperations.listMapleTrash(libraryRoot: root)

        XCTAssertEqual(items.count, 1)
        XCTAssertEqual(items[0].originalRelativePath, "2024/Paris/IMG_1.dng")
        XCTAssertEqual(items[0].displayName, "IMG_1.dng")
        XCTAssertNotNil(items[0].sidecarPath)
        XCTAssertNotNil(items[0].trashedDate)
    }

    func testRestoreFromMapleTrashPutsTheItemBackAtItsOriginalRelativeLocation() async throws {
        let source = FileOperationsTestSupport.write(
            "pixels", to: root.appendingPathComponent("2024/Paris/IMG_1.dng"))
        FileOperationsTestSupport.write("<xmp/>", to: SidecarPath.sidecarURL(for: source))
        let trashed = try await LocalFileOperations.trashToMapleFolder(source, libraryRoot: root)

        let restored = try await LocalFileOperations.restoreFromMapleTrash(
            URL(fileURLWithPath: trashed.primaryPath), libraryRoot: root)

        XCTAssertEqual(restored.primaryPath, source.path)
        XCTAssertTrue(FileOperationsTestSupport.exists(source))
        XCTAssertTrue(restored.sidecarFollowed)
        // The marker is cleaned up on restore — nothing left behind in trash.
        XCTAssertEqual(LocalFileOperations.listMapleTrash(libraryRoot: root).count, 0)
    }

    func testRestoreFromMapleTrashAutoSuffixesOnCollisionAtTheOriginalLocation() async throws {
        let first = FileOperationsTestSupport.write("first", to: root.appendingPathComponent("IMG_1.dng"))
        let trashedFirst = try await LocalFileOperations.trashToMapleFolder(first, libraryRoot: root)
        // Something new now occupies the original spot.
        _ = FileOperationsTestSupport.write("second", to: root.appendingPathComponent("IMG_1.dng"))

        let restored = try await LocalFileOperations.restoreFromMapleTrash(
            URL(fileURLWithPath: trashedFirst.primaryPath), libraryRoot: root)

        XCTAssertTrue(restored.renamedDueToCollision)
        XCTAssertEqual(URL(fileURLWithPath: restored.primaryPath).lastPathComponent, "IMG_1.1.dng")
        // The pre-existing occupant is untouched.
        XCTAssertEqual(FileOperationsTestSupport.contents(root.appendingPathComponent("IMG_1.dng")), "second")
    }

    func testPermanentlyDeleteFromMapleTrashRemovesPrimarySidecarAndMarker() async throws {
        let source = FileOperationsTestSupport.write("pixels", to: root.appendingPathComponent("IMG_1.dng"))
        FileOperationsTestSupport.write("<xmp/>", to: SidecarPath.sidecarURL(for: source))
        _ = try await LocalFileOperations.trashToMapleFolder(source, libraryRoot: root)
        let item = LocalFileOperations.listMapleTrash(libraryRoot: root)[0]

        try LocalFileOperations.permanentlyDeleteFromMapleTrash(item, libraryRoot: root)

        XCTAssertFalse(FileManager.default.fileExists(atPath: item.primaryPath))
        XCTAssertEqual(LocalFileOperations.listMapleTrash(libraryRoot: root).count, 0)
    }

    /// Review finding — the ONE irreversible primitive in this module must
    /// not trust a caller-supplied `TrashedItem` blindly. A path outside
    /// `.maple/trash` (e.g. a live photo the caller mistakenly wrapped in a
    /// `TrashedItem`) must be refused, not deleted.
    func testPermanentlyDeleteFromMapleTrashRefusesAPathOutsideMapleTrash() throws {
        let live = FileOperationsTestSupport.write("still here", to: root.appendingPathComponent("LIVE.dng"))
        let bogusItem = TrashedItem(
            id: live.path, primaryPath: live.path, sidecarPath: nil,
            originalRelativePath: "LIVE.dng", trashedDate: Date(), size: 10)

        XCTAssertThrowsError(try LocalFileOperations.permanentlyDeleteFromMapleTrash(bogusItem, libraryRoot: root)) { error in
            guard case FileOperationError.invalidDestination = error else {
                XCTFail("expected .invalidDestination, got \(error)")
                return
            }
        }
        XCTAssertTrue(FileOperationsTestSupport.exists(live), "the live file must be untouched")
    }

    func testSweepOrphanedMarkersRemovesAMarkerWhosePrimaryIsGone() async throws {
        let source = FileOperationsTestSupport.write("pixels", to: root.appendingPathComponent("IMG_1.dng"))
        let outcome = try await LocalFileOperations.trashToMapleFolder(source, libraryRoot: root)
        // Simulate the primary vanishing out from under its marker (e.g. an
        // external tool removed it) without going through this module.
        try FileManager.default.removeItem(atPath: outcome.primaryPath)
        XCTAssertNotNil(LocalFileOperations.trashedDate(forItemAt: URL(fileURLWithPath: outcome.primaryPath)),
                        "the orphaned marker should still exist before the sweep")

        let removed = LocalFileOperations.sweepOrphanedMarkers(libraryRoot: root)

        XCTAssertEqual(removed, 1)
        XCTAssertNil(LocalFileOperations.trashedDate(forItemAt: URL(fileURLWithPath: outcome.primaryPath)))
    }

    func testSweepExpiredMapleTrashDoesNotPurgeAnItemExactlyAtTheThreshold() async throws {
        // A day-to-day comparison biased toward retaining longer: an item
        // trashed EXACTLY 30 days ago (to the same time of day) must not be
        // purged by a 30-day policy — only day 31+ qualifies.
        let source = FileOperationsTestSupport.write("pixels", to: root.appendingPathComponent("IMG_1.dng"))
        let outcome = try await LocalFileOperations.trashToMapleFolder(source, libraryRoot: root)
        LocalFileOperations.removeTrashedMarker(forItemAt: URL(fileURLWithPath: outcome.primaryPath))
        let now = Date()
        LocalFileOperations.writeTrashedMarker(
            forItemAt: URL(fileURLWithPath: outcome.primaryPath), date: now.addingTimeInterval(-30 * 86_400))

        let purged = LocalFileOperations.sweepExpiredMapleTrash(libraryRoot: root, olderThanDays: 30, now: now)

        XCTAssertEqual(purged, 0)
        XCTAssertEqual(LocalFileOperations.listMapleTrash(libraryRoot: root).count, 1)
    }

    func testSweepExpiredMapleTrashPurgesOnlyItemsOlderThanTheThreshold() async throws {
        let old = FileOperationsTestSupport.write("old", to: root.appendingPathComponent("OLD.dng"))
        let oldOutcome = try await LocalFileOperations.trashToMapleFolder(old, libraryRoot: root)
        let recent = FileOperationsTestSupport.write("recent", to: root.appendingPathComponent("RECENT.dng"))
        _ = try await LocalFileOperations.trashToMapleFolder(recent, libraryRoot: root)

        // Back-date the OLD item's marker by re-writing it at a 40-day-old date.
        LocalFileOperations.removeTrashedMarker(forItemAt: URL(fileURLWithPath: oldOutcome.primaryPath))
        LocalFileOperations.writeTrashedMarker(
            forItemAt: URL(fileURLWithPath: oldOutcome.primaryPath),
            date: Date().addingTimeInterval(-40 * 86_400))

        let purged = LocalFileOperations.sweepExpiredMapleTrash(libraryRoot: root, olderThanDays: 30)

        XCTAssertEqual(purged, 1)
        let remaining = LocalFileOperations.listMapleTrash(libraryRoot: root)
        XCTAssertEqual(remaining.count, 1)
        XCTAssertEqual(remaining[0].displayName, "RECENT.dng")
    }

    func testSweepExpiredMapleTrashNeverPurgesAnItemWithNoMarker() async throws {
        // A "legacy" trashed item — moved directly, bypassing the marker
        // write, simulating one trashed before this scheme existed.
        let trashDir = try LocalFileOperations.trashDestinationDir(for: root.appendingPathComponent("IMG_1.dng"), libraryRoot: root)
        FileOperationsTestSupport.write("pixels", to: trashDir.appendingPathComponent("IMG_1.dng"))

        let purged = LocalFileOperations.sweepExpiredMapleTrash(libraryRoot: root, olderThanDays: 0)

        XCTAssertEqual(purged, 0)
        XCTAssertEqual(LocalFileOperations.listMapleTrash(libraryRoot: root).count, 1)
    }

    // MARK: - Real OS Trash (macOS only)

    #if os(macOS)
    /// This exercises the ACTUAL `FileManager.trashItem` call against the
    /// real system Trash — the acceptance criterion is literally "uses the
    /// real OS Trash," which isn't provable any other way. The trashed
    /// artifact (a throwaway temp-dir fixture) is permanently deleted again
    /// immediately after the assertions so the test doesn't leave residue
    /// in the user's actual Trash.
    func testTrashToOSTrashMovesTheFileAndItsSidecarToTheRealTrash() async throws {
        let source = FileOperationsTestSupport.write("pixels", to: root.appendingPathComponent("IMG_1.dng"))
        let sidecarURL = SidecarPath.sidecarURL(for: source)
        FileOperationsTestSupport.write("<xmp/>", to: sidecarURL)

        let outcome = try await LocalFileOperations.trashToOSTrash(source)
        defer {
            try? FileManager.default.removeItem(atPath: outcome.primaryPath)
            if let sidecarPath = outcome.sidecarPath {
                try? FileManager.default.removeItem(atPath: sidecarPath)
            }
        }

        XCTAssertFalse(FileOperationsTestSupport.exists(source))
        XCTAssertFalse(FileOperationsTestSupport.exists(sidecarURL))
        XCTAssertTrue(FileManager.default.fileExists(atPath: outcome.primaryPath),
                      "the OS decides the exact trashed name/path — it must exist somewhere")
        XCTAssertTrue(outcome.sidecarFollowed)
    }
    #endif
}
