// src/apple/Packages/MapleCore/Tests/MapleCoreTests/FileProviderExtensionCoreModifyItemTests.swift
import FileProvider
import XCTest
@testable import MapleCore

/// Direct `modifyItem` coverage for #2552 — the actual CRUD entry
/// point, not just its extracted `isRedundantSidecarWrite` static
/// helper (already covered by `SidecarModifyIdempotencyTests`, but only
/// as a pure function; nothing before this file constructed a
/// `FileProviderExtensionCore` and called `modifyItem` on it).
///
/// The case this file exists for: when the server already holds
/// byte-identical XMP, `modifyItem` must issue **zero** PUT requests
/// and return the item unchanged — not reissue the write with
/// `ifMtimeMatches: nil`, which is an unconditional overwrite that can
/// destroy a concurrent client's edit (TOCTOU). A non-redundant write
/// must still carry its real `X-If-Mtime-Matches` precondition, proving
/// the redundant-write skip isn't silently disabling conflict detection
/// for every write.
final class FileProviderExtensionCoreModifyItemTests: XCTestCase {
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

    /// Writes `bytes` to a fresh temp file and returns its URL, cleaned
    /// up via `addTeardownBlock`.
    private func writeTempContents(_ bytes: Data) -> URL {
        let url = FileManager.default.temporaryDirectory
            .appendingPathComponent("modifyItem-contents-\(UUID().uuidString).xmp")
        try? bytes.write(to: url)
        addTeardownBlock { try? FileManager.default.removeItem(at: url) }
        return url
    }

    private func sidecarItem(assetID: String, versionMtime: Date) -> FakeFileProviderItem {
        let identifier = NSFileProviderItemIdentifier(
            FileProviderIdentifier.sidecar(assetID: assetID, conflictBasename: nil).rawValue
        )
        return FakeFileProviderItem(
            itemIdentifier: identifier,
            parentItemIdentifier: NSFileProviderItemIdentifier("folder/folder-1:"),
            filename: "photo.xmp",
            versionMtime: versionMtime
        )
    }

    /// Runs `core.modifyItem` and blocks the test thread until the
    /// completion handler fires, returning what it received.
    private func runModifyItem(
        core: FileProviderExtensionCore,
        item: FakeFileProviderItem,
        contentsURL: URL
    ) -> (item: NSFileProviderItem?, error: Error?) {
        let done = expectation(description: "modifyItem completed")
        var resultItem: NSFileProviderItem?
        var resultError: Error?
        _ = core.modifyItem(
            item,
            baseVersion: item.itemVersion,
            changedFields: [.contents],
            contents: contentsURL,
            options: [],
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

    /// The regression case: server already holds byte-identical XMP.
    /// Must skip the write entirely — zero PUT requests — and return
    /// the item unchanged.
    func testRedundantWriteIssuesNoPUTAndReturnsItemUnchanged() {
        let bytes = Data("<xmp>same</xmp>".utf8)
        let log = FPCoreTestSupport.RequestLog()
        let catalog = FPCoreTestSupport.makeCatalog { req in
            log.record(req)
            // Only GET /xmp should ever be hit in this scenario.
            return (200, bytes, [:])
        }
        let core = FPCoreTestSupport.makeCore(catalog: catalog, test: self)
        let versionMtime = Date(timeIntervalSince1970: 1_700_000_000)
        let item = sidecarItem(assetID: validAssetID, versionMtime: versionMtime)
        let contentsURL = writeTempContents(bytes)

        let result = runModifyItem(core: core, item: item, contentsURL: contentsURL)

        XCTAssertNil(result.error)
        XCTAssertNotNil(result.item, "the item must be returned even though nothing was written")
        XCTAssertEqual(log.count(method: "PUT"), 0,
                        "server already holds these exact bytes — no PUT should ever be issued")
        XCTAssertEqual(log.count(method: "GET"), 1,
                        "exactly one canonical-bytes fetch to decide redundancy")
    }

    /// The non-redundant case: server holds DIFFERENT bytes. The write
    /// must go through, and it must carry a real
    /// `X-If-Mtime-Matches` precondition — proving the redundant-write
    /// skip above isn't a blanket "never send a precondition" shortcut.
    func testNonRedundantWriteCarriesRealPrecondition() {
        let oldBytes = Data("<xmp>old</xmp>".utf8)
        let newBytes = Data("<xmp>new edit</xmp>".utf8)
        let log = FPCoreTestSupport.RequestLog()
        let catalog = FPCoreTestSupport.makeCatalog { req in
            log.record(req)
            if req.httpMethod == "PUT" {
                return (204, Data(), ["Last-Modified": "Wed, 21 Oct 2026 07:28:00 GMT"])
            }
            return (200, oldBytes, [:])
        }
        let core = FPCoreTestSupport.makeCore(catalog: catalog, test: self)
        let versionMtime = Date(timeIntervalSince1970: 1_700_000_000)
        let item = sidecarItem(assetID: validAssetID, versionMtime: versionMtime)
        let contentsURL = writeTempContents(newBytes)

        let result = runModifyItem(core: core, item: item, contentsURL: contentsURL)

        XCTAssertNil(result.error)
        XCTAssertNotNil(result.item)
        XCTAssertEqual(log.count(method: "PUT"), 1, "a genuine edit must still be written")
        let put = log.requests.first { $0.method == "PUT" }
        XCTAssertEqual(put?.body, newBytes)
        // The point of the test: the write must carry the precondition, and it
        // must carry the item's OWN prior mtime. Asserting only that a PUT
        // happened would still pass if the precondition were dropped
        // entirely — which is the regression this test exists to catch.
        XCTAssertEqual(put?.headers["X-If-Mtime-Matches"],
                        String(Int(versionMtime.timeIntervalSince1970)),
                        "the write must be conditional on the mtime the item was read at")
        XCTAssertNil(put?.headers["X-Maple-Require-Absent"],
                      "an edit to an existing sidecar is not a create")
    }

    /// A prior mtime the server rejects as stale must still surface as
    /// a conflict-copy result (not silently swallowed), confirming the
    /// precondition path — not just the redundancy check — remains
    /// wired through `modifyItem`.
    func testPreconditionMismatchSurfacesAsConflict() {
        let currentBytes = Data("<xmp>current-on-server</xmp>".utf8)
        let newBytes = Data("<xmp>racing edit</xmp>".utf8)
        let catalog = FPCoreTestSupport.makeCatalog { req in
            if req.httpMethod == "PUT" {
                let body = #"{"conflict_path":"sub/photo (conflict from OtherMac).xmp","conflict_mtime":"2026-08-12T00:00:00.000Z"}"#
                return (409, Data(body.utf8), [:])
            }
            return (200, currentBytes, [:])
        }
        let core = FPCoreTestSupport.makeCore(catalog: catalog, test: self)
        let versionMtime = Date(timeIntervalSince1970: 1_700_000_000)
        let item = sidecarItem(assetID: validAssetID, versionMtime: versionMtime)
        let contentsURL = writeTempContents(newBytes)

        let result = runModifyItem(core: core, item: item, contentsURL: contentsURL)

        let ns = result.error as NSError?
        XCTAssertEqual(ns?.domain, NSFileProviderErrorDomain)
        XCTAssertEqual(ns?.code, NSFileProviderError.filenameCollision.rawValue)
        XCTAssertNil(result.item)
    }
}
