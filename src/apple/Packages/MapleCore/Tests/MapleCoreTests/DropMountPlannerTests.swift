// DropMountPlannerTests.swift — #2649: OS file/folder drop-to-mount routing.
//
// Real temp directories with real files, no mocks (CLAUDE.md convention) —
// the planner's `isDirectory` probe defaults to a real `URL.resourceValues`
// check, so building genuine files/folders on disk exercises the exact
// code path `AppShell+FolderDrop.swift` runs in production, not a stand-in.

import XCTest
@testable import MapleCore

final class DropMountPlannerTests: XCTestCase {

    private var tmpDir: URL!

    override func setUpWithError() throws {
        tmpDir = FileManager.default.temporaryDirectory
            .appendingPathComponent("drop-mount-planner-tests-\(UUID().uuidString)")
        try FileManager.default.createDirectory(at: tmpDir, withIntermediateDirectories: true)
    }

    override func tearDownWithError() throws {
        try? FileManager.default.removeItem(at: tmpDir)
    }

    private func makeFile(_ relativePath: String, in dir: URL? = nil) throws -> URL {
        let url = (dir ?? tmpDir).appendingPathComponent(relativePath)
        try Data("x".utf8).write(to: url)
        return url
    }

    private func makeFolder(_ relativePath: String, in dir: URL? = nil) throws -> URL {
        let url = (dir ?? tmpDir).appendingPathComponent(relativePath)
        try FileManager.default.createDirectory(at: url, withIntermediateDirectories: true)
        return url
    }

    // MARK: - Single file → mount parent, open

    func testSingleFileMountsParentAndOpensIt() throws {
        let folder = try makeFolder("Shoot")
        let file = try makeFile("IMG_0001.dng", in: folder)

        let plan = DropMountPlanner.plan(for: [file], mountedRoots: [])

        XCTAssertEqual(plan, .openFile(file: file.standardizedFileURL, parentFolder: folder.standardizedFileURL))
    }

    // MARK: - Folder → mount it, land in Browse

    func testSingleFolderMountsDirectly() throws {
        let folder = try makeFolder("Shoot")

        let plan = DropMountPlanner.plan(for: [folder], mountedRoots: [])

        // The planner passes a dropped folder straight through — it doesn't
        // re-derive it via `.standardizedFileURL` (which, for a URL that's a
        // real existing directory, normalizes in a trailing "/" that the
        // untouched input URL doesn't carry), so compare against the raw
        // input rather than a standardized copy of it.
        XCTAssertEqual(plan, .mountFolder(folder))
    }

    // MARK: - Multiple loose files → mount common parent, select them

    func testMultipleLooseFilesMountCommonParentAndSelect() throws {
        let folder = try makeFolder("Shoot")
        let fileA = try makeFile("IMG_0001.dng", in: folder)
        let fileB = try makeFile("IMG_0002.dng", in: folder)

        let plan = DropMountPlanner.plan(for: [fileA, fileB], mountedRoots: [])

        guard case .mountAndSelect(let parentFolder, let files) = plan else {
            return XCTFail("expected mountAndSelect, got \(plan)")
        }
        XCTAssertEqual(parentFolder, folder.standardizedFileURL)
        XCTAssertEqual(Set(files), Set([fileA.standardizedFileURL, fileB.standardizedFileURL]))
    }

    func testLooseFilesInDifferentSubfoldersMountDeepestCommonAncestor() throws {
        let root = try makeFolder("Trip")
        let dayOne = try makeFolder("Day1", in: root)
        let dayTwo = try makeFolder("Day2", in: root)
        let fileA = try makeFile("a.dng", in: dayOne)
        let fileB = try makeFile("b.dng", in: dayTwo)

        let plan = DropMountPlanner.plan(for: [fileA, fileB], mountedRoots: [])

        guard case .mountAndSelect(let parentFolder, _) = plan else {
            return XCTFail("expected mountAndSelect, got \(plan)")
        }
        XCTAssertEqual(parentFolder, root.standardizedFileURL)
    }

    // MARK: - Already inside a mounted source → navigate/select, no remount

    func testFileInsideMountedRootNavigatesWithoutRemount() throws {
        let root = try makeFolder("Library")
        let file = try makeFile("a.dng", in: root)

        let plan = DropMountPlanner.plan(for: [file], mountedRoots: [root])

        // As above: the returned root is the raw entry from `mountedRoots`,
        // not a `.standardizedFileURL`-normalized copy.
        XCTAssertEqual(plan, .navigateExisting(root: root, items: [file]))
    }

    func testFolderEqualToMountedRootNavigatesWithoutRemount() throws {
        let root = try makeFolder("Library")

        let plan = DropMountPlanner.plan(for: [root], mountedRoots: [root])

        XCTAssertEqual(plan, .navigateExisting(root: root, items: [root]))
    }

    func testFileUnderDeeplyNestedMountedRootNavigates() throws {
        let root = try makeFolder("Library")
        let sub = try makeFolder("2026/08", in: root)
        let file = try makeFile("a.dng", in: sub)

        let plan = DropMountPlanner.plan(for: [file], mountedRoots: [root])

        XCTAssertEqual(plan, .navigateExisting(root: root, items: [file]))
    }

    /// Regression guard: a sibling folder that merely SHARES A PREFIX with a
    /// mounted root ("/Library" vs "/LibraryOld") must NOT be treated as
    /// already-mounted — a naive `hasPrefix` string check would get this
    /// wrong (see `URL.isDescendant(ofOrEqualTo:)`'s doc comment).
    func testSiblingWithSharedPrefixDoesNotCountAsMounted() throws {
        let root = try makeFolder("Library")
        let siblingFile = try makeFile("a.dng", in: try makeFolder("LibraryOld"))

        let plan = DropMountPlanner.plan(for: [siblingFile], mountedRoots: [root])

        XCTAssertNotEqual(plan, .navigateExisting(root: root.standardizedFileURL, items: [siblingFile]))
        XCTAssertEqual(plan, .openFile(file: siblingFile.standardizedFileURL,
                                        parentFolder: siblingFile.deletingLastPathComponent().standardizedFileURL))
    }

    // MARK: - Unsupported

    func testUnsupportedExtensionReportsWhy() throws {
        let file = try makeFile("notes.txt")

        let plan = DropMountPlanner.plan(for: [file], mountedRoots: [])

        XCTAssertEqual(plan, .unsupported(extensions: ["txt"]))
    }

    func testMixOfSupportedAndUnsupportedKeepsOnlySupported() throws {
        let folder = try makeFolder("Shoot")
        let raw = try makeFile("IMG_0001.dng", in: folder)
        _ = try makeFile("readme.txt", in: folder)

        let plan = DropMountPlanner.plan(for: [raw], mountedRoots: [])

        XCTAssertEqual(plan, .openFile(file: raw.standardizedFileURL, parentFolder: folder.standardizedFileURL))
    }

    /// A file with NO extension at all has `pathExtension == ""`, which
    /// would otherwise render the `unsupportedDropType` banner as
    /// "Maple can't open . Drop a…" — an empty string standing in for
    /// the extension reads as a rendering bug, not a real answer to "what
    /// did you drop." Mapped to a descriptive token instead.
    func testUnsupportedExtensionlessFileReportsDescriptiveToken() throws {
        let file = try makeFile("README")

        let plan = DropMountPlanner.plan(for: [file], mountedRoots: [])

        XCTAssertEqual(plan, .unsupported(extensions: ["file without an extension"]))
    }

    func testEmptyDropIsUnsupported() {
        let plan = DropMountPlanner.plan(for: [], mountedRoots: [])
        XCTAssertEqual(plan, .unsupported(extensions: []))
    }

    // MARK: - B2 (#2649 review): folder + its own descendant collapses to the folder

    /// Dropping a folder together with a file INSIDE it (both selected in
    /// Finder, dragged as one gesture) must land on `.mountFolder(folder)`
    /// — not the general common-parent path, which would compute the
    /// folder's OWN parent (a level too high, and never scoped for a
    /// sandboxed read since Finder only grants scope to the exact items
    /// dragged).
    func testFolderPlusFileInsideItCollapsesToFolder() throws {
        let folder = try makeFolder("Shoot")
        let fileInsideFolder = try makeFile("IMG_0001.dng", in: folder)

        let plan = DropMountPlanner.plan(for: [folder, fileInsideFolder], mountedRoots: [])

        XCTAssertEqual(plan, .mountFolder(folder))
    }

    /// Same collapse, one level deeper: a folder dropped together with its
    /// own SUBFOLDER.
    func testFolderPlusOwnSubfolderCollapsesToOuterFolder() throws {
        let outer = try makeFolder("Trip")
        let inner = try makeFolder("Day1", in: outer)

        let plan = DropMountPlanner.plan(for: [outer, inner], mountedRoots: [])

        XCTAssertEqual(plan, .mountFolder(outer))
    }

    /// The collapse also applies when checking "already mounted" — a
    /// folder plus a file inside it, both under a mounted root, should
    /// still navigate/select without the descendant polluting `items`
    /// beyond what a plain folder drop would carry.
    func testFolderPlusFileInsideItUnderMountedRootCollapses() throws {
        let root = try makeFolder("Library")
        let subfolder = try makeFolder("Sub", in: root)
        let fileInSubfolder = try makeFile("a.dng", in: subfolder)

        let plan = DropMountPlanner.plan(for: [subfolder, fileInSubfolder], mountedRoots: [root])

        XCTAssertEqual(plan, .navigateExisting(root: root, items: [subfolder]))
    }

    /// B2 re-review (PR #2756): two spellings of the exact same APFS entry
    /// — `/tmp/a` and `/tmp/A` — must NOT mutually eliminate. Before the
    /// fix, `reduceToTopLevel` compared "is this a genuinely different
    /// item" with case-SENSITIVE `!=` while comparing "is it inside the
    /// other" with case-INSENSITIVE `isDescendant` — so each variant
    /// counted as both "a different item" AND "a descendant of the other,"
    /// and BOTH got dropped as redundant, leaving an empty list that
    /// resolves to a spurious `.unsupported`. Injects `isDirectory` (no
    /// real filesystem entry needed) since the point under test is the
    /// dedupe/collapse logic itself, not directory detection.
    func testCaseVariantDuplicatePairDoesNotMutuallyEliminate() {
        let lowercase = URL(fileURLWithPath: "/tmp/MapleDropDuplicateTest/a")
        let uppercase = URL(fileURLWithPath: "/tmp/MapleDropDuplicateTest/A")

        let plan = DropMountPlanner.plan(
            for: [lowercase, uppercase],
            mountedRoots: [],
            isDirectory: { _ in true }
        )

        XCTAssertNotEqual(plan, .unsupported(extensions: []))
        guard case .mountFolder(let folder) = plan else {
            return XCTFail("expected mountFolder, got \(plan)")
        }
        XCTAssertTrue(
            folder.path.caseInsensitiveCompare(lowercase.path) == .orderedSame,
            "expected the surviving entry to be one of the two case-variant spellings, got \(folder.path)"
        )
    }

    // MARK: - N2 (#2649 review): two folders, no files — documents intended selection behavior

    /// Two folders dropped together (no loose files) fall through to the
    /// general common-parent path (neither the single-folder direct-mount
    /// shortcut nor an ancestor/descendant relationship applies to either
    /// other), landing on `.mountAndSelect` with both folder URLs as the
    /// "selection." This is intentional, documented degradation — folders
    /// never appear in `browseVM.assets` (only files do), so
    /// `AppShell+FolderDrop.selectDroppedFiles` silently matches nothing
    /// for either entry; the caller still mounts the common parent and
    /// lands in Browse showing both as sub-folder tiles, just without a
    /// selection highlight. Not a bug — the ticket only specifies selection
    /// behavior for loose FILES, not folders.
    func testTwoSiblingFoldersNoFilesMountsCommonParentWithFoldersAsSelection() throws {
        let root = try makeFolder("Trip")
        let dayOne = try makeFolder("Day1", in: root)
        let dayTwo = try makeFolder("Day2", in: root)

        let plan = DropMountPlanner.plan(for: [dayOne, dayTwo], mountedRoots: [])

        guard case .mountAndSelect(let parentFolder, let files) = plan else {
            return XCTFail("expected mountAndSelect, got \(plan)")
        }
        XCTAssertEqual(parentFolder, root.standardizedFileURL)
        XCTAssertEqual(Set(files), Set([dayOne, dayTwo]))
    }
}
