// src/apple/Packages/MapleCore/Tests/MapleCoreTests/UploadRetryIdempotencyTests.swift
import XCTest
import Foundation
import FileProvider
@testable import MapleCore

/// #2538 (create side): `RemoteCatalog.uploadFile`'s doc comment says a
/// duplicate upload to an existing path trashes the prior file and
/// creates a brand-new asset. When the OS redelivers a `createItem` with
/// `.mayAlreadyExist` set (sync-state-loss reimport, or a directory-merge
/// recreate), blindly uploading again would trash-and-duplicate the very
/// item the OS is telling us might already be there.
/// `FileProviderExtensionCore.matchExistingUpload` is the precheck that
/// avoids it: page through the parent directory and, if an entry already
/// carries this name AND size, hand back the item representing it
/// instead of uploading.
final class UploadRetryIdempotencyTests: XCTestCase {
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

    /// The retry scenario: an image with the same name and size already
    /// sits in the parent directory (the earlier delivery's upload
    /// already landed). The helper must return that item's MapleItem
    /// instead of nil, so the caller skips re-uploading.
    func testMatchesExistingImageByNameAndSize() async throws {
        var hits = 0
        let catalog = makeCatalog { _ in
            hits += 1
            let body = #"""
            {"path":"/p","parent":"/","dirs":[],"images":[{"name":"IMG_1.ARW","path":"/p/IMG_1.ARW","mtime":"2026-05-16T00:00:00Z","size":1024,"ext":"arw","id":"deadbeefdeadbeefdeadbeef"}],"sidecars":[],"files":[]}
            """#
            return (200, Data(body.utf8), [:])
        }
        let match = try await FileProviderExtensionCore.matchExistingUpload(
            catalog: catalog,
            parentAbsolutePath: "/p",
            filename: "IMG_1.ARW",
            localSize: 1024,
            folderID: "folder-1",
            targetRelativePath: "IMG_1.ARW",
            parentIdentifier: NSFileProviderItemIdentifier("folder/folder-1:")
        )
        XCTAssertNotNil(match, "expected a matching existing item")
        XCTAssertEqual(hits, 1)
    }

    /// Same name, DIFFERENT size — this is a real collision (different
    /// content), not a harmless retry. The helper must NOT report a
    /// match, so the caller falls through to the existing
    /// trash-and-replace upload behaviour.
    func testFallsThroughOnSizeMismatch() async throws {
        let catalog = makeCatalog { _ in
            let body = #"""
            {"path":"/p","parent":"/","dirs":[],"images":[{"name":"IMG_1.ARW","path":"/p/IMG_1.ARW","mtime":"2026-05-16T00:00:00Z","size":999,"ext":"arw","id":"deadbeefdeadbeefdeadbeef"}],"sidecars":[],"files":[]}
            """#
            return (200, Data(body.utf8), [:])
        }
        let match = try await FileProviderExtensionCore.matchExistingUpload(
            catalog: catalog,
            parentAbsolutePath: "/p",
            filename: "IMG_1.ARW",
            localSize: 1024,
            folderID: "folder-1",
            targetRelativePath: "IMG_1.ARW",
            parentIdentifier: NSFileProviderItemIdentifier("folder/folder-1:")
        )
        XCTAssertNil(match, "a size mismatch must not be treated as the same file")
    }

    /// Nothing at that name at all — genuinely new upload. No match.
    func testReturnsNilWhenNothingMatchesName() async throws {
        let catalog = makeCatalog { _ in
            (200, Data(#"{"path":"/p","parent":"/","dirs":[],"images":[],"sidecars":[],"files":[]}"#.utf8), [:])
        }
        let match = try await FileProviderExtensionCore.matchExistingUpload(
            catalog: catalog,
            parentAbsolutePath: "/p",
            filename: "IMG_1.ARW",
            localSize: 1024,
            folderID: "folder-1",
            targetRelativePath: "IMG_1.ARW",
            parentIdentifier: NSFileProviderItemIdentifier("folder/folder-1:")
        )
        XCTAssertNil(match)
    }

    /// Non-indexed file (no assetID) match — the `files` array, not
    /// `images`.
    func testMatchesExistingNonIndexedFileByNameAndSize() async throws {
        let catalog = makeCatalog { _ in
            let body = #"""
            {"path":"/p","parent":"/","dirs":[],"images":[],"sidecars":[],"files":[{"name":"notes.txt","path":"/p/notes.txt","mtime":"2026-05-16T00:00:00Z","size":42,"ext":"txt"}]}
            """#
            return (200, Data(body.utf8), [:])
        }
        let match = try await FileProviderExtensionCore.matchExistingUpload(
            catalog: catalog,
            parentAbsolutePath: "/p",
            filename: "notes.txt",
            localSize: 42,
            folderID: "folder-1",
            targetRelativePath: "notes.txt",
            parentIdentifier: NSFileProviderItemIdentifier("folder/folder-1:")
        )
        XCTAssertNotNil(match)
    }
}
