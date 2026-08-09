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

    func testEmptyDropIsUnsupported() {
        let plan = DropMountPlanner.plan(for: [], mountedRoots: [])
        XCTAssertEqual(plan, .unsupported(extensions: []))
    }
}
