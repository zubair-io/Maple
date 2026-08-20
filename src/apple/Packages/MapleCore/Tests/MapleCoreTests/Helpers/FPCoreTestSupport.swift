// src/apple/Packages/MapleCore/Tests/MapleCoreTests/Helpers/FPCoreTestSupport.swift
import FileProvider
import Foundation
import XCTest
@testable import MapleCore

/// Shared construction helpers for `FileProviderExtensionCore` CRUD tests
/// (#2552).
///
/// `FileProviderExtensionCore.init(domain:)` — the only initializer any
/// production caller sees — resolves its collaborators (config lookup,
/// `TokenStore`, live `URLSession`, `RemoteCatalog`, `LibraryRootCache`,
/// …) itself and cannot be driven in a test. The seam added for this
/// ticket is an `internal` designated initializer,
/// `init(domain:dormant:catalog:rootCache:deviceName:metaStore:workingSet:cursorStore:workingSetListCache:)`,
/// that the production convenience `init(domain:)` now delegates to
/// after building those values the normal way. `@testable import
/// MapleCore` reaches it from here, so these helpers construct a "live"
/// (non-dormant) core with every collaborator under test control:
///   - `RemoteCatalog` wired to `StubURLProtocol` (same shape
///     `RemoteCatalogTests`/`DeferredFolderEnumeratorChangesTests` use;
///     no mocking of the sidecar layer — real request/response bytes
///     through a stubbed transport).
///   - `LibraryRootCache` primed with an in-memory `roots` list and a
///     throwaway `UserDefaults` suite (never touches the real App Group).
///   - `WorkingSet` / `ChangeCursorStore` rooted at a per-test temp
///     directory, cleaned up via `addTeardownBlock`.
///   - `FileProviderMetaStore` real SQLite in a temp file when a test
///     asks for one; `nil` (best-effort-absent, matching the "open
///     failed" production fallback) otherwise.
enum FPCoreTestSupport {
    static let server = URL(string: "https://x.test")!

    /// Registers `StubURLProtocol` and builds a `RemoteCatalog` that
    /// routes every request through `handler`. Callers own resetting the
    /// handler between tests via `StubURLProtocol.reset()` in
    /// `setUp`/`tearDown` — this mirrors `RemoteCatalogTests` et al.
    static func makeCatalog(
        handler: @escaping (URLRequest) -> (Int, Data, [String: String])
    ) -> RemoteCatalog {
        StubURLProtocol.register()
        StubURLProtocol.handler = handler
        let session = TestURLSession.make()
        let http = AuthenticatedHTTPClient(
            server: server,
            urlSession: session,
            tokensProvider: { AuthTokens(access: "A1", refresh: "R1") },
            onTokensRefreshed: { _ in },
            onSignOut: {}
        )
        return RemoteCatalog(http: http, server: server, downloadURLSession: session)
    }

    /// A `RemoteCatalog` whose `handler` counts requests and records each
    /// one's method + path, so a test can assert on the exact set of
    /// calls made (e.g. "zero PUT requests").
    final class RequestLog {
        private(set) var requests: [(method: String, path: String, body: Data)] = []
        func record(_ req: URLRequest) {
            requests.append((
                method: req.httpMethod ?? "GET",
                path: req.url?.path ?? "",
                body: req.httpBodyStreamData() ?? req.httpBody ?? Data()
            ))
        }
        func count(method: String) -> Int {
            requests.filter { $0.method == method }.count
        }
    }

    /// Builds a live `FileProviderExtensionCore` through the #2552 test
    /// seam. `roots` primes the `LibraryRootCache` fetcher (used
    /// synchronously — no network round-trip). `test` supplies
    /// `addTeardownBlock` so the per-test temp cursor directory is
    /// cleaned up.
    static func makeCore(catalog: RemoteCatalog,
                          roots: [LibraryRoot] = [],
                          domainID: String = "test-domain",
                          metaStoreURL: URL? = nil,
                          test: XCTestCase) -> FileProviderExtensionCore {
        let domain = NSFileProviderDomain(
            identifier: NSFileProviderDomainIdentifier(domainID),
            displayName: "Test Domain"
        )
        let rootCache = LibraryRootCache(
            domainID: domainID,
            defaults: UserDefaults(suiteName: "fp-core-test-\(UUID().uuidString)")!,
            fetcher: { roots }
        )
        let cursorDir = FileManager.default.temporaryDirectory
            .appendingPathComponent("FPCoreTest-\(UUID().uuidString)")
        test.addTeardownBlock { try? FileManager.default.removeItem(at: cursorDir) }
        let cursorStore = ChangeCursorStore(directory: cursorDir)
        let workingSet = WorkingSet(capacity: WorkingSet.defaultCapacity)
        let listCache = WorkingSetListCache(catalog: catalog)
        let metaStore: FileProviderMetaStore? = metaStoreURL.flatMap { try? FileProviderMetaStore(url: $0) }
        return FileProviderExtensionCore(
            domain: domain,
            dormant: false,
            catalog: catalog,
            rootCache: rootCache,
            deviceName: "test-device",
            metaStore: metaStore,
            workingSet: workingSet,
            cursorStore: cursorStore,
            workingSetListCache: listCache
        )
    }

    /// A dormant core (no config resolved) — the production shape used
    /// when a domain hasn't been signed in yet. `catalog`/`rootCache`
    /// are `nil`, exactly as `init(domain:)`'s guard-else branch leaves
    /// them.
    static func makeDormantCore(domainID: String = "dormant-domain",
                                 test: XCTestCase) -> FileProviderExtensionCore {
        let domain = NSFileProviderDomain(
            identifier: NSFileProviderDomainIdentifier(domainID),
            displayName: "Dormant Domain"
        )
        let cursorDir = FileManager.default.temporaryDirectory
            .appendingPathComponent("FPCoreTest-\(UUID().uuidString)")
        test.addTeardownBlock { try? FileManager.default.removeItem(at: cursorDir) }
        return FileProviderExtensionCore(
            domain: domain,
            dormant: true,
            catalog: nil,
            rootCache: nil,
            deviceName: "test-device",
            metaStore: nil,
            workingSet: WorkingSet(capacity: WorkingSet.defaultCapacity),
            cursorStore: ChangeCursorStore(directory: cursorDir),
            workingSetListCache: nil
        )
    }
}

extension URLRequest {
    /// `httpBody` is nil for requests built with a body stream (some
    /// `URLRequest` construction paths use one); this drains it so a
    /// `RequestLog` handler can inspect the bytes either way.
    func httpBodyStreamData() -> Data? {
        guard let stream = httpBodyStream else { return nil }
        stream.open()
        defer { stream.close() }
        var data = Data()
        let bufferSize = 4096
        var buffer = [UInt8](repeating: 0, count: bufferSize)
        while stream.hasBytesAvailable {
            let read = stream.read(&buffer, maxLength: bufferSize)
            if read <= 0 { break }
            data.append(buffer, count: read)
        }
        return data.isEmpty ? nil : data
    }
}
