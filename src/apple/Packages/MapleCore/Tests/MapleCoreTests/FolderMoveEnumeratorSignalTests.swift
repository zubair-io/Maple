// src/apple/Packages/MapleCore/Tests/MapleCoreTests/FolderMoveEnumeratorSignalTests.swift
import XCTest
import FileProvider
@testable import MapleCore

/// #2541: `modifyItem`'s folder-move branch used to signal only the old
/// and new PARENT identifiers, never the moved folder's own new
/// identifier — a grep of every `signalEnumerator`/`signalEnumeratorReload`
/// call site confirmed none targeted it. Folder identifiers embed their
/// relative path, so a move changes the folder's own identifier too;
/// without signalling it, a Finder window open ON the moved folder
/// doesn't refresh until an incidental re-enumeration happens to hit it.
///
/// `FileProviderExtensionCore.enumeratorReloadTargets` is the pure
/// computation of which identifiers a folder move must signal, extracted
/// so the fix is testable without a live `NSFileProviderManager`.
final class FolderMoveEnumeratorSignalTests: XCTestCase {
    /// Same-parent rename (old and new parent are identical): must
    /// signal the (single) parent once and the moved folder's own new
    /// identifier — never a duplicate parent entry.
    func testSameParentRenameSignalsParentAndMovedFolderSelf() {
        let newParentID = NSFileProviderItemIdentifier(
            FileProviderIdentifier.folder(folderID: "lib-1", relativePath: "2026").rawValue)
        let targets = FileProviderExtensionCore.enumeratorReloadTargets(
            folderID: "lib-1",
            newParentID: newParentID,
            sourceRelativePath: "2026/OldName",
            targetRelativePath: "2026/NewName"
        )
        let movedFolderSelf = NSFileProviderItemIdentifier(
            FileProviderIdentifier.folder(folderID: "lib-1", relativePath: "2026/NewName").rawValue)
        XCTAssertTrue(targets.contains(newParentID), "must signal the parent")
        XCTAssertTrue(targets.contains(movedFolderSelf),
                      "must signal the moved folder's OWN new identifier — the regression this test guards")
        XCTAssertEqual(targets.count, 2, "same parent must not appear twice: \(targets)")
    }

    /// Cross-folder move: old parent, new parent, AND the moved folder's
    /// own new identifier must all be signalled — three distinct targets.
    func testCrossFolderMoveSignalsOldParentNewParentAndMovedFolderSelf() {
        let newParentID = NSFileProviderItemIdentifier(
            FileProviderIdentifier.folder(folderID: "lib-1", relativePath: "2026/Adam").rawValue)
        let targets = FileProviderExtensionCore.enumeratorReloadTargets(
            folderID: "lib-1",
            newParentID: newParentID,
            sourceRelativePath: "2026/Ben/Vacation",
            targetRelativePath: "2026/Adam/Vacation"
        )
        let oldParentID = NSFileProviderItemIdentifier(
            FileProviderIdentifier.folder(folderID: "lib-1", relativePath: "2026/Ben").rawValue)
        let movedFolderSelf = NSFileProviderItemIdentifier(
            FileProviderIdentifier.folder(folderID: "lib-1", relativePath: "2026/Adam/Vacation").rawValue)
        XCTAssertEqual(Set(targets), Set([newParentID, oldParentID, movedFolderSelf]))
        XCTAssertEqual(targets.count, 3)
    }

    /// A folder moved from the library root (empty source parent) —
    /// `oldParentRelative` must resolve to "" without crashing on the
    /// `lastIndex(of: "/")` nil case.
    func testMoveFromLibraryRootResolvesEmptyOldParent() {
        let newParentID = NSFileProviderItemIdentifier(
            FileProviderIdentifier.folder(folderID: "lib-1", relativePath: "2026").rawValue)
        let targets = FileProviderExtensionCore.enumeratorReloadTargets(
            folderID: "lib-1",
            newParentID: newParentID,
            sourceRelativePath: "OldTopLevel",
            targetRelativePath: "2026/OldTopLevel"
        )
        let oldParentID = NSFileProviderItemIdentifier(
            FileProviderIdentifier.folder(folderID: "lib-1", relativePath: "").rawValue)
        XCTAssertTrue(targets.contains(oldParentID))
        XCTAssertTrue(targets.contains(newParentID))
    }
}
