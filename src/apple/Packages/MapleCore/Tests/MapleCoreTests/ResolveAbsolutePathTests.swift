// src/apple/Packages/MapleCore/Tests/MapleCoreTests/ResolveAbsolutePathTests.swift
import XCTest
import Foundation
@testable import MapleCore

/// `FileProviderExtensionCore.resolveAbsolutePath` resolves a
/// `folderID + relativePath` pair to the absolute path on the server's
/// filesystem via the cached library-roots list — the same lookup
/// `item(for:)` and `assetID(forSidecarNamed:)` already do inline, pulled
/// out so #2542 (folder-create collision precheck) and #2538
/// (upload-retry precheck) can share it and it can be tested directly.
final class ResolveAbsolutePathTests: XCTestCase {
    private func makeRootCache(roots: [LibraryRoot]) -> LibraryRootCache {
        LibraryRootCache(domainID: "test-\(UUID().uuidString)",
                         defaults: UserDefaults(suiteName: "resolve-abs-path-tests-\(UUID().uuidString)"),
                         fetcher: { roots })
    }

    func testResolvesRootPathWhenRelativeIsEmpty() async {
        let cache = makeRootCache(roots: [
            LibraryRoot(id: "folder-1", path: "/srv/photos/Library", label: "Library", fileCount: 10),
        ])
        let resolved = await FileProviderExtensionCore.resolveAbsolutePath(
            folderID: "folder-1", relativePath: "", rootCache: cache)
        XCTAssertEqual(resolved, "/srv/photos/Library")
    }

    func testAppendsRelativePathUnderRoot() async {
        let cache = makeRootCache(roots: [
            LibraryRoot(id: "folder-1", path: "/srv/photos/Library", label: "Library", fileCount: 10),
        ])
        let resolved = await FileProviderExtensionCore.resolveAbsolutePath(
            folderID: "folder-1", relativePath: "2026/Adam", rootCache: cache)
        XCTAssertEqual(resolved, "/srv/photos/Library/2026/Adam")
    }

    func testReturnsNilWhenFolderIDNotInRoots() async {
        let cache = makeRootCache(roots: [
            LibraryRoot(id: "folder-1", path: "/srv/photos/Library", label: "Library", fileCount: 10),
        ])
        let resolved = await FileProviderExtensionCore.resolveAbsolutePath(
            folderID: "unregistered", relativePath: "", rootCache: cache)
        XCTAssertNil(resolved)
    }

    func testReturnsNilWhenRootCacheIsNil() async {
        let resolved = await FileProviderExtensionCore.resolveAbsolutePath(
            folderID: "folder-1", relativePath: "", rootCache: nil)
        XCTAssertNil(resolved)
    }
}
