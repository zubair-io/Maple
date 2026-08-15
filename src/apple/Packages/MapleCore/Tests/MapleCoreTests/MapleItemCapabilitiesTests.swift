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
}
