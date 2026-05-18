import FileProvider
import XCTest
@testable import MapleCore

/// Coverage for the static parent-resolution helpers used by
/// `WorkingSetEnumerator` (and mirrored on `FileProviderExtensionCore`).
///
/// Load-bearing invariant: the helpers must NEVER fall back to
/// `.workingSet`. The OS now treats `item(for: .workingSet)` as
/// `noSuchItem` (the container is hidden), so any item whose parent
/// resolves to `.workingSet` aborts materialization.
final class WorkingSetEnumeratorTests: XCTestCase {
    private func root(id: String, path: String) -> LibraryRoot {
        LibraryRoot(id: id, path: path, label: id, fileCount: 0)
    }

    func testResolveParentReturnsFolderForMatchingRoot() {
        let roots = [root(id: "F1", path: "/srv/photos/Library")]
        let parent = WorkingSetEnumerator.resolveParent(
            folderID: "F1",
            absPath: "/srv/photos/Library/2026/Adam/IMG.dng",
            roots: roots
        )
        XCTAssertEqual(
            parent.rawValue,
            FileProviderIdentifier
                .folder(folderID: "F1", relativePath: "2026/Adam")
                .rawValue
        )
    }

    /// folderID is in the roots list but absPath doesn't fall under
    /// root.path (server bug, out-of-tree asset, race). Must NOT fall
    /// to `.workingSet`; instead route to the library root itself,
    /// which is always-valid.
    func testResolveParentFallsToLibraryRootOnPrefixMismatch() {
        let roots = [root(id: "F1", path: "/srv/photos/Library")]
        let parent = WorkingSetEnumerator.resolveParent(
            folderID: "F1",
            absPath: "/elsewhere/orphan.dng",
            roots: roots
        )
        XCTAssertEqual(
            parent.rawValue,
            FileProviderIdentifier
                .folder(folderID: "F1", relativePath: "")
                .rawValue,
            "prefix mismatch must route to the library root, never .workingSet"
        )
        XCTAssertNotEqual(parent, .workingSet)
    }

    /// folderID isn't in the roots list (domain unregistered, cache
    /// race). Fall to `.rootContainer` — uglier surface (asset shows up
    /// alongside the library roots rather than under one), but the
    /// identifier is always valid and materialization completes.
    func testResolveParentFallsToRootContainerForUnknownFolderID() {
        let roots = [root(id: "F1", path: "/srv/photos/Library")]
        let parent = WorkingSetEnumerator.resolveParent(
            folderID: "F2",  // not in roots
            absPath: "/srv/photos/Other/foo.dng",
            roots: roots
        )
        XCTAssertEqual(parent, .rootContainer)
        XCTAssertNotEqual(parent, .workingSet)
    }
}
