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

    // MARK: - Case-only rename (#2656 review — I5)

    func testCaseOnlyRenameMovesTheSidecarInsteadOfBeingMistakenForAStaleMatch() async throws {
        let oldURL = root.appendingPathComponent("IMG_1.dng")
        let newURL = root.appendingPathComponent("img_1.dng")
        FileOperationsTestSupport.write("pixels", to: oldURL)
        FileOperationsTestSupport.write("<xmp edits='real'/>", to: SidecarPath.sidecarURL(for: oldURL))

        // A real case-only rename, exactly what Finder does for "just change
        // the casing" — same inode, new stored casing. On APFS (case-
        // insensitive-but-case-preserving), `fileExists(atPath:)` for
        // EITHER casing now resolves to this same file.
        try FileManager.default.moveItem(at: oldURL, to: newURL)

        let applied = await LocalFileOperations.applyExternalRename(
            oldPrimaryPath: oldURL.path, newPrimaryPath: newURL.path)

        XCTAssertTrue(
            applied,
            "a case-only rename must not be mistaken for a stale match — the plain "
            + "'!fileExists(old) && fileExists(new)' check alone resolves case-insensitively and would wrongly decline this")

        // The stored casing on disk must have actually followed the rename
        // — this is what distinguishes "the fix worked" from "nothing ran
        // but the case-insensitive read happened to still find the old
        // sidecar under its original casing."
        let contents = try FileManager.default.contentsOfDirectory(atPath: root.path)
        XCTAssertTrue(contents.contains("img_1.xmp"), "the sidecar's stored casing must follow the rename")
        XCTAssertFalse(contents.contains("IMG_1.xmp"))
    }

    func testCaseOnlyRenameWithNoSidecarStillApplies() async throws {
        let oldURL = root.appendingPathComponent("IMG_1.dng")
        let newURL = root.appendingPathComponent("img_1.dng")
        FileOperationsTestSupport.write("pixels", to: oldURL)
        try FileManager.default.moveItem(at: oldURL, to: newURL)

        let applied = await LocalFileOperations.applyExternalRename(
            oldPrimaryPath: oldURL.path, newPrimaryPath: newURL.path)

        XCTAssertTrue(applied, "a case-only rename with nothing to move for the sidecar is still a successful apply")
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

    // MARK: - Shared LibraryIndexStore (#2656 review — B4)

    func testUsesTheProvidedLibraryIndexStoreInsteadOfConstructingAFreshOne() async throws {
        let oldURL = root.appendingPathComponent("IMG_1.dng")
        let newURL = root.appendingPathComponent("IMG_2.dng")
        FileOperationsTestSupport.write("pixels", to: newURL)

        let sharedStore = LibraryIndexStore(folderURL: root)
        try await sharedStore.updateEntry(name: "IMG_1.dng", culling: CullingState(stars: 5, flag: .pick))

        let applied = await LocalFileOperations.applyExternalRename(
            oldPrimaryPath: oldURL.path, newPrimaryPath: newURL.path, libraryIndexStore: sharedStore)

        XCTAssertTrue(applied)
        // Read back through the SAME instance the caller passed in — proves
        // the write actually went through it rather than a fresh, separate
        // `LibraryIndexStore` racing the same `index.json`.
        let index = try await sharedStore.load()
        XCTAssertNil(index?.entries["IMG_1.dng"])
        let entry = try XCTUnwrap(index?.entries["IMG_2.dng"])
        XCTAssertEqual(entry.stars, 5)
        XCTAssertEqual(entry.flag, "pick")
    }
}
