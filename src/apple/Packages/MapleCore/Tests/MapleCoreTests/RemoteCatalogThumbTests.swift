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
        let bytes = try await catalog.getThumb(assetID: "650a")
        XCTAssertEqual(observedPath, "/api/assets/650a/thumb")
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
            _ = try await catalog.getThumb(assetID: "missing")
            XCTFail("expected throw")
        } catch {
            // pass — any throw is fine; QL caller treats it as "fall back"
        }
    }
}
