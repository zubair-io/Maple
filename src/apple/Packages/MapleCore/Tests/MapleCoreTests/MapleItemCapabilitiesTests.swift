// MapleItemCapabilitiesTests.swift
//
// Issue #2549 — evaluates whether `.allowsTrashing`/`.allowsEvicting`
// are a better fit than `.allowsDeleting` for live/trashed assets.
// Conclusion (see the doc comments at `MapleItem`'s `image:` and
// `trashed:` initializers): NO — `.allowsTrashing` would surface a
// Finder "Move to Trash" affordance that this extension cannot honor
// (no `NSFileProviderItemIdentifier.trashContainer` support), which is
// worse than today's behaviour, not better. `.allowsEvicting` is
// deprecated (macOS 13+) in favor of `NSFileProviderContentPolicy`,
// which also isn't implemented.
//
// This test pins the CURRENT (intentionally unchanged) capability sets
// so a future "helpful" swap to `.allowsTrashing` fails loudly instead
// of silently shipping a broken destructive-action affordance.

import XCTest
import FileProvider
@testable import MapleCore

final class MapleItemCapabilitiesTests: XCTestCase {
    func testLiveImageCapabilitiesUseAllowsDeletingNotAllowsTrashing() throws {
        let image = ImageChild(
            name: "IMG_1.ARW",
            path: "/lib/IMG_1.ARW",
            mtime: Date(timeIntervalSince1970: 1_700_000_000),
            size: 100,
            ext: "ARW",
            assetID: "650a1b2c3d4e5f6071829304"
        )
        let item = try XCTUnwrap(MapleItem(image: image, parentIdentifier: NSFileProviderItemIdentifier("folder/f1:")))
        XCTAssertEqual(item.capabilities, [.allowsReading, .allowsDeleting])
        XCTAssertFalse(item.capabilities.contains(.allowsTrashing),
                        "would route Finder's Move to Trash through the unimplemented OS trashContainer reparent path — see #2549")
    }

    func testTrashedItemCapabilitiesUseAllowsDeletingNotAllowsTrashing() throws {
        let trashItem = TrashItem(
            assetID: "650a1b2c3d4e5f6071829304",
            filename: "IMG_1.ARW",
            originalRelativePath: "2024/IMG_1.ARW",
            trashRelativePath: ".maple/trash/2024/IMG_1.ARW",
            size: 100,
            mtime: Date(timeIntervalSince1970: 1_700_000_000),
            deletedAt: Date(timeIntervalSince1970: 1_700_000_100)
        )
        let item = try XCTUnwrap(MapleItem(trashed: trashItem, parentTrashIdentifier: NSFileProviderItemIdentifier("trash/f1")))
        XCTAssertEqual(item.capabilities, [.allowsReading, .allowsReparenting, .allowsDeleting])
        XCTAssertFalse(item.capabilities.contains(.allowsTrashing),
                        "there is no OS trash-of-trash concept; .allowsDeleting here means permanent purge, matching Apple's own deleteItem doc comment — see #2549")
    }

    /// #2535: a non-indexed `.file` item used to be read-only
    /// (`[.allowsReading]`) with no path-addressed write endpoint to back
    /// anything else. Now that `RemoteCatalog.deleteFile`/`.relocateFile`
    /// exist, it can be trashed and renamed/moved — but NOT written
    /// in-place (`.allowsWriting` stays out; the write path only covers
    /// whole-file create/delete/relocate, not a partial content
    /// overwrite). Pins the capability set the same way the two tests
    /// above pin the image/trashed sets.
    func testNonIndexedFileCapabilitiesAllowDeleteAndRenameButNotInPlaceWrite() throws {
        let file = FileChild(
            name: "notes.pdf",
            path: "/lib/docs/notes.pdf",
            mtime: Date(timeIntervalSince1970: 1_700_000_000),
            size: 1024,
            ext: "pdf"
        )
        let item = MapleItem(file: file, folderID: "f1", relativePath: "docs/notes.pdf",
                             parentIdentifier: NSFileProviderItemIdentifier("folder/f1:"))
        XCTAssertEqual(item.capabilities,
                       [.allowsReading, .allowsDeleting, .allowsRenaming, .allowsReparenting])
        XCTAssertFalse(item.capabilities.contains(.allowsWriting),
                        "in-place content edit isn't wired — only whole-file create/delete/relocate")
    }
}
