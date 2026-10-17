// src/apple/Packages/MapleCore/Tests/MapleCoreTests/FileProviderExtensionCoreDeleteEnumeratorTests.swift
import FileProvider
import XCTest
@testable import MapleCore

/// Direct `deleteItem` and `enumerator(for:)` dispatch coverage for
/// #2552. Neither entry point had ever been driven through a real
/// `FileProviderExtensionCore` instance before this file.
final class FileProviderExtensionCoreDeleteEnumeratorTests: XCTestCase {
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

    private func runDeleteItem(
        core: FileProviderExtensionCore,
        identifier: NSFileProviderItemIdentifier
    ) -> Error? {
        let done = expectation(description: "deleteItem completed")
        var resultError: Error?
        _ = core.deleteItem(
            identifier: identifier,
            baseVersion: NSFileProviderItemVersion(
                contentVersion: Data("v1".utf8), metadataVersion: Data("v1".utf8)
            ),
            options: [],
            request: NSFileProviderRequest(),
            completionHandler: { error in
                resultError = error
                done.fulfill()
            }
        )
        wait(for: [done], timeout: 5)
        return resultError
    }

    // MARK: - deleteItem dispatch

    func testDeleteSidecarCallsDeleteXMPAndSucceeds() {
        let log = FPCoreTestSupport.RequestLog()
        let catalog = FPCoreTestSupport.makeCatalog { req in
            log.record(req)
            return (204, Data(), [:])
        }
        let core = FPCoreTestSupport.makeCore(catalog: catalog, test: self)
        let identifier = NSFileProviderItemIdentifier(
            FileProviderIdentifier.sidecar(assetID: validAssetID, conflictBasename: nil).rawValue
        )

        let error = runDeleteItem(core: core, identifier: identifier)

        XCTAssertNil(error)
        XCTAssertEqual(log.requests.count, 1)
        XCTAssertEqual(log.requests.first?.method, "DELETE")
        XCTAssertEqual(log.requests.first?.path, "/api/assets/\(validAssetID)/xmp")
    }

    func testDeleteAssetSendsExplicitTrashIntent() {
        let log = FPCoreTestSupport.RequestLog()
        let catalog = FPCoreTestSupport.makeCatalog { req in
            log.record(req)
            return (204, Data(), [:])
        }
        let core = FPCoreTestSupport.makeCore(catalog: catalog, test: self)
        let identifier = NSFileProviderItemIdentifier(FileProviderIdentifier.asset(validAssetID).rawValue)

        let error = runDeleteItem(core: core, identifier: identifier)

        XCTAssertNil(error)
        XCTAssertEqual(log.requests.count, 1)
        XCTAssertEqual(log.requests.first?.method, "DELETE")
        XCTAssertEqual(log.requests.first?.path, "/api/assets/\(validAssetID)")
        // #4706: the legacy no-intent DELETE means "trash" for a live asset
        // and "PERMANENTLY purge" for an already-trashed one. A Finder
        // delete is a trash gesture, so the extension must say so.
        XCTAssertEqual(log.requests.first?.query, "intent=trash")
    }

    /// #4706 — a Finder delete whose response was lost is retried by the
    /// OS. The retry reaches a server that already trashed the asset; it
    /// must land as "already trashed, fine" and never as a purge.
    func testRetriedDeleteOfTrashedAssetSucceedsWithoutPurge() {
        let server = FakeTrashServer()
        let catalog = FPCoreTestSupport.makeCatalog { server.handle($0) }
        let core = FPCoreTestSupport.makeCore(catalog: catalog, test: self)
        let identifier = NSFileProviderItemIdentifier(FileProviderIdentifier.asset(validAssetID).rawValue)

        XCTAssertNil(runDeleteItem(core: core, identifier: identifier))
        XCTAssertTrue(server.trashed.contains(validAssetID))

        XCTAssertNil(runDeleteItem(core: core, identifier: identifier),
                     "a retried delete of an already-trashed asset is success-shaped")
        XCTAssertEqual(server.purged, [], "no retry may escalate a trash into a purge")
        XCTAssertEqual(server.deleteCount, 2)
    }

    /// #4706 — any 409 other than "already trashed" is a real state
    /// mismatch and must surface, not be swallowed as success.
    func testDeleteAssetUnexpectedStateMismatchSurfacesError() {
        let catalog = FPCoreTestSupport.makeCatalog { _ in
            (409, Data(#"{"error": "nope", "state": "live"}"#.utf8),
             ["Content-Type": "application/json"])
        }
        let core = FPCoreTestSupport.makeCore(catalog: catalog, test: self)
        let identifier = NSFileProviderItemIdentifier(FileProviderIdentifier.asset(validAssetID).rawValue)

        XCTAssertNotNil(runDeleteItem(core: core, identifier: identifier))
    }

    /// #4706 — the `.file` → indexed-asset self-heal retry (#2535) is the
    /// second `deleteAsset` call site; it must carry the same intent.
    func testIndexedFileRetryDeletesAssetWithTrashIntent() {
        let folderID = "650a1b2c3d4e5f6071829305"
        let log = FPCoreTestSupport.RequestLog()
        let catalog = FPCoreTestSupport.makeCatalog { req in
            log.record(req)
            if req.url?.path.hasSuffix("/file") == true {
                return (409, Data(#"{"error": "indexed", "asset_id": "\#(self.validAssetID)"}"#.utf8),
                        ["Content-Type": "application/json"])
            }
            return (204, Data(), [:])
        }
        let core = FPCoreTestSupport.makeCore(catalog: catalog, test: self)
        let identifier = NSFileProviderItemIdentifier(
            FileProviderIdentifier.file(folderID: folderID, relativePath: "2024/IMG_0001.dng").rawValue
        )

        XCTAssertNil(runDeleteItem(core: core, identifier: identifier))
        XCTAssertEqual(log.requests.count, 2)
        XCTAssertEqual(log.requests.last?.path, "/api/assets/\(validAssetID)")
        XCTAssertEqual(log.requests.last?.query, "intent=trash")
    }

    /// Models `DELETE /api/assets/:id` as the server implements it
    /// (`src/api/src/routes/assets/trash.ts`): no `intent` + live → trash,
    /// no `intent` + already trashed → PURGE, `intent=trash` + already
    /// trashed → 409 `{state: "trashed"}`.
    private final class FakeTrashServer {
        private(set) var trashed: Set<String> = []
        private(set) var purged: [String] = []
        private(set) var deleteCount = 0

        func handle(_ req: URLRequest) -> (Int, Data, [String: String]) {
            deleteCount += 1
            let assetID = req.url?.lastPathComponent ?? ""
            let intent = URLComponents(url: req.url!, resolvingAgainstBaseURL: false)?
                .queryItems?.first { $0.name == "intent" }?.value
            if trashed.contains(assetID) {
                if intent == "trash" {
                    return (409, Data(#"{"error": "Asset is already trashed", "state": "trashed"}"#.utf8),
                            ["Content-Type": "application/json"])
                }
                purged.append(assetID)
                trashed.remove(assetID)
                return (204, Data(), [:])
            }
            trashed.insert(assetID)
            return (204, Data(), [:])
        }
    }

    /// Synthetic/read-only kinds must reject with featureUnsupported and
    /// must NEVER touch the network — deletes for these have no server
    /// endpoint at all.
    // #3010: Finder shows the delete action on folders (`.allowsDeleting`
    // is advertised) but the extension answered featureUnsupported — every
    // folder delete errored. Real subfolders now route through the
    // server's recursive trash (`POST /api/folders/:id/trash-folder`,
    // which trashes every asset and removes the emptied directory). The
    // library root and the synthetic read-only kinds (`.maple/`, thumbs,
    // Trash) still reject — see the tests below for those boundaries.
    func testDeleteFolderRoutesThroughServerTrash() {
        let folderID = "650a1b2c3d4e5f6071829305"
        let log = FPCoreTestSupport.RequestLog()
        let catalog = FPCoreTestSupport.makeCatalog { req in
            log.record(req)
            let body = #"{"total": 2, "succeeded": 2, "failed": 0, "items": []}"#
            return (200, Data(body.utf8), ["Content-Type": "application/json"])
        }
        let core = FPCoreTestSupport.makeCore(catalog: catalog, test: self)
        let identifier = NSFileProviderItemIdentifier(
            FileProviderIdentifier.folder(folderID: folderID, relativePath: "2024/Trip").rawValue
        )

        let error = runDeleteItem(core: core, identifier: identifier)

        XCTAssertNil(error)
        XCTAssertEqual(log.requests.count, 1)
        XCTAssertEqual(log.requests.first?.method, "POST")
        XCTAssertEqual(log.requests.first?.path, "/api/folders/\(folderID)/trash-folder")
        XCTAssertEqual(log.requests.first?.headers["X-Maple-Target-Path"], "2024/Trip")
    }

    func testDeleteLibraryRootStaysUnsupportedWithoutAnyNetworkCall() {
        // relativePath == "" is the library root itself. Trashing an
        // entire registered library from Finder is not a supported
        // gesture — libraries are managed in the app.
        let folderID = "650a1b2c3d4e5f6071829306"
        let log = FPCoreTestSupport.RequestLog()
        let catalog = FPCoreTestSupport.makeCatalog { req in
            log.record(req)
            return (500, Data(), [:])
        }
        let core = FPCoreTestSupport.makeCore(catalog: catalog, test: self)
        let identifier = NSFileProviderItemIdentifier(
            FileProviderIdentifier.folder(folderID: folderID, relativePath: "").rawValue
        )

        let error = runDeleteItem(core: core, identifier: identifier)

        let ns = error as NSError?
        XCTAssertEqual(ns?.domain, NSCocoaErrorDomain)
        XCTAssertEqual(ns?.code, NSFeatureUnsupportedError)
        XCTAssertEqual(log.requests.count, 0)
    }

    func testDeleteFolderPartialFailureSurfacesError() {
        // 200 with failed > 0: some assets could not be trashed, so the
        // directory was not fully cleared. The OS must see an error (and
        // keep the item for retry), never a success for a half-done trash.
        let folderID = "650a1b2c3d4e5f6071829308"
        let catalog = FPCoreTestSupport.makeCatalog { _ in
            let body = #"{"total": 3, "succeeded": 2, "failed": 1, "items": []}"#
            return (200, Data(body.utf8), ["Content-Type": "application/json"])
        }
        let core = FPCoreTestSupport.makeCore(catalog: catalog, test: self)
        let identifier = NSFileProviderItemIdentifier(
            FileProviderIdentifier.folder(folderID: folderID, relativePath: "2024/Trip").rawValue
        )

        let error = runDeleteItem(core: core, identifier: identifier)

        let ns = error as NSError?
        XCTAssertEqual(ns?.domain, NSFileProviderErrorDomain)
        XCTAssertEqual(ns?.code, NSFileProviderError.serverUnreachable.rawValue)
        XCTAssertTrue(ns?.localizedDescription.contains("1 of 3") ?? false,
                      "the error must say how much of the trash failed")
    }

    func testDeleteFolderSurfacesServerError() {
        let folderID = "650a1b2c3d4e5f6071829307"
        let catalog = FPCoreTestSupport.makeCatalog { _ in
            (500, Data(#"{"error": "boom"}"#.utf8), ["Content-Type": "application/json"])
        }
        let core = FPCoreTestSupport.makeCore(catalog: catalog, test: self)
        let identifier = NSFileProviderItemIdentifier(
            FileProviderIdentifier.folder(folderID: folderID, relativePath: "2024/Trip").rawValue
        )

        let error = runDeleteItem(core: core, identifier: identifier)

        XCTAssertNotNil(error, "a failed server trash must not report success to the OS")
    }

    func testDeleteUnsupportedKindsRejectWithoutAnyNetworkCall() {
        let log = FPCoreTestSupport.RequestLog()
        let catalog = FPCoreTestSupport.makeCatalog { req in
            log.record(req)
            return (500, Data(), [:])
        }
        let core = FPCoreTestSupport.makeCore(catalog: catalog, test: self)

        let unsupported: [NSFileProviderItemIdentifier] = [
            NSFileProviderItemIdentifier(FileProviderIdentifier.folder(folderID: "f1", relativePath: "").rawValue),
            NSFileProviderItemIdentifier(FileProviderIdentifier.mapleDir(folderID: "f1", parentRelativePath: "").rawValue),
            NSFileProviderItemIdentifier(FileProviderIdentifier.mapleThumbsDir(folderID: "f1", parentRelativePath: "").rawValue),
            NSFileProviderItemIdentifier(FileProviderIdentifier.thumb(assetID: validAssetID).rawValue),
            // `.file` deliberately NOT listed: #2535 made non-indexed file
            // deletes real (path-addressed trash via `deleteFile`), but this
            // list was never updated — a stale entry that failed silently
            // for months because CI only compiles MapleCore, it never runs
            // these tests. Found while auditing delete paths for #3010.
        ]
        for identifier in unsupported {
            let error = runDeleteItem(core: core, identifier: identifier)
            let ns = error as NSError?
            XCTAssertEqual(ns?.domain, NSCocoaErrorDomain, "for \(identifier.rawValue)")
            XCTAssertEqual(ns?.code, NSFeatureUnsupportedError, "for \(identifier.rawValue)")
        }
        XCTAssertEqual(log.requests.count, 0, "none of these kinds should ever reach the network")
    }

    // MARK: - No Maple Trash in Finder (#4706)

    /// Finder used to list a synthetic "<Library> Trash" next to every
    /// library root. Its items shared the live asset identifier, so
    /// `deleteItem` could not tell "trash this photo" from "purge this
    /// trashed photo" and the only disambiguator was the server's
    /// dual-mode DELETE — the exact mechanism that purged originals on a
    /// retried delete. Permanent deletion lives in the app's Trash
    /// browser; Finder gets no trash container at all.
    func testRootEnumerationPublishesOnlyLibraryRoots() async {
        let roots = [
            LibraryRoot(id: "650a1b2c3d4e5f6071829305", path: "/lib/a", label: "A", fileCount: 1),
            LibraryRoot(id: "650a1b2c3d4e5f6071829306", path: "/lib/b", label: "B", fileCount: 1),
        ]
        let catalog = FPCoreTestSupport.makeCatalog { _ in (500, Data(), [:]) }
        let rootCache = LibraryRootCache(
            domainID: "root-test",
            defaults: UserDefaults(suiteName: "fp-root-test-\(UUID().uuidString)")!,
            fetcher: { roots })
        let observer = TestEnumerationObserver()

        RootEnumerator(catalog: catalog, rootCache: rootCache)
            .enumerateItems(for: observer, startingAt: NSFileProviderPage.initialPageSortedByName as NSFileProviderPage)
        let finished = await observer.waitUntilFinished(timeoutSeconds: 5)

        XCTAssertTrue(finished)
        let published = observer.batches.flatMap { $0 }.map(\.itemIdentifier.rawValue)
        XCTAssertNil(observer.error)
        XCTAssertEqual(published, roots.map { FileProviderIdentifier.folder(folderID: $0.id, relativePath: "").rawValue })
    }

    func testTrashContainerIdentifierNoLongerParses() {
        XCTAssertThrowsError(try FileProviderIdentifier(rawValue: "trash/650a1b2c3d4e5f6071829305")) { error in
            XCTAssertEqual(error as? FileProviderIdentifier.DecodeError, .invalidPrefix)
        }
    }

    func testStaleTrashContainerIdentifierHasNoEnumerator() {
        let catalog = FPCoreTestSupport.makeCatalog { _ in (500, Data(), [:]) }
        let core = FPCoreTestSupport.makeCore(catalog: catalog, test: self)

        XCTAssertThrowsError(
            try core.enumerator(for: NSFileProviderItemIdentifier("trash/650a1b2c3d4e5f6071829305"),
                                request: NSFileProviderRequest()))
    }

    // MARK: - enumerator(for:) dispatch

    func testFolderIdentifierReturnsDeferredFolderEnumerator() throws {
        let catalog = FPCoreTestSupport.makeCatalog { _ in (200, Data(), [:]) }
        let core = FPCoreTestSupport.makeCore(catalog: catalog, test: self)
        let identifier = NSFileProviderItemIdentifier(
            FileProviderIdentifier.folder(folderID: "f1", relativePath: "").rawValue
        )
        let enumerator = try core.enumerator(for: identifier, request: NSFileProviderRequest())
        XCTAssertTrue(enumerator is DeferredFolderEnumerator)
    }

    func testTrashContainerReturnsEmptyEnumerator() throws {
        let catalog = FPCoreTestSupport.makeCatalog { _ in (200, Data(), [:]) }
        let core = FPCoreTestSupport.makeCore(catalog: catalog, test: self)
        let enumerator = try core.enumerator(for: .trashContainer, request: NSFileProviderRequest())
        XCTAssertTrue(enumerator is EmptyEnumerator)
    }

    /// Leaf identifiers are not containers — the OS must never be handed
    /// an enumerator for one.
    func testLeafIdentifiersThrowNoSuchItem() {
        let catalog = FPCoreTestSupport.makeCatalog { _ in (200, Data(), [:]) }
        let core = FPCoreTestSupport.makeCore(catalog: catalog, test: self)

        let leaves: [NSFileProviderItemIdentifier] = [
            NSFileProviderItemIdentifier(FileProviderIdentifier.asset(validAssetID).rawValue),
            NSFileProviderItemIdentifier(FileProviderIdentifier.file(folderID: "f1", relativePath: "notes.txt").rawValue),
            NSFileProviderItemIdentifier(FileProviderIdentifier.sidecar(assetID: validAssetID, conflictBasename: nil).rawValue),
            NSFileProviderItemIdentifier(FileProviderIdentifier.thumb(assetID: validAssetID).rawValue),
        ]
        for identifier in leaves {
            XCTAssertThrowsError(
                try core.enumerator(for: identifier, request: NSFileProviderRequest()),
                "expected noSuchItem for \(identifier.rawValue)"
            ) { error in
                let ns = error as NSError
                XCTAssertEqual(ns.domain, NSFileProviderErrorDomain, "for \(identifier.rawValue)")
                XCTAssertEqual(ns.code, NSFileProviderError.noSuchItem.rawValue, "for \(identifier.rawValue)")
            }
        }
    }
}
