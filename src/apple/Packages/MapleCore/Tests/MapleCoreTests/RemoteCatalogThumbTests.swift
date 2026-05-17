// src/apple/Packages/MapleCore/Tests/MapleCoreTests/RemoteCatalogThumbTests.swift
import XCTest
@testable import MapleCore

final class RemoteCatalogThumbTests: XCTestCase {
    func testGetThumbHappyPath() async throws {
        let server = URL(string: "https://example.test")!
        let jpegBytes = Data([0xFF, 0xD8, 0xFF, 0xE0, 0x00, 0x10])
        var observedPath: String?
        let session = URLSession.stubbedSequence { req in
            observedPath = req.url?.path
            let resp = HTTPURLResponse(url: req.url!, statusCode: 200,
                                       httpVersion: "HTTP/1.1",
                                       headerFields: ["Content-Type": "image/jpeg"])!
            return (jpegBytes, resp)
        }
        let http = AuthenticatedHTTPClient.unauthenticated(server: server,
                                                            urlSession: session)
        let catalog = RemoteCatalog(http: http, server: server)
        let id = "650a1b2c3d4e5f6071829304"
        let bytes = try await catalog.getThumb(assetID: id)
        XCTAssertEqual(observedPath, "/api/assets/\(id)/thumb")
        XCTAssertEqual(bytes.prefix(4), Data([0xFF, 0xD8, 0xFF, 0xE0]))
    }

    func testGetThumb404Throws() async {
        let server = URL(string: "https://example.test")!
        let session = URLSession.stubbedSequence { req in
            let resp = HTTPURLResponse(url: req.url!, statusCode: 404,
                                       httpVersion: "HTTP/1.1",
                                       headerFields: nil)!
            return (Data(), resp)
        }
        let http = AuthenticatedHTTPClient.unauthenticated(server: server,
                                                            urlSession: session)
        let catalog = RemoteCatalog(http: http, server: server)
        do {
            // Valid-shape ID that the stub will return 404 for.
            _ = try await catalog.getThumb(assetID: "deadbeefdeadbeefdeadbeef")
            XCTFail("expected throw")
        } catch {
            // pass — any throw is fine; QL caller treats it as "fall back"
        }
    }

    /// The validator must run BEFORE any URL is built or HTTP request
    /// fired. We assert this by passing a path-traversal attempt: if the
    /// validator is silently removed the stub session gets a request and
    /// `observedPath` is set; with the validator in place no request
    /// fires and `observedPath` stays nil.
    func testGetThumbRejectsPathTraversalBeforeRequest() async {
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
            _ = try await catalog.getThumb(assetID: "../../etc/passwd")
            XCTFail("expected InvalidAssetIDError")
        } catch let err as InvalidAssetIDError {
            XCTAssertEqual(err.assetID, "../../etc/passwd")
        } catch {
            XCTFail("expected InvalidAssetIDError, got \(error)")
        }
        XCTAssertNil(observedPath, "validator should have prevented any HTTP request")
    }

    func testGetThumbRejectsShortID() async {
        let server = URL(string: "https://example.test")!
        let session = URLSession.stubbedSequence { _ in
            XCTFail("no HTTP request should fire for an invalid ID")
            return (Data(), HTTPURLResponse())
        }
        let http = AuthenticatedHTTPClient.unauthenticated(server: server,
                                                            urlSession: session)
        let catalog = RemoteCatalog(http: http, server: server)
        do {
            _ = try await catalog.getThumb(assetID: "650a")
            XCTFail("expected InvalidAssetIDError")
        } catch is InvalidAssetIDError {
            // pass
        } catch {
            XCTFail("expected InvalidAssetIDError, got \(error)")
        }
    }

    func testGetThumbRejectsNonHexID() async {
        let server = URL(string: "https://example.test")!
        let session = URLSession.stubbedSequence { _ in
            XCTFail("no HTTP request should fire for an invalid ID")
            return (Data(), HTTPURLResponse())
        }
        let http = AuthenticatedHTTPClient.unauthenticated(server: server,
                                                            urlSession: session)
        let catalog = RemoteCatalog(http: http, server: server)
        do {
            // 24 chars but contains non-hex `z`.
            _ = try await catalog.getThumb(assetID: "zzzzzzzzzzzzzzzzzzzzzzzz")
            XCTFail("expected InvalidAssetIDError")
        } catch is InvalidAssetIDError {
            // pass
        } catch {
            XCTFail("expected InvalidAssetIDError, got \(error)")
        }
    }

    func testValidateAssetIDAcceptsLowerAndUpperHex() throws {
        try RemoteCatalog.validateAssetID("650a1b2c3d4e5f6071829304")
        try RemoteCatalog.validateAssetID("ABCDEF0123456789abcdef01")
    }
}
