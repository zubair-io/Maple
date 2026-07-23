// MapleEnumeratorMapleDirTests.swift
//
// Issue #102 — `.maple/` synthesised enumeration.
//
// Surface under test:
//   - FolderEnumerator injects exactly one `.maple/` item per folder
//     enumeration regardless of depth.
//   - MapleDirEnumerator surfaces a single `thumbs/` child.
//   - MapleThumbsEnumerator synthesises one thumb item per indexed
//     image in the parent folder, with the server's
//     `<sha256_prefix16(basename)>.avif` filename.
//   - MapleThumbsEnumerator returns an empty list (no error) when the
//     parent folder has no indexed images — i.e. a brand-new library
//     with no thumbs cached yet still produces a valid view.

import XCTest
import FileProvider
@testable import MapleCore

final class MapleEnumeratorMapleDirTests: XCTestCase {
    override func setUp() {
        super.setUp()
        StubURLProtocol.register()
        StubURLProtocol.reset()
    }
    override func tearDown() {
        StubURLProtocol.reset()
        super.tearDown()
    }

    // MARK: - Helpers

    private func makeCatalog() -> RemoteCatalog {
        let session = TestURLSession.make()
        let http = AuthenticatedHTTPClient(
            server: URL(string: "https://x.test")!,
            urlSession: session,
            tokensProvider: { AuthTokens(access: "A1", refresh: "R1") },
            onTokensRefreshed: { _ in },
            onSignOut: {}
        )
        return RemoteCatalog(http: http,
                             server: URL(string: "https://x.test")!,
                             downloadURLSession: session)
    }

    private func makeFolderJSON(images: [(name: String, assetID: String?)]) -> String {
        let imgs: [String] = images.map { img in
            let idField: String = img.assetID.map { ",\"id\":\"\($0)\"" } ?? ""
            return "{\"name\":\"\(img.name)\",\"path\":\"/lib/\(img.name)\",\"mtime\":\"2026-01-01T00:00:00Z\",\"size\":1,\"ext\":\"dng\"\(idField)}"
        }
        return "{\"path\":\"/lib\",\"parent\":\"/\",\"dirs\":[],\"images\":[\(imgs.joined(separator: ","))],\"sidecars\":[]}"
    }

    // MARK: - Tests

    func testLibraryRootEnumerationIncludesMapleDir() async throws {
        // Server returns one indexed image. The enumerator must surface
        // that image PLUS a synthesised `.maple/` directory item.
        StubURLProtocol.handler = { _ in
            let json = self.makeFolderJSON(images: [("IMG_0001.ARW", "abc1234567890123abcdef00")])
            return (200, Data(json.utf8), [:])
        }
        let containerID = NSFileProviderItemIdentifier(
            FileProviderIdentifier.folder(folderID: "f1", relativePath: "").rawValue
        )
        let enumerator = FolderEnumerator(
            catalog: makeCatalog(),
            folderID: "f1",
            relativePath: "",
            absolutePath: "/lib",
            containerIdentifier: containerID,
            pageSize: 100
        )
        let observer = TestEnumerationObserver()
        enumerator.enumerateItems(for: observer, startingAt: NSFileProviderPage(Data()))
        let ok = await observer.waitUntilFinished(timeoutSeconds: 5)
        XCTAssertTrue(ok)
        XCTAssertNil(observer.error)
        let items = observer.batches.flatMap { $0 }
        // Exactly one `.maple/` item.
        let mapleItems = items.filter { $0.filename == ".maple" }
        XCTAssertEqual(mapleItems.count, 1, "expected exactly one .maple/ entry, got \(items.map(\.filename))")
        // Its identifier round-trips to `.mapleDir(folderID: "f1", parentRelativePath: "")`.
        let parsed = try FileProviderIdentifier(rawValue: mapleItems[0].itemIdentifier.rawValue)
        XCTAssertEqual(parsed, .mapleDir(folderID: "f1", parentRelativePath: ""))
    }

    func testNestedFolderEnumerationIncludesMapleDir() async throws {
        // Per-folder layout: every folder gets its own `.maple/`, not
        // just the library root.
        StubURLProtocol.handler = { _ in
            let json = "{\"path\":\"/lib/sub\",\"parent\":\"/lib\",\"dirs\":[],\"images\":[],\"sidecars\":[]}"
            return (200, Data(json.utf8), [:])
        }
        let containerID = NSFileProviderItemIdentifier(
            FileProviderIdentifier.folder(folderID: "f1", relativePath: "sub").rawValue
        )
        let enumerator = FolderEnumerator(
            catalog: makeCatalog(),
            folderID: "f1",
            relativePath: "sub",
            absolutePath: "/lib/sub",
            containerIdentifier: containerID,
            pageSize: 100
        )
        let observer = TestEnumerationObserver()
        enumerator.enumerateItems(for: observer, startingAt: NSFileProviderPage(Data()))
        let ok = await observer.waitUntilFinished(timeoutSeconds: 5)
        XCTAssertTrue(ok)
        let items = observer.batches.flatMap { $0 }
        let mapleItems = items.filter { $0.filename == ".maple" }
        XCTAssertEqual(mapleItems.count, 1)
        let parsed = try FileProviderIdentifier(rawValue: mapleItems[0].itemIdentifier.rawValue)
        XCTAssertEqual(parsed, .mapleDir(folderID: "f1", parentRelativePath: "sub"))
    }

    func testMapleDirInjectedOnceAcrossPaginatedListing() async throws {
        // Multi-page enumeration: the `.maple/` item must only appear
        // on the first page, not once per page.
        StubURLProtocol.handler = { req in
            let q = req.url?.query ?? ""
            let isPage2 = q.contains("cursor=p2")
            if isPage2 {
                let json = "{\"path\":\"/lib\",\"parent\":\"/\",\"dirs\":[],\"images\":[{\"name\":\"B.dng\",\"path\":\"/lib/B.dng\",\"mtime\":\"2026-01-01T00:00:00Z\",\"size\":1,\"ext\":\"dng\",\"id\":\"b00000000000000000000000\"}],\"sidecars\":[]}"
                return (200, Data(json.utf8), [:])
            }
            let json = "{\"path\":\"/lib\",\"parent\":\"/\",\"dirs\":[],\"images\":[{\"name\":\"A.dng\",\"path\":\"/lib/A.dng\",\"mtime\":\"2026-01-01T00:00:00Z\",\"size\":1,\"ext\":\"dng\",\"id\":\"a00000000000000000000000\"}],\"sidecars\":[],\"next_cursor\":\"p2\"}"
            return (200, Data(json.utf8), [:])
        }
        let containerID = NSFileProviderItemIdentifier(
            FileProviderIdentifier.folder(folderID: "f1", relativePath: "").rawValue
        )
        let enumerator = FolderEnumerator(
            catalog: makeCatalog(),
            folderID: "f1",
            relativePath: "",
            absolutePath: "/lib",
            containerIdentifier: containerID,
            pageSize: 1
        )
        let observer = TestEnumerationObserver()
        enumerator.enumerateItems(for: observer, startingAt: NSFileProviderPage(Data()))
        let ok = await observer.waitUntilFinished(timeoutSeconds: 5)
        XCTAssertTrue(ok)
        let items = observer.batches.flatMap { $0 }
        let mapleItems = items.filter { $0.filename == ".maple" }
        XCTAssertEqual(mapleItems.count, 1, "got \(items.map(\.filename))")
    }

    func testMapleDirEnumeratorReturnsThumbsChild() async {
        let containerID = NSFileProviderItemIdentifier(
            FileProviderIdentifier.mapleDir(folderID: "f1", parentRelativePath: "").rawValue
        )
        let enumerator = MapleDirEnumerator(
            folderID: "f1",
            parentRelativePath: "",
            containerIdentifier: containerID
        )
        let observer = TestEnumerationObserver()
        enumerator.enumerateItems(for: observer, startingAt: NSFileProviderPage(Data()))
        let ok = await observer.waitUntilFinished(timeoutSeconds: 5)
        XCTAssertTrue(ok)
        let items = observer.batches.flatMap { $0 }
        XCTAssertEqual(items.count, 1)
        XCTAssertEqual(items[0].filename, "thumbs")
        let parsed = try? FileProviderIdentifier(rawValue: items[0].itemIdentifier.rawValue)
        XCTAssertEqual(parsed, .mapleThumbsDir(folderID: "f1", parentRelativePath: ""))
    }

    func testMapleThumbsEnumeratorSurfacesThumbPerIndexedImage() async {
        // Parent folder has two indexed images and one unindexed image
        // (no assetID). Only the two indexed ones should produce thumb
        // items.
        StubURLProtocol.handler = { _ in
            let json = """
            {"path":"/lib","parent":"/","dirs":[],"images":[
              {"name":"A.dng","path":"/lib/A.dng","mtime":"2026-01-01T00:00:00Z","size":1,"ext":"dng","id":"a00000000000000000000000"},
              {"name":"B.dng","path":"/lib/B.dng","mtime":"2026-01-01T00:00:00Z","size":1,"ext":"dng","id":"b00000000000000000000000"},
              {"name":"C.dng","path":"/lib/C.dng","mtime":"2026-01-01T00:00:00Z","size":1,"ext":"dng"}
            ],"sidecars":[]}
            """
            return (200, Data(json.utf8), [:])
        }
        let containerID = NSFileProviderItemIdentifier(
            FileProviderIdentifier.mapleThumbsDir(folderID: "f1", parentRelativePath: "").rawValue
        )
        let enumerator = MapleThumbsEnumerator(
            catalog: makeCatalog(),
            folderID: "f1",
            parentAbsolutePath: "/lib",
            containerIdentifier: containerID,
            pageSize: 100
        )
        let observer = TestEnumerationObserver()
        enumerator.enumerateItems(for: observer, startingAt: NSFileProviderPage(Data()))
        let ok = await observer.waitUntilFinished(timeoutSeconds: 5)
        XCTAssertTrue(ok)
        XCTAssertNil(observer.error)
        let items = observer.batches.flatMap { $0 }
        XCTAssertEqual(items.count, 2, "expected 2 thumbs (A,B); C is unindexed and must be skipped")
        // Each item's filename must be the server's
        // sha256_prefix16(basename).avif.
        let names = Set(items.map { $0.filename })
        let expectedA = MapleThumbCacheKey.thumbFilename(forRawBasename: "A.dng")
        let expectedB = MapleThumbCacheKey.thumbFilename(forRawBasename: "B.dng")
        XCTAssertEqual(names, Set([expectedA, expectedB]))
        // Identifiers must round-trip to `.thumb(assetID:)`.
        for item in items {
            let parsed = try? FileProviderIdentifier(rawValue: item.itemIdentifier.rawValue)
            switch parsed {
            case .thumb(let id):
                XCTAssertTrue(id == "a00000000000000000000000" || id == "b00000000000000000000000")
            default:
                XCTFail("expected .thumb identifier, got \(String(describing: parsed))")
            }
        }
    }

    func testMapleThumbsEnumeratorEmptyWhenParentHasNoIndexedImages() async {
        // Brand-new library: parent folder has no images at all. Must
        // produce an empty enumeration WITHOUT an error.
        StubURLProtocol.handler = { _ in
            let json = "{\"path\":\"/lib\",\"parent\":\"/\",\"dirs\":[],\"images\":[],\"sidecars\":[]}"
            return (200, Data(json.utf8), [:])
        }
        let containerID = NSFileProviderItemIdentifier(
            FileProviderIdentifier.mapleThumbsDir(folderID: "f1", parentRelativePath: "").rawValue
        )
        let enumerator = MapleThumbsEnumerator(
            catalog: makeCatalog(),
            folderID: "f1",
            parentAbsolutePath: "/lib",
            containerIdentifier: containerID,
            pageSize: 100
        )
        let observer = TestEnumerationObserver()
        enumerator.enumerateItems(for: observer, startingAt: NSFileProviderPage(Data()))
        let ok = await observer.waitUntilFinished(timeoutSeconds: 5)
        XCTAssertTrue(ok)
        XCTAssertNil(observer.error, "empty parent must not produce an enumeration error")
        let items = observer.batches.flatMap { $0 }
        XCTAssertEqual(items.count, 0)
    }
}
