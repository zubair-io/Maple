// LocalFileOperationsExternalRenameTests.swift — issue #2656: applying ONE
// confirmed external-rename match. Real temp-dir `.xmp` round trips — no
// mocks, per CLAUDE.md's sidecar-layer rule.

import XCTest
@testable import MapleCore

final class LocalFileOperationsExternalRenameTests: XCTestCase {
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

    func testAppliesRenameMovesTheSidecarAndKeepsItsContents() async throws {
        let oldURL = root.appendingPathComponent("IMG_1.dng")
        let newURL = root.appendingPathComponent("IMG_2.dng")
        // Simulate Finder having already renamed the primary externally —
        // this is the state `applyExternalRename` is handed, never a state
        // it creates itself.
        FileOperationsTestSupport.write("pixels", to: newURL)
        FileOperationsTestSupport.write("<xmp edits='real'/>", to: SidecarPath.sidecarURL(for: oldURL))

        let applied = await LocalFileOperations.applyExternalRename(
            oldPrimaryPath: oldURL.path, newPrimaryPath: newURL.path)

        XCTAssertTrue(applied)
        XCTAssertFalse(FileOperationsTestSupport.exists(SidecarPath.sidecarURL(for: oldURL)),
                       "the old sidecar must not be left behind")
        XCTAssertEqual(
            FileOperationsTestSupport.contents(SidecarPath.sidecarURL(for: newURL)),
            "<xmp edits='real'/>",
            "the renamed file's edits must be intact, byte-for-byte")
    }

    func testNoSidecarIsStillAppliedButNothingToMove() async throws {
        let oldURL = root.appendingPathComponent("IMG_1.dng")
        let newURL = root.appendingPathComponent("IMG_2.dng")
        FileOperationsTestSupport.write("pixels", to: newURL)

        let applied = await LocalFileOperations.applyExternalRename(
            oldPrimaryPath: oldURL.path, newPrimaryPath: newURL.path)

        XCTAssertTrue(applied, "a rename with no sidecar to move is still a successfully applied rename")
        XCTAssertFalse(FileOperationsTestSupport.exists(SidecarPath.sidecarURL(for: newURL)))
    }

    func testDeclinesWhenTheNewFileAlreadyOwnsItsOwnSidecar() async throws {
        let oldURL = root.appendingPathComponent("IMG_1.dng")
        let newURL = root.appendingPathComponent("IMG_2.dng")
        FileOperationsTestSupport.write("pixels", to: newURL)
        FileOperationsTestSupport.write("<xmp edits='old'/>", to: SidecarPath.sidecarURL(for: oldURL))
        FileOperationsTestSupport.write("<xmp edits='belongs-to-new-already'/>", to: SidecarPath.sidecarURL(for: newURL))

        let applied = await LocalFileOperations.applyExternalRename(
            oldPrimaryPath: oldURL.path, newPrimaryPath: newURL.path)

        XCTAssertFalse(applied, "must never clobber a sidecar the destination already owns")
        XCTAssertEqual(
            FileOperationsTestSupport.contents(SidecarPath.sidecarURL(for: newURL)),
            "<xmp edits='belongs-to-new-already'/>")
        XCTAssertTrue(FileOperationsTestSupport.exists(SidecarPath.sidecarURL(for: oldURL)),
                      "the old sidecar is left in place when the move is declined")
    }

    func testDeclinesWhenTheOldPrimaryIsStillOnDisk() async throws {
        // A stale/racy match: the "missing" file never actually vanished.
        let oldURL = root.appendingPathComponent("IMG_1.dng")
        let newURL = root.appendingPathComponent("IMG_2.dng")
        FileOperationsTestSupport.write("pixels", to: oldURL)
        FileOperationsTestSupport.write("pixels2", to: newURL)

        let applied = await LocalFileOperations.applyExternalRename(
            oldPrimaryPath: oldURL.path, newPrimaryPath: newURL.path)

        XCTAssertFalse(applied)
    }

    func testDeclinesWhenTheNewPrimaryDoesNotExist() async throws {
        let oldURL = root.appendingPathComponent("IMG_1.dng")
        let newURL = root.appendingPathComponent("IMG_2.dng")
        // Neither file exists — nothing to reconcile.
        let applied = await LocalFileOperations.applyExternalRename(
            oldPrimaryPath: oldURL.path, newPrimaryPath: newURL.path)

        XCTAssertFalse(applied)
    }

    func testAppliesRenameInvalidatesTheOldLocationsDerivedCaches() async throws {
        let oldURL = root.appendingPathComponent("IMG_1.dng")
        let newURL = root.appendingPathComponent("IMG_2.dng")
        FileOperationsTestSupport.write("pixels", to: newURL)
        let oldThumb = MapleSidecarPaths.thumbURL(for: oldURL)
        FileOperationsTestSupport.write("thumb-bytes", to: oldThumb)

        _ = await LocalFileOperations.applyExternalRename(oldPrimaryPath: oldURL.path, newPrimaryPath: newURL.path)

        XCTAssertFalse(FileOperationsTestSupport.exists(oldThumb))
    }

    func testAppliesRenameCarriesCullingToTheNewLibraryIndexEntry() async throws {
        let oldURL = root.appendingPathComponent("IMG_1.dng")
        let newURL = root.appendingPathComponent("IMG_2.dng")
        FileOperationsTestSupport.write("pixels", to: newURL)

        let store = LibraryIndexStore(folderURL: root)
        try await store.updateEntry(name: "IMG_1.dng", culling: CullingState(stars: 4, flag: .pick))

        _ = await LocalFileOperations.applyExternalRename(oldPrimaryPath: oldURL.path, newPrimaryPath: newURL.path)

        let freshStore = LibraryIndexStore(folderURL: root)
        let index = try await freshStore.load()
        XCTAssertNil(index?.entries["IMG_1.dng"], "the stale entry must be removed")
        let newEntry = try XCTUnwrap(index?.entries["IMG_2.dng"])
        XCTAssertEqual(newEntry.stars, 4)
        XCTAssertEqual(newEntry.flag, "pick")
    }
}
