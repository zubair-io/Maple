// src/apple/Packages/MapleCore/Tests/MapleCoreTests/FileProviderExtensionCoreCreateItemTests.swift
import FileProvider
import XCTest
@testable import MapleCore

/// Direct `createItem` coverage for #2552 — the actual dispatching CRUD
/// entry point (extension + folder/xmp/upload routing), not just the
/// extracted static helpers `createOnlyPrecondition` and
/// `matchExistingUpload` (already covered by `CreateXMPPreconditionTests`
/// and `UploadRetryIdempotencyTests`, but only as pure/near-pure
/// functions called directly — nothing before this file constructed a
/// `FileProviderExtensionCore` and drove `createItem` itself).
final class FileProviderExtensionCoreCreateItemTests: XCTestCase {
    override func setUp() {
        super.setUp()
        StubURLProtocol.register()
        StubURLProtocol.reset()
    }

    override func tearDown() {
        StubURLProtocol.reset()
        super.tearDown()
    }

    private let validAssetID = "650a1b2c3d4e5f6071829304"
    private let testRoots = [LibraryRoot(id: "folder-1", path: "/lib", label: "Lib", fileCount: 1)]

    private func folderParent(relativePath: String = "") -> NSFileProviderItemIdentifier {
        NSFileProviderItemIdentifier(
            FileProviderIdentifier.folder(folderID: "folder-1", relativePath: relativePath).rawValue
        )
    }

    private func runCreateItem(
        core: FileProviderExtensionCore,
        item: FakeFileProviderItem,
        contents: URL?,
        options: NSFileProviderCreateItemOptions = []
    ) -> (item: NSFileProviderItem?, error: Error?) {
        let done = expectation(description: "createItem completed")
        var resultItem: NSFileProviderItem?
        var resultError: Error?
        _ = core.createItem(
            basedOn: item,
            fields: [],
            contents: contents,
            options: options,
            request: NSFileProviderRequest(),
            completionHandler: { item, _, _, error in
                resultItem = item
                resultError = error
                done.fulfill()
            }
        )
        wait(for: [done], timeout: 5)
        return (resultItem, resultError)
    }

    // MARK: - createXMPItem create-only guard (#2532)

    /// The sidecar already exists server-side. `createXMPItem` must send
    /// `requireAbsent: true` unconditionally on the PUT — this stub
    /// server mirrors the real one's precondition check: it honors that
    /// header and returns 409 (conflict-copy) rather than overwriting.
    /// If a regression dropped the `requireAbsent` header, this exact
    /// same stub would 204 the PUT and the test would see a fabricated
    /// success instead of a collision.
    func testCreateXMPOverExistingSidecarDoesNotOverwrite() {
        let log = FPCoreTestSupport.RequestLog()
        let catalog = FPCoreTestSupport.makeCatalog { req in
            log.record(req)
            if req.url?.path == "/api/fs/dir" {
                let body = #"""
                {"path":"/lib","parent":null,"dirs":[],"images":[{"name":"photo.ARW","path":"/lib/photo.ARW","mtime":"2026-05-16T00:00:00Z","size":1024,"ext":"arw","id":"\#(self.validAssetID)"}],"sidecars":[],"files":[]}
                """#
                return (200, Data(body.utf8), [:])
            }
            if req.url?.path.hasPrefix("/api/assets/") == true, req.httpMethod == "PUT" {
                let requiredAbsent = req.value(forHTTPHeaderField: "X-Maple-Require-Absent") == "true"
                if requiredAbsent {
                    let body = #"{"conflict_path":"photo (conflict from TestMac).xmp","conflict_mtime":"2026-08-12T00:00:00.000Z"}"#
                    return (409, Data(body.utf8), [:])
                }
                // Regression shape: no create-only guard, unconditional overwrite.
                return (204, Data(), ["Last-Modified": "Wed, 21 Oct 2026 07:28:00 GMT"])
            }
            return (404, Data(), [:])
        }
        let core = FPCoreTestSupport.makeCore(catalog: catalog, roots: testRoots, test: self)
        let template = FakeFileProviderItem(
            itemIdentifier: NSFileProviderItemIdentifier("pending"),
            parentItemIdentifier: folderParent(),
            filename: "photo.xmp"
        )
        let contents = FileManager.default.temporaryDirectory
            .appendingPathComponent("createXMP-\(UUID().uuidString).xmp")
        try? Data("<xmp>incoming</xmp>".utf8).write(to: contents)
        addTeardownBlock { try? FileManager.default.removeItem(at: contents) }

        let result = runCreateItem(core: core, item: template, contents: contents)

        let ns = result.error as NSError?
        XCTAssertEqual(ns?.domain, NSFileProviderErrorDomain,
                        "an already-existing sidecar must surface as a collision, not succeed silently")
        XCTAssertEqual(ns?.code, NSFileProviderError.filenameCollision.rawValue)
        XCTAssertNil(result.item)
        XCTAssertEqual(log.count(method: "PUT"), 1)
    }

    /// The legitimate case: nothing exists at the target path. The
    /// create must go through and hand back a real sidecar item.
    func testCreateXMPOverAbsentSidecarSucceeds() {
        let catalog = FPCoreTestSupport.makeCatalog { req in
            if req.url?.path == "/api/fs/dir" {
                let body = #"""
                {"path":"/lib","parent":null,"dirs":[],"images":[{"name":"photo.ARW","path":"/lib/photo.ARW","mtime":"2026-05-16T00:00:00Z","size":1024,"ext":"arw","id":"\#(self.validAssetID)"}],"sidecars":[],"files":[]}
                """#
                return (200, Data(body.utf8), [:])
            }
            if req.url?.path.hasPrefix("/api/assets/") == true, req.httpMethod == "PUT" {
                return (204, Data(), ["Last-Modified": "Wed, 21 Oct 2026 07:28:00 GMT"])
            }
            return (404, Data(), [:])
        }
        let core = FPCoreTestSupport.makeCore(catalog: catalog, roots: testRoots, test: self)
        let template = FakeFileProviderItem(
            itemIdentifier: NSFileProviderItemIdentifier("pending"),
            parentItemIdentifier: folderParent(),
            filename: "photo.xmp"
        )
        let contents = FileManager.default.temporaryDirectory
            .appendingPathComponent("createXMP-\(UUID().uuidString).xmp")
        try? Data("<xmp>brand new</xmp>".utf8).write(to: contents)
        addTeardownBlock { try? FileManager.default.removeItem(at: contents) }

        let result = runCreateItem(core: core, item: template, contents: contents)

        XCTAssertNil(result.error)
        XCTAssertNotNil(result.item)
    }

    // MARK: - createItem / uploadItem retry idempotency (#2538)

    /// OS redelivery with `.mayAlreadyExist`: an entry with the same
    /// name AND size already sits in the parent directory. The upload
    /// endpoint must never be hit a second time.
    func testMayAlreadyExistRedeliveryDoesNotReUpload() {
        let log = FPCoreTestSupport.RequestLog()
        let localBytes = Data(repeating: 0x41, count: 1024)
        let catalog = FPCoreTestSupport.makeCatalog { req in
            log.record(req)
            if req.url?.path == "/api/fs/dir" {
                let body = #"""
                {"path":"/lib","parent":null,"dirs":[],"images":[{"name":"IMG_1.ARW","path":"/lib/IMG_1.ARW","mtime":"2026-05-16T00:00:00Z","size":1024,"ext":"arw","id":"\#(self.validAssetID)"}],"sidecars":[],"files":[]}
                """#
                return (200, Data(body.utf8), [:])
            }
            return (500, Data(), [:]) // an upload call here is the bug this test guards against
        }
        let core = FPCoreTestSupport.makeCore(catalog: catalog, roots: testRoots, test: self)
        let template = FakeFileProviderItem(
            itemIdentifier: NSFileProviderItemIdentifier("pending"),
            parentItemIdentifier: folderParent(),
            filename: "IMG_1.ARW"
        )
        let contents = FileManager.default.temporaryDirectory
            .appendingPathComponent("upload-\(UUID().uuidString).ARW")
        try? localBytes.write(to: contents)
        addTeardownBlock { try? FileManager.default.removeItem(at: contents) }

        let result = runCreateItem(core: core, item: template, contents: contents,
                                    options: [.mayAlreadyExist])

        XCTAssertNil(result.error)
        XCTAssertNotNil(result.item, "must report the existing item instead of failing")
        XCTAssertEqual(log.requests.filter { $0.path.contains("/upload") }.count, 0,
                        "a size+name match on redelivery must never re-upload")
    }

    /// When the local file's size can't be read, the precheck must NOT
    /// fall back to a default (e.g. 0) that could false-match an
    /// unrelated server-side entry — it must skip the shortcut entirely
    /// and fall through to the normal upload path. Observable as: the
    /// precheck's `listDir` lookup is never invoked.
    func testUnreadableLocalSizeSkipsPrecheckShortcut() {
        let log = FPCoreTestSupport.RequestLog()
        let catalog = FPCoreTestSupport.makeCatalog { req in
            log.record(req)
            return (500, Data(), [:])
        }
        let core = FPCoreTestSupport.makeCore(catalog: catalog, roots: testRoots, test: self)
        let template = FakeFileProviderItem(
            itemIdentifier: NSFileProviderItemIdentifier("pending"),
            parentItemIdentifier: folderParent(),
            filename: "IMG_1.ARW"
        )
        // Deliberately nonexistent — FileManager.attributesOfItem throws,
        // so `(try? ...)?[.size]` is nil, not a defaulted 0.
        let missingContents = FileManager.default.temporaryDirectory
            .appendingPathComponent("does-not-exist-\(UUID().uuidString).ARW")

        let result = runCreateItem(core: core, item: template, contents: missingContents,
                                    options: [.mayAlreadyExist])

        XCTAssertNotNil(result.error, "the normal upload path fails fast on a missing local file")
        XCTAssertEqual(log.requests.filter { $0.path == "/api/fs/dir" }.count, 0,
                        "an unreadable local size must never reach the match-existing precheck")
    }
}
