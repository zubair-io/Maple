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

    // MARK: - Real OS Trash (macOS only)

    #if os(macOS)
    /// This exercises the ACTUAL `FileManager.trashItem` call against the
    /// real system Trash — the acceptance criterion is literally "uses the
    /// real OS Trash," which isn't provable any other way. The trashed
    /// artifact (a throwaway temp-dir fixture) is permanently deleted again
    /// immediately after the assertions so the test doesn't leave residue
    /// in the user's actual Trash.
    func testTrashToOSTrashMovesTheFileAndItsSidecarToTheRealTrash() throws {
        let source = FileOperationsTestSupport.write("pixels", to: root.appendingPathComponent("IMG_1.dng"))
        let sidecarURL = SidecarPath.sidecarURL(for: source)
        FileOperationsTestSupport.write("<xmp/>", to: sidecarURL)

        let outcome = try LocalFileOperations.trashToOSTrash(source)
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
