// src/apple/Packages/MapleCore/Tests/MapleCoreTests/RemoteCatalogDeleteAssetTests.swift
import XCTest
@testable import MapleCore

/// #2543 — deleteAsset skipped the `validateAssetID` guard its sibling
/// methods (downloadAsset, getThumb, getXMP, deleteXMP, renameAsset,
/// relocateAsset) all perform. Since `assetID` is interpolated directly
/// into the request path, an unvalidated ID lets a path-traversal-shaped
/// string (`../../etc/passwd`) reach `URLRequest` construction — mirrors
/// the same regression guard `RemoteCatalogThumbTests
/// .testGetThumbRejectsPathTraversalBeforeRequest` uses for `getThumb`.
final class RemoteCatalogDeleteAssetTests: XCTestCase {
    func testDeleteAssetRejectsPathTraversalBeforeRequest() async {
        let server = URL(string: "https://example.test")!
        var observedPath: String?
        let session = URLSession.stubbedSequence { req in
            observedPath = req.url?.path
            let resp = HTTPURLResponse(url: req.url!, statusCode: 200,
                                       httpVersion: "HTTP/1.1", headerFields: nil)!
            return (Data(), resp)
        }
        let http = AuthenticatedHTTPClient.unauthenticated(server: server,
                                                            urlSession: session)
        let catalog = RemoteCatalog(http: http, server: server)
        do {
            _ = try await catalog.deleteAsset(assetID: "../../etc/passwd")
            XCTFail("expected InvalidAssetIDError")
        } catch let err as InvalidAssetIDError {
            XCTAssertEqual(err.assetID, "../../etc/passwd")
        } catch {
            XCTFail("expected InvalidAssetIDError, got \(error)")
        }
        XCTAssertNil(observedPath, "validator should have prevented any HTTP request")
    }

    func testDeleteAssetRejectsShortID() async {
        let server = URL(string: "https://example.test")!
        let session = URLSession.stubbedSequence { _ in
            XCTFail("no HTTP request should fire for an invalid ID")
            return (Data(), HTTPURLResponse())
        }
        let http = AuthenticatedHTTPClient.unauthenticated(server: server,
                                                            urlSession: session)
        let catalog = RemoteCatalog(http: http, server: server)
        do {
            _ = try await catalog.deleteAsset(assetID: "650a")
            XCTFail("expected InvalidAssetIDError")
        } catch is InvalidAssetIDError {
            // pass
        } catch {
            XCTFail("expected InvalidAssetIDError, got \(error)")
        }
    }

    func testDeleteAssetHappyPathStillWorks() async throws {
        let server = URL(string: "https://example.test")!
        let id = "650a1b2c3d4e5f6071829304"
        var observedPath: String?
        var observedMethod: String?
        let session = URLSession.stubbedSequence { req in
            observedPath = req.url?.path
            observedMethod = req.httpMethod
            let resp = HTTPURLResponse(url: req.url!, statusCode: 200,
                                       httpVersion: "HTTP/1.1", headerFields: nil)!
            return (Data(), resp)
        }
        let http = AuthenticatedHTTPClient.unauthenticated(server: server,
                                                            urlSession: session)
        let catalog = RemoteCatalog(http: http, server: server)
        let result = try await catalog.deleteAsset(assetID: id)
        XCTAssertEqual(result, .ok)
        XCTAssertEqual(observedPath, "/api/assets/\(id)")
        XCTAssertEqual(observedMethod, "DELETE")
    }
}
