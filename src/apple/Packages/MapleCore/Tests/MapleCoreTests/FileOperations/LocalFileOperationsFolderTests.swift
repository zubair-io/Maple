// LocalFileOperationsFolderTests.swift — folder CRUD for the local
// Filesystem source (issue #2631): create, rename, move (with a
// self-subtree guard), and recursive delete-to-trash.

import XCTest
@testable import MapleCore

final class LocalFileOperationsFolderTests: XCTestCase {
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

    func testCreateFolderMakesTheDirectory() throws {
        let created = try LocalFileOperations.createFolder(named: "Album", in: root)
        var isDir: ObjCBool = false
        XCTAssertTrue(FileManager.default.fileExists(atPath: created.path, isDirectory: &isDir))
        XCTAssertTrue(isDir.boolValue)
    }

    func testCreateFolderFailsOnCollisionRatherThanSuffixing() throws {
        _ = try LocalFileOperations.createFolder(named: "Album", in: root)
        XCTAssertThrowsError(try LocalFileOperations.createFolder(named: "Album", in: root)) { error in
            guard case FileOperationError.destinationExists = error else {
                return XCTFail("expected .destinationExists, got \(error)")
            }
        }
    }

    func testRenameFolderMovesItsContentsAlong() throws {
        let folder = try LocalFileOperations.createFolder(named: "Old", in: root)
        FileOperationsTestSupport.write("pixels", to: folder.appendingPathComponent("IMG_1.dng"))

        let renamed = try LocalFileOperations.renameFolder(folder, to: "New")

        XCTAssertFalse(FileOperationsTestSupport.exists(folder))
        XCTAssertEqual(FileOperationsTestSupport.contents(renamed.appendingPathComponent("IMG_1.dng")), "pixels")
    }

    func testMoveFolderIntoAnotherDirectory() throws {
        let folder = try LocalFileOperations.createFolder(named: "Album", in: root)
        let newParent = try LocalFileOperations.createFolder(named: "Archive", in: root)

        let moved = try LocalFileOperations.moveFolder(folder, into: newParent)

        XCTAssertEqual(moved.path, newParent.appendingPathComponent("Album").path)
        XCTAssertFalse(FileOperationsTestSupport.exists(folder))
    }

    func testMoveFolderRefusesToMoveIntoItsOwnSubtree() throws {
        let folder = try LocalFileOperations.createFolder(named: "Album", in: root)
        let child = try LocalFileOperations.createFolder(named: "Sub", in: folder)

        XCTAssertThrowsError(try LocalFileOperations.moveFolder(folder, into: child)) { error in
            guard case FileOperationError.invalidDestination = error else {
                return XCTFail("expected .invalidDestination, got \(error)")
            }
        }
        XCTAssertTrue(FileOperationsTestSupport.exists(folder), "a rejected move must not touch the folder")
    }

    func testMoveFolderRefusesToOverwriteAnExistingItem() throws {
        let folder = try LocalFileOperations.createFolder(named: "Album", in: root)
        let newParent = try LocalFileOperations.createFolder(named: "Archive", in: root)
        _ = try LocalFileOperations.createFolder(named: "Album", in: newParent)  // occupant

        XCTAssertThrowsError(try LocalFileOperations.moveFolder(folder, into: newParent)) { error in
            guard case FileOperationError.destinationExists = error else {
                return XCTFail("expected .destinationExists, got \(error)")
            }
        }
    }

    // MARK: - Recursive delete-to-trash (`.maple/trash` fallback — no `#if os` gate)

    func testDeleteFolderToMapleFolderPreservesTheWholeSubtree() throws {
        let folder = try LocalFileOperations.createFolder(named: "2024", in: root)
        FileOperationsTestSupport.write("a", to: folder.appendingPathComponent("Paris/IMG_1.dng"))
        FileOperationsTestSupport.write("b", to: folder.appendingPathComponent("Paris/IMG_2.dng"))

        let trashed = try LocalFileOperations.trashFolderToMapleFolder(folder, libraryRoot: root)

        XCTAssertFalse(FileOperationsTestSupport.exists(folder))
        XCTAssertEqual(trashed.path, root.appendingPathComponent(".maple/trash/2024").path)
        XCTAssertEqual(FileOperationsTestSupport.contents(trashed.appendingPathComponent("Paris/IMG_1.dng")), "a")
        XCTAssertEqual(FileOperationsTestSupport.contents(trashed.appendingPathComponent("Paris/IMG_2.dng")), "b")
    }

    func testDeleteFolderToMapleFolderSuffixesOnRepeatedDelete() throws {
        let first = try LocalFileOperations.createFolder(named: "Album", in: root)
        _ = try LocalFileOperations.trashFolderToMapleFolder(first, libraryRoot: root)

        let second = try LocalFileOperations.createFolder(named: "Album", in: root)
        let trashed = try LocalFileOperations.trashFolderToMapleFolder(second, libraryRoot: root)

        XCTAssertEqual(trashed.lastPathComponent, "Album.1")
    }

    // MARK: - Name validation (#2645 review — traversal via an unvalidated
    // New Folder / Rename name). `appendingPathComponent` splits on an
    // embedded `/`, so an unvalidated name could create a directory outside
    // the intended parent, bounded only by the OS-level reach of whatever
    // security-scoped bookmark was in effect. These use real temp
    // directories (not mocks — CLAUDE.md's "no mocks" note is specifically
    // about the sidecar layer, but a real filesystem is the honest way to
    // prove nothing escaped `root` regardless).

    func testCreateFolderRefusesATraversalName() throws {
        XCTAssertThrowsError(try LocalFileOperations.createFolder(named: "../x", in: root)) { error in
            guard case FileOperationError.invalidName = error else {
                return XCTFail("expected .invalidName, got \(error)")
            }
        }
        XCTAssertFalse(FileOperationsTestSupport.exists(root.deletingLastPathComponent().appendingPathComponent("x")),
                       "must not have created anything outside root")
    }

    func testCreateFolderRefusesAnEmbeddedSeparator() throws {
        XCTAssertThrowsError(try LocalFileOperations.createFolder(named: "a/b", in: root)) { error in
            guard case FileOperationError.invalidName = error else {
                return XCTFail("expected .invalidName, got \(error)")
            }
        }
        XCTAssertFalse(FileOperationsTestSupport.exists(root.appendingPathComponent("a")))
    }

    func testCreateFolderRefusesDotAndDotDot() throws {
        for name in [".", ".."] {
            XCTAssertThrowsError(try LocalFileOperations.createFolder(named: name, in: root)) { error in
                guard case FileOperationError.invalidName = error else {
                    return XCTFail("expected .invalidName for \(name), got \(error)")
                }
            }
        }
    }

    func testRenameFolderRefusesATraversalName() throws {
        let folder = try LocalFileOperations.createFolder(named: "Album", in: root)
        XCTAssertThrowsError(try LocalFileOperations.renameFolder(folder, to: "../escaped")) { error in
            guard case FileOperationError.invalidName = error else {
                return XCTFail("expected .invalidName, got \(error)")
            }
        }
        XCTAssertTrue(FileOperationsTestSupport.exists(folder), "a rejected rename must not touch the folder")
        XCTAssertFalse(FileOperationsTestSupport.exists(root.deletingLastPathComponent().appendingPathComponent("escaped")))
    }

    func testMoveFolderRefusesAnEmbeddedSeparatorInNewName() throws {
        let folder = try LocalFileOperations.createFolder(named: "Album", in: root)
        let newParent = try LocalFileOperations.createFolder(named: "Archive", in: root)
        XCTAssertThrowsError(try LocalFileOperations.moveFolder(folder, into: newParent, newName: "a/b")) { error in
            guard case FileOperationError.invalidName = error else {
                return XCTFail("expected .invalidName, got \(error)")
            }
        }
    }
}
