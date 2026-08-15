// src/apple/Packages/MapleCore/Tests/MapleCoreTests/FolderCreateCollisionTests.swift
import XCTest
import Foundation
@testable import MapleCore

/// #2542: `createFolderItem` used to call `catalog.makeDir` — server-side
/// `mkdir -p`, idempotent, 201 whether or not the folder pre-existed —
/// with no precheck, so a real name collision (two near-simultaneous
/// folder creations from different clients) was silently swallowed
/// instead of surfaced as `NSFileProviderError.filenameCollision`.
///
/// The fix composes two already-tested building blocks exactly the way
/// `createFolderItem` does: `resolveAbsolutePath` (folderID+relativePath
/// -> absolute path via the roots cache) feeding `findChildDir` (does a
/// sibling with this name already exist). This test exercises that exact
/// composition against a stubbed catalog + root cache — the same
/// dependency shape `createFolderItem` itself receives — rather than
/// re-deriving either helper's own unit coverage.
final class FolderCreateCollisionTests: XCTestCase {
    private func makeRootCache(roots: [LibraryRoot]) -> LibraryRootCache {
        LibraryRootCache(domainID: "test-\(UUID().uuidString)",
                         defaults: UserDefaults(suiteName: "folder-collision-tests-\(UUID().uuidString)"),
                         fetcher: { roots })
    }

    private func makeCatalog(handler: @escaping (URLRequest) -> (Int, Data, [String: String])) -> RemoteCatalog {
        StubURLProtocol.register()
        StubURLProtocol.reset()
        StubURLProtocol.handler = handler
        let session = TestURLSession.make()
        let http = AuthenticatedHTTPClient(
            server: URL(string: "https://x.test")!,
            urlSession: session,
            tokensProvider: { AuthTokens(access: "A1", refresh: "R1") },
            onTokensRefreshed: { _ in },
            onSignOut: {}
        )
        return RemoteCatalog(http: http, server: URL(string: "https://x.test")!, downloadURLSession: session)
    }

    /// A sibling folder with the target name already exists server-side —
    /// the precheck must find it, so `createFolderItem` can report a
    /// collision instead of calling `makeDir` and silently succeeding.
    func testDetectsPreexistingSiblingFolder() async throws {
        let rootCache = makeRootCache(roots: [
            LibraryRoot(id: "folder-1", path: "/srv/photos/Library", label: "Library", fileCount: 10),
        ])
        let catalog = makeCatalog { _ in
            let body = #"""
            {"path":"/srv/photos/Library/2026","parent":"/srv/photos/Library","dirs":[{"name":"Vacation","path":"/srv/photos/Library/2026/Vacation","mtime":"2026-05-16T00:00:00Z"}],"images":[],"sidecars":[]}
            """#
            return (200, Data(body.utf8), [:])
        }
        let parentAbs = await FileProviderExtensionCore.resolveAbsolutePath(
            folderID: "folder-1", relativePath: "2026", rootCache: rootCache)
        XCTAssertEqual(parentAbs, "/srv/photos/Library/2026")
        let existing = try await FileProviderExtensionCore.findChildDir(
            catalog: catalog, absolutePath: parentAbs!, childName: "Vacation")
        XCTAssertNotNil(existing, "a real collision must be detected, not silently swallowed")
        XCTAssertEqual(existing?.name, "Vacation")
    }

    /// Nothing at that name yet — the legitimate new-folder case. The
    /// precheck must find nothing, so `createFolderItem` proceeds to
    /// `makeDir` exactly as it did before this fix.
    func testNoCollisionWhenNameIsFree() async throws {
        let rootCache = makeRootCache(roots: [
            LibraryRoot(id: "folder-1", path: "/srv/photos/Library", label: "Library", fileCount: 10),
        ])
        let catalog = makeCatalog { _ in
            (200, Data(#"{"path":"/srv/photos/Library/2026","parent":"/srv/photos/Library","dirs":[],"images":[],"sidecars":[]}"#.utf8), [:])
        }
        let parentAbs = await FileProviderExtensionCore.resolveAbsolutePath(
            folderID: "folder-1", relativePath: "2026", rootCache: rootCache)
        let existing = try await FileProviderExtensionCore.findChildDir(
            catalog: catalog, absolutePath: parentAbs!, childName: "NewAlbum")
        XCTAssertNil(existing)
    }
}
