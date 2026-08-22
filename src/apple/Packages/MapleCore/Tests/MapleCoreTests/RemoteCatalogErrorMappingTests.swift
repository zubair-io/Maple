// RemoteCatalogErrorMappingTests.swift
//
// Issue #2548 — RemoteCatalog's error mapping is overly generic: every
// unhandled non-2xx status threw a bare `URLError(.badServerResponse)`,
// which Finder can only present as an unclassified transport error.
// `RemoteCatalog.mapHTTPError(status:)` now maps the well-known cases
// (auth, not-found, collision, quota) to the matching
// `NSFileProviderError` code and all other statuses to the supported
// `.serverUnreachable` fallback.

import XCTest
import FileProvider
@testable import MapleCore

final class RemoteCatalogErrorMappingTests: XCTestCase {
    override func setUp() {
        super.setUp()
        StubURLProtocol.register()
        StubURLProtocol.reset()
    }
    override func tearDown() {
        StubURLProtocol.reset()
        super.tearDown()
    }

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

    private func assertFileProviderError(_ error: Error, code: NSFileProviderError.Code, line: UInt = #line) {
        let ns = error as NSError
        XCTAssertEqual(ns.domain, NSFileProviderErrorDomain, line: line)
        XCTAssertEqual(ns.code, code.rawValue, line: line)
    }

    // MARK: - Unit-level: the mapping function itself

    func testMapHTTPErrorMapsKnownStatuses() {
        assertFileProviderError(RemoteCatalog.mapHTTPError(status: 401), code: .notAuthenticated)
        assertFileProviderError(RemoteCatalog.mapHTTPError(status: 403), code: .notAuthenticated)
        assertFileProviderError(RemoteCatalog.mapHTTPError(status: 404), code: .noSuchItem)
        assertFileProviderError(RemoteCatalog.mapHTTPError(status: 409), code: .filenameCollision)
        assertFileProviderError(RemoteCatalog.mapHTTPError(status: 413), code: .insufficientQuota)
        assertFileProviderError(RemoteCatalog.mapHTTPError(status: 507), code: .insufficientQuota)
    }

    func testMapHTTPErrorFallsBackToSupportedFileProviderErrorForUnmappedStatuses() {
        let error = RemoteCatalog.mapHTTPError(status: 500)
        assertFileProviderError(error, code: .serverUnreachable)
    }

    // MARK: - Integration-level: a real call surfaces the mapped error

    func testListFoldersOn404SurfacesNoSuchItem() async throws {
        StubURLProtocol.handler = { _ in (404, Data(), [:]) }
        do {
            _ = try await makeCatalog().listFolders()
            XCTFail("expected an error")
        } catch {
            assertFileProviderError(error, code: .noSuchItem)
        }
    }

    /// The server doesn't emit 413 for uploads today (no quota
    /// enforcement is wired up yet — see `mapHTTPError`'s doc comment),
    /// but the client must already do the right thing when it does.
    func testUploadFileOn413SurfacesInsufficientQuota() async throws {
        let tmp = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        try Data("x".utf8).write(to: tmp)
        defer { try? FileManager.default.removeItem(at: tmp) }
        StubURLProtocol.handler = { _ in (413, Data(), [:]) }
        do {
            _ = try await makeCatalog().uploadFile(folderID: "f1", targetRelativePath: "a.dng", fileURL: tmp, mtime: nil)
            XCTFail("expected an error")
        } catch {
            assertFileProviderError(error, code: .insufficientQuota)
        }
    }

    func testUploadFileOn507SurfacesInsufficientQuota() async throws {
        let tmp = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        try Data("x".utf8).write(to: tmp)
        defer { try? FileManager.default.removeItem(at: tmp) }
        StubURLProtocol.handler = { _ in (507, Data(), [:]) }
        do {
            _ = try await makeCatalog().uploadFile(folderID: "f1", targetRelativePath: "a.dng", fileURL: tmp, mtime: nil)
            XCTFail("expected an error")
        } catch {
            assertFileProviderError(error, code: .insufficientQuota)
        }
    }

    func testMakeDirOnUnexpectedStatusSurfacesMappedError() async throws {
        StubURLProtocol.handler = { _ in (404, Data(), [:]) }
        do {
            _ = try await makeCatalog().makeDir(folderID: "f1", targetRelativePath: "sub")
            XCTFail("expected an error")
        } catch {
            assertFileProviderError(error, code: .noSuchItem)
        }
    }

    func testMoveFolderOnUnexpectedStatusSurfacesMappedError() async throws {
        StubURLProtocol.handler = { _ in (404, Data(), [:]) }
        do {
            _ = try await makeCatalog().moveFolder(folderID: "f1", sourceRelativePath: "a", targetRelativePath: "b")
            XCTFail("expected an error")
        } catch {
            assertFileProviderError(error, code: .noSuchItem)
        }
    }
}
