// Tests/MapleBackupTests/GeocodeClientTests.swift
import XCTest
@testable import MapleBackup

final class GeocodeClientTests: XCTestCase {
    override func setUp() {
        StubURLProtocol.stub = nil
    }
    override func tearDown() {
        StubURLProtocol.stub = nil
    }

    func testReturnsPoiNameWhenPresent() async throws {
        StubURLProtocol.stub = .ok(json: """
        {"place":{"pois":[{"name":"Tokyo Station","category":"public_transport","type":"station"}],
                  "rollups":{"locality":"Tokyo"}}}
        """)
        let client = GeocodeClient(baseURL: URL(string: "https://server.example")!,
                                   session: stubSession())
        let loc = try await client.lookup(lat: 35.68, lon: 139.69)
        XCTAssertEqual(loc, "Tokyo Station")
    }

    func testFallsBackToLocalityWhenPoisEmpty() async throws {
        StubURLProtocol.stub = .ok(json: """
        {"place":{"pois":[],"rollups":{"locality":"Tokyo"}}}
        """)
        let client = GeocodeClient(baseURL: URL(string: "https://server.example")!,
                                   session: stubSession())
        let loc = try await client.lookup(lat: 0, lon: 0)
        XCTAssertEqual(loc, "Tokyo")
    }

    func testReturnsNilWhenBothEmpty() async throws {
        StubURLProtocol.stub = .ok(json: """
        {"place":{"pois":[],"rollups":{"locality":null}}}
        """)
        let client = GeocodeClient(baseURL: URL(string: "https://server.example")!,
                                   session: stubSession())
        let result = try await client.lookup(lat: 0, lon: 0)
        XCTAssertNil(result)
    }

    func testReturnsNilOn404() async throws {
        StubURLProtocol.stub = .status(404, json: #"{"error":"not in cache"}"#)
        let client = GeocodeClient(baseURL: URL(string: "https://server.example")!,
                                   session: stubSession())
        let result = try await client.lookup(lat: 0, lon: 0)
        XCTAssertNil(result)
    }

    func testReturnsNilOnUnexpectedStatus() async throws {
        StubURLProtocol.stub = .status(500)
        let client = GeocodeClient(baseURL: URL(string: "https://server.example")!,
                                   session: stubSession())
        let result = try await client.lookup(lat: 0, lon: 0)
        XCTAssertNil(result)
    }

    func testThrowsOnNetworkError() async throws {
        StubURLProtocol.stub = .networkError(.notConnectedToInternet)
        let client = GeocodeClient(baseURL: URL(string: "https://server.example")!,
                                   session: stubSession())
        do {
            _ = try await client.lookup(lat: 0, lon: 0)
            XCTFail("expected throw")
        } catch {
            // Network errors propagate so the engine can retry with backoff.
        }
    }
}
