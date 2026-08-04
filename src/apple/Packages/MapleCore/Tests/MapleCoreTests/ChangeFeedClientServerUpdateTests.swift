// src/apple/Packages/MapleCore/Tests/MapleCoreTests/ChangeFeedClientServerUpdateTests.swift
import XCTest
@testable import MapleCore

/// Covers `ChangeFeedClient.updateServer(_:)` (Apple audit #2533).
///
/// `RemoteCatalog` starts on the configured identity URL and migrates to
/// the server's resolved LAN address once `FileProviderExtensionCore.init`
/// finds one — every normal request (folders/thumbs/downloads/xmp/uploads)
/// then goes out over the LAN. `ChangeFeedClient`'s SSE connection URL
/// never got that update: it stayed on the identity URL forever, which
/// could mean the change feed never connects at all on a LAN-only
/// self-hosted deployment while every other request works fine.
final class ChangeFeedClientServerUpdateTests: XCTestCase {

    private func makeClient(server: URL, tmpDir: URL) -> ChangeFeedClient {
        let http = AuthenticatedHTTPClient.unauthenticated(
            server: server, urlSession: URLSession.stubbedSequence { req in
                let resp = HTTPURLResponse(url: req.url!, statusCode: 200,
                                           httpVersion: "HTTP/1.1", headerFields: nil)!
                return (Data(), resp)
            })
        return ChangeFeedClient(
            server: server,
            http: http,
            cursorStore: ChangeCursorStore(directory: tmpDir),
            domainID: "test-domain",
            onEvent: { _ in }
        )
    }

    func testUpdateServerReplacesTheURLSubsequentConnectionsUse() throws {
        let tmpDir = FileManager.default.temporaryDirectory
            .appendingPathComponent("cf-server-update-\(UUID().uuidString)")
        let identity = URL(string: "https://myserver.example.test")!
        let lan = URL(string: "http://192.168.1.42:3000")!
        let client = makeClient(server: identity, tmpDir: tmpDir)

        XCTAssertEqual(client.server, identity)
        client.updateServer(lan)
        XCTAssertEqual(client.server, lan,
            "updateServer must replace the URL the SSE connection uses, mirroring RemoteCatalog.updateServer")
    }

    func testUpdateServerIsSafeToCallConcurrentlyWithReads() throws {
        let tmpDir = FileManager.default.temporaryDirectory
            .appendingPathComponent("cf-server-update-\(UUID().uuidString)")
        let identity = URL(string: "https://myserver.example.test")!
        let client = makeClient(server: identity, tmpDir: tmpDir)

        let iterations = 500
        DispatchQueue.concurrentPerform(iterations: iterations) { i in
            if i.isMultiple(of: 2) {
                client.updateServer(URL(string: "http://192.168.1.\(i % 255):3000")!)
            } else {
                _ = client.server
            }
        }
        // No crash / data race under TSan is the assertion; the final
        // value just needs to be one of the URLs that was set.
        XCTAssertTrue(client.server.absoluteString.contains("192.168.1.") ||
                      client.server == identity)
    }
}
