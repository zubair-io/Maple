// FolderMoveDestinationsTests.swift — the destination tree behind the
// sidebar's "Move Folder to…" picker (#2847). Real temp directories for the
// local walk (no mocks, per convention); the in-memory `FakeSMBTransport`
// for the SMB walk, the same seam every other `SMBFileOperations` test uses.

import XCTest
@testable import MapleCore

final class FolderMoveDestinationsTests: XCTestCase {
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

    private func makeDirs(_ relativePaths: String...) {
        for rel in relativePaths {
            try! FileManager.default.createDirectory(
                at: root.appendingPathComponent(rel), withIntermediateDirectories: true)
        }
    }

    // MARK: - Local

    func testLocalTreeIsPreOrderWithDepthsAndParentIDs() {
        makeDirs("2024/Paris", "2024/Tokyo", "2025")
        let moving = root.appendingPathComponent("Loose")
        makeDirs("Loose")

        let tree = FolderMoveDestinations.localTree(root: root, rootName: "Library", excluding: moving)

        let rootID = root.standardizedFileURL.path
        XCTAssertEqual(tree.map(\.name), ["Library", "2024", "Paris", "Tokyo", "2025"])
        XCTAssertEqual(tree.map(\.depth), [0, 1, 2, 2, 1])
        XCTAssertEqual(tree[0].id, rootID)
        XCTAssertNil(tree[0].parentID)
        XCTAssertEqual(tree[1].parentID, rootID)
        XCTAssertEqual(tree[2].parentID, tree[1].id)
        XCTAssertEqual(tree[2].id, root.appendingPathComponent("2024/Paris").standardizedFileURL.path)
        XCTAssertEqual(tree.map(\.hasChildren), [true, true, false, false, false])
    }

    /// The moving folder can't land inside itself — its whole subtree is
    /// absent, and its parent's `hasChildren` reflects that absence.
    func testLocalTreeExcludesTheMovingFoldersOwnSubtree() {
        makeDirs("Trips/Iceland/Day1", "Trips/Iceland/Day2", "Trips/Norway")
        let moving = root.appendingPathComponent("Trips/Iceland")

        let tree = FolderMoveDestinations.localTree(root: root, rootName: "Library", excluding: moving)

        XCTAssertEqual(tree.map(\.name), ["Library", "Trips", "Norway"])
        XCTAssertFalse(tree.contains { $0.name == "Day1" || $0.name == "Day2" })
    }

    func testLocalTreeParentOfAnOnlyChildBecomesALeafWhenThatChildIsMoving() throws {
        makeDirs("Trips/Iceland")
        let moving = root.appendingPathComponent("Trips/Iceland")

        let tree = FolderMoveDestinations.localTree(root: root, rootName: "Library", excluding: moving)

        let trips = try XCTUnwrap(tree.first { $0.name == "Trips" })
        XCTAssertFalse(trips.hasChildren)
    }

    /// `.maple` (derivative cache + trash) and every other dot-directory
    /// are internal, never a destination — same filter the sidebar tree
    /// applies (`FolderTreeRow.enumerateChildren`).
    func testLocalTreeSkipsMapleAndOtherDotDirectories() {
        makeDirs(".maple/trash", ".maple/thumbs", ".hidden", "Album")
        FileOperationsTestSupport.write("x", to: root.appendingPathComponent("Album/IMG_1.dng"))

        let tree = FolderMoveDestinations.localTree(
            root: root, rootName: "Library", excluding: root.appendingPathComponent("Elsewhere"))

        XCTAssertEqual(tree.map(\.name), ["Library", "Album"])
        XCTAssertFalse(tree.contains { $0.id.contains(MapleSidecarPaths.derivativeDirectoryName) })
    }

    func testLocalTreeOnlyListsDirectoriesNeverFiles() {
        makeDirs("Album")
        FileOperationsTestSupport.write("x", to: root.appendingPathComponent("Album/IMG_1.dng"))
        FileOperationsTestSupport.write("x", to: root.appendingPathComponent("stray.dng"))

        let tree = FolderMoveDestinations.localTree(
            root: root, rootName: "Library", excluding: root.appendingPathComponent("Elsewhere"))

        XCTAssertEqual(tree.map(\.name), ["Library", "Album"])
        XCTAssertFalse(tree[1].hasChildren)
    }

    // MARK: - SMB

    func testSMBTreeMirrorsTheLocalShape() async throws {
        let t = FakeSMBTransport()
        await t.seed("a", at: "/2024/Paris/IMG_1.dng")
        await t.seed("b", at: "/2024/Tokyo/IMG_2.dng")
        await t.seed("c", at: "/2025/IMG_3.dng")
        try await t.createDirectory(atPath: "/.maple/trash")

        let tree = try await FolderMoveDestinations.smbTree(
            rootName: "nas / photos", excluding: "/Loose", transport: t)

        XCTAssertEqual(tree.map(\.name), ["nas / photos", "2024", "Paris", "Tokyo", "2025"])
        XCTAssertEqual(tree.map(\.id), ["/", "/2024", "/2024/Paris", "/2024/Tokyo", "/2025"])
        XCTAssertEqual(tree.map(\.depth), [0, 1, 2, 2, 1])
        XCTAssertEqual(tree[2].parentID, "/2024")
        XCTAssertNil(tree[0].parentID)
        XCTAssertEqual(tree.map(\.hasChildren), [true, true, false, false, false])
    }

    func testSMBTreeExcludesTheMovingFoldersOwnSubtree() async throws {
        let t = FakeSMBTransport()
        await t.seed("a", at: "/Trips/Iceland/Day1/IMG_1.dng")
        await t.seed("b", at: "/Trips/Norway/IMG_2.dng")

        let tree = try await FolderMoveDestinations.smbTree(
            rootName: "nas / photos", excluding: "/Trips/Iceland", transport: t)

        XCTAssertEqual(tree.map(\.id), ["/", "/Trips", "/Trips/Norway"])
    }

    // MARK: - Cancellation (the picker's "Finding folders…" Cancel)

    /// A cancelled walk returns nothing rather than finishing the listing —
    /// the task cancels itself before the walk starts so the outcome doesn't
    /// depend on scheduling.
    func testLocalTreeStopsWhenItsTaskIsCancelled() async {
        makeDirs("2024/Paris", "2025")
        let root = root!
        let moving = root.appendingPathComponent("Loose")

        let tree = await Task.detached {
            withUnsafeCurrentTask { $0?.cancel() }
            return FolderMoveDestinations.localTree(root: root, rootName: "Library", excluding: moving)
        }.value

        XCTAssertEqual(tree, [])
    }

    func testSMBTreeThrowsCancellationWhenItsTaskIsCancelled() async throws {
        let t = FakeSMBTransport()
        await t.seed("a", at: "/2024/Paris/IMG_1.dng")

        let failure: Error? = await Task.detached {
            withUnsafeCurrentTask { $0?.cancel() }
            do {
                _ = try await FolderMoveDestinations.smbTree(
                    rootName: "nas / photos", excluding: "/Loose", transport: t)
                return nil
            } catch {
                return error
            }
        }.value

        XCTAssertTrue(failure is CancellationError, "expected CancellationError, got \(String(describing: failure))")
    }
}
