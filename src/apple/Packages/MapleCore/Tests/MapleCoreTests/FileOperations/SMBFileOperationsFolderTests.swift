// SMBFileOperationsFolderTests.swift — folder CRUD + trash for the SMB
// engine (issue #2631), against the in-memory `FakeSMBTransport`.

import XCTest
@testable import MapleCore

final class SMBFileOperationsFolderTests: XCTestCase {

    func testCreateFolderFailsOnCollision() async throws {
        let t = FakeSMBTransport()
        _ = try await SMBFileOperations.createFolder(named: "Album", in: "/", transport: t)

        do {
            _ = try await SMBFileOperations.createFolder(named: "Album", in: "/", transport: t)
            XCTFail("expected destinationExists")
        } catch FileOperationError.destinationExists {
            // expected
        }
    }

    func testRenameFolderMovesItsContentsAlong() async throws {
        let t = FakeSMBTransport()
        await t.seed("pixels", at: "/Old/IMG_1.dng")

        let renamed = try await SMBFileOperations.renameFolder("/Old", to: "New", transport: t)

        XCTAssertEqual(renamed, "/New")
        let oldGone = await !t.fileExists(at: "/Old/IMG_1.dng")
        XCTAssertTrue(oldGone)
        let movedContents = await t.fileContents(at: "/New/IMG_1.dng")
        XCTAssertEqual(movedContents, "pixels")
    }

    func testMoveFolderRefusesToMoveIntoItsOwnSubtree() async throws {
        let t = FakeSMBTransport()
        do {
            _ = try await SMBFileOperations.moveFolder("/Album", into: "/Album/Sub", transport: t)
            XCTFail("expected invalidDestination")
        } catch FileOperationError.invalidDestination {
            // expected
        }
    }

    func testDeleteFolderMovesTheWholeSubtreeIntoMapleTrash() async throws {
        let t = FakeSMBTransport()
        await t.seed("a", at: "/2024/Paris/IMG_1.dng")
        await t.seed("b", at: "/2024/Paris/IMG_2.dng")

        let trashed = try await SMBFileOperations.deleteFolder("/2024", transport: t)

        XCTAssertEqual(trashed, "/.maple/trash/2024")
        let oldGone = await !t.fileExists(at: "/2024/Paris/IMG_1.dng")
        XCTAssertTrue(oldGone)
        let a = await t.fileContents(at: "/.maple/trash/2024/Paris/IMG_1.dng")
        let b = await t.fileContents(at: "/.maple/trash/2024/Paris/IMG_2.dng")
        XCTAssertEqual(a, "a")
        XCTAssertEqual(b, "b")
    }

    func testTrashAssetIntoMapleTrashPreservesRelativeStructure() async throws {
        let t = FakeSMBTransport()
        await t.seed("pixels", at: "/2024/Paris/IMG_1.dng")

        let outcome = try await SMBFileOperations.trash("/2024/Paris/IMG_1.dng", transport: t)

        XCTAssertEqual(outcome.primaryPath, "/.maple/trash/2024/Paris/IMG_1.dng")
        let oldGone = await !t.fileExists(at: "/2024/Paris/IMG_1.dng")
        XCTAssertTrue(oldGone)
    }

    // MARK: - Restore / list / purge (#2653)

    func testListMapleTrashFindsTheTrashedItem() async throws {
        let t = FakeSMBTransport()
        await t.seed("pixels", at: "/2024/Paris/IMG_1.dng")
        _ = try await SMBFileOperations.trash("/2024/Paris/IMG_1.dng", transport: t)

        let items = await SMBFileOperations.listMapleTrash(transport: t)

        XCTAssertEqual(items.count, 1)
        XCTAssertEqual(items[0].originalRelativePath, "2024/Paris/IMG_1.dng")
        XCTAssertNotNil(items[0].trashedDate)
    }

    func testRestoreFromMapleTrashPutsTheItemBackAtItsOriginalLocation() async throws {
        let t = FakeSMBTransport()
        await t.seed("pixels", at: "/2024/Paris/IMG_1.dng")
        let trashed = try await SMBFileOperations.trash("/2024/Paris/IMG_1.dng", transport: t)

        let restored = try await SMBFileOperations.restoreFromMapleTrash(trashed.primaryPath, transport: t)

        XCTAssertEqual(restored.primaryPath, "/2024/Paris/IMG_1.dng")
        let backOnDisk = await t.fileExists(at: "/2024/Paris/IMG_1.dng")
        XCTAssertTrue(backOnDisk)
        let items = await SMBFileOperations.listMapleTrash(transport: t)
        XCTAssertEqual(items.count, 0)
    }

    func testPermanentlyDeleteFromMapleTrashRemovesThePrimary() async throws {
        let t = FakeSMBTransport()
        await t.seed("pixels", at: "/IMG_1.dng")
        _ = try await SMBFileOperations.trash("/IMG_1.dng", transport: t)
        let item = await SMBFileOperations.listMapleTrash(transport: t)[0]

        try await SMBFileOperations.permanentlyDeleteFromMapleTrash(item, transport: t)

        let gone = await !t.fileExists(at: item.primaryPath)
        XCTAssertTrue(gone)
        let items = await SMBFileOperations.listMapleTrash(transport: t)
        XCTAssertEqual(items.count, 0)
    }

    func testSweepExpiredMapleTrashPurgesOnlyItemsOlderThanTheThreshold() async throws {
        let t = FakeSMBTransport()
        await t.seed("old", at: "/OLD.dng")
        let oldOutcome = try await SMBFileOperations.trash("/OLD.dng", transport: t)
        await t.seed("recent", at: "/RECENT.dng")
        _ = try await SMBFileOperations.trash("/RECENT.dng", transport: t)

        // Back-date the OLD item's marker.
        await SMBFileOperations.removeTrashedMarker(forItemAt: oldOutcome.primaryPath, transport: t)
        await SMBFileOperations.writeTrashedMarker(
            forItemAt: oldOutcome.primaryPath, date: Date().addingTimeInterval(-40 * 86_400), transport: t)

        let purged = await SMBFileOperations.sweepExpiredMapleTrash(olderThanDays: 30, transport: t)

        XCTAssertEqual(purged, 1)
        let remaining = await SMBFileOperations.listMapleTrash(transport: t)
        XCTAssertEqual(remaining.count, 1)
        XCTAssertEqual(remaining[0].originalRelativePath, "RECENT.dng")
    }

    // MARK: - Name validation (#2645 review — same traversal guard as the
    // local engine's `LocalFileOperationsFolderTests`, against the fake
    // transport since there's no SMB server in this environment).

    func testCreateFolderRefusesATraversalName() async throws {
        let t = FakeSMBTransport()
        do {
            _ = try await SMBFileOperations.createFolder(named: "../x", in: "/", transport: t)
            XCTFail("expected invalidName")
        } catch FileOperationError.invalidName {
            // expected
        }
        let escaped = await t.fileExists(at: "/../x")
        XCTAssertFalse(escaped)
    }

    func testCreateFolderRefusesAnEmbeddedSeparator() async throws {
        let t = FakeSMBTransport()
        do {
            _ = try await SMBFileOperations.createFolder(named: "a/b", in: "/", transport: t)
            XCTFail("expected invalidName")
        } catch FileOperationError.invalidName {
            // expected
        }
    }

    func testCreateFolderRefusesDotAndDotDot() async throws {
        let t = FakeSMBTransport()
        for name in [".", ".."] {
            do {
                _ = try await SMBFileOperations.createFolder(named: name, in: "/", transport: t)
                XCTFail("expected invalidName for \(name)")
            } catch FileOperationError.invalidName {
                // expected
            }
        }
    }

    func testRenameFolderRefusesATraversalName() async throws {
        let t = FakeSMBTransport()
        await t.seed("pixels", at: "/Album/IMG_1.dng")
        do {
            _ = try await SMBFileOperations.renameFolder("/Album", to: "../escaped", transport: t)
            XCTFail("expected invalidName")
        } catch FileOperationError.invalidName {
            // expected
        }
        let stillThere = await t.fileExists(at: "/Album/IMG_1.dng")
        XCTAssertTrue(stillThere, "a rejected rename must not touch the folder")
    }
}
