// src/apple/Packages/MapleCore/Tests/MapleCoreTests/ApnsDeviceRegistrationClientTests.swift
//
// Unit tests for the Apple-side half of #1025's APNs push-to-signal
// registration. Real APNs delivery — a device actually receiving a push —
// cannot be tested outside a real device with a production APNs key
// (per the ticket). What CAN be tested, and is tested here: the exact
// requests this client builds, how it interprets the server's responses,
// and its `hasRegisteredSuccessfully` / `waitUntilRegistered` state
// machine, all against `URLProtocolStub` — mirrors
// `ChangeFeedClientServerMigrationTests`'s use of the same stub.

import XCTest

@testable import MapleCore

final class ApnsDeviceRegistrationClientTests: XCTestCase {
    private func makeClient(
        server: URL = URL(string: "https://maple.example.com")!,
        respond: @escaping (URLRequest) -> (Data, HTTPURLResponse)
    ) -> ApnsDeviceRegistrationClient {
        let session = URLSession.stubbedSequence(respond)
        let http = AuthenticatedHTTPClient.unauthenticated(server: server, urlSession: session)
        return ApnsDeviceRegistrationClient(server: server, http: http)
    }

    private func jsonResponse(_ req: URLRequest, status: Int, body: [String: Any] = [:]) -> (
        Data, HTTPURLResponse
    ) {
        let data = (try? JSONSerialization.data(withJSONObject: body)) ?? Data()
        let resp = HTTPURLResponse(
            url: req.url!, statusCode: status,
            httpVersion: "HTTP/1.1", headerFields: nil)!
        return (data, resp)
    }

    // MARK: - register

    func testRegisterPostsToDevicesEndpointWithExpectedBody() async throws {
        var captured: URLRequest?
        let client = makeClient { req in
            captured = req
            return self.jsonResponse(req, status: 204)
        }
        await client.register(deviceToken: "abcd1234", platform: "ios", environment: .sandbox)

        let req = try XCTUnwrap(captured)
        XCTAssertEqual(req.httpMethod, "POST")
        XCTAssertEqual(req.url?.path, "/api/apns/devices")
        let body = try XCTUnwrap(URLProtocolStub.capturedBodies[req.url?.absoluteString ?? ""])
        let json = try XCTUnwrap(try JSONSerialization.jsonObject(with: body) as? [String: Any])
        XCTAssertEqual(json["device_token"] as? String, "abcd1234")
        XCTAssertEqual(json["platform"] as? String, "ios")
        XCTAssertEqual(json["environment"] as? String, "sandbox")
    }

    func testRegisterSetsHasRegisteredSuccessfullyOn2xx() async {
        let client = makeClient { req in self.jsonResponse(req, status: 204) }
        let before = await client.hasRegisteredSuccessfully
        XCTAssertFalse(before)
        await client.register(deviceToken: "tok", platform: "ios", environment: .production)
        let after = await client.hasRegisteredSuccessfully
        XCTAssertTrue(after)
    }

    func testRegisterDoesNotSetHasRegisteredSuccessfullyOnFailure() async {
        let client = makeClient { req in
            self.jsonResponse(
                req, status: 400, body: ["error": "device_token must be a hex-encoded APNs token"])
        }
        await client.register(deviceToken: "tok", platform: "ios", environment: .production)
        let after = await client.hasRegisteredSuccessfully
        XCTAssertFalse(after)
    }

    func testRegisterFailureIsNotFatal() async {
        // A transport-level failure must not throw out of `register` —
        // it's a fire-and-forget best-effort call (see the doc comment).
        let session = URLSession.stubbedSequence(
            errorProvider: { _ in URLError(.notConnectedToInternet) },
            { req in self.jsonResponse(req, status: 200) }
        )
        let http = AuthenticatedHTTPClient.unauthenticated(
            server: URL(string: "https://maple.example.com")!, urlSession: session)
        let client = ApnsDeviceRegistrationClient(
            server: URL(string: "https://maple.example.com")!, http: http)
        await client.register(deviceToken: "tok", platform: "ios", environment: .sandbox)
        let after = await client.hasRegisteredSuccessfully
        XCTAssertFalse(after)
    }

    // MARK: - unregister

    func testUnregisterSendsDeleteWithDeviceToken() async throws {
        var captured: URLRequest?
        let client = makeClient { req in
            captured = req
            return self.jsonResponse(req, status: 204)
        }
        await client.unregister(deviceToken: "dead-token")

        let req = try XCTUnwrap(captured)
        XCTAssertEqual(req.httpMethod, "DELETE")
        XCTAssertEqual(req.url?.path, "/api/apns/devices")
        let body = try XCTUnwrap(URLProtocolStub.capturedBodies[req.url?.absoluteString ?? ""])
        let json = try XCTUnwrap(try JSONSerialization.jsonObject(with: body) as? [String: Any])
        XCTAssertEqual(json["device_token"] as? String, "dead-token")
    }

    // MARK: - updateServer

    func testUpdateServerMigratesSubsequentRequests() async throws {
        var hosts: [String] = []
        let identity = URL(string: "https://maple.example.com")!
        let session = URLSession.stubbedSequence { req in
            hosts.append(req.url?.host ?? "")
            return self.jsonResponse(req, status: 204)
        }
        let http = AuthenticatedHTTPClient.unauthenticated(server: identity, urlSession: session)
        let client = ApnsDeviceRegistrationClient(server: identity, http: http)

        await client.register(deviceToken: "tok", platform: "ios", environment: .sandbox)
        await client.updateServer(URL(string: "http://192.168.1.50:8080")!)
        await client.register(deviceToken: "tok", platform: "ios", environment: .sandbox)

        XCTAssertEqual(hosts, ["maple.example.com", "192.168.1.50"])
    }

    // MARK: - isServerPushConfigured

    func testIsServerPushConfiguredTrueWhenEnabledAndCredentialed() async {
        let client = makeClient { req in
            self.jsonResponse(req, status: 200, body: ["enabled": true, "credentials_configured": true])
        }
        let result = await client.isServerPushConfigured()
        XCTAssertTrue(result)
    }

    func testIsServerPushConfiguredFalseWhenEnabledButNoCredentials() async {
        let client = makeClient { req in
            self.jsonResponse(req, status: 200, body: ["enabled": true, "credentials_configured": false])
        }
        let result = await client.isServerPushConfigured()
        XCTAssertFalse(result)
    }

    func testIsServerPushConfiguredFalseWhenDisabled() async {
        let client = makeClient { req in
            self.jsonResponse(req, status: 200, body: ["enabled": false, "credentials_configured": true])
        }
        let result = await client.isServerPushConfigured()
        XCTAssertFalse(result)
    }

    func testIsServerPushConfiguredFalseOnNon2xx() async {
        let client = makeClient { req in self.jsonResponse(req, status: 500) }
        let result = await client.isServerPushConfigured()
        XCTAssertFalse(result)
    }

    func testIsServerPushConfiguredFalseOnTransportFailure() async {
        let session = URLSession.stubbedSequence(
            errorProvider: { _ in URLError(.notConnectedToInternet) },
            { req in self.jsonResponse(req, status: 200) }
        )
        let server = URL(string: "https://maple.example.com")!
        let http = AuthenticatedHTTPClient.unauthenticated(server: server, urlSession: session)
        let client = ApnsDeviceRegistrationClient(server: server, http: http)
        let result = await client.isServerPushConfigured()
        XCTAssertFalse(result)
    }

    // MARK: - waitUntilRegistered

    func testWaitUntilRegisteredReturnsImmediatelyWhenAlreadyRegistered() async {
        let client = makeClient { req in self.jsonResponse(req, status: 204) }
        await client.register(deviceToken: "tok", platform: "ios", environment: .sandbox)
        let confirmed = await client.waitUntilRegistered(pollIntervalMs: 10, timeoutMs: 50)
        XCTAssertTrue(confirmed)
    }

    func testWaitUntilRegisteredObservesARegistrationThatCompletesDuringTheWait() async {
        let client = makeClient { req in self.jsonResponse(req, status: 204) }
        async let confirmed = client.waitUntilRegistered(pollIntervalMs: 10, timeoutMs: 500)
        // Register slightly after the wait has started polling.
        try? await Task.sleep(nanoseconds: 30_000_000)
        await client.register(deviceToken: "tok", platform: "ios", environment: .sandbox)
        let result = await confirmed
        XCTAssertTrue(result)
    }

    func testWaitUntilRegisteredTimesOutWhenNeverRegistered() async {
        let client = makeClient { req in self.jsonResponse(req, status: 500) }
        let confirmed = await client.waitUntilRegistered(pollIntervalMs: 10, timeoutMs: 50)
        XCTAssertFalse(confirmed)
    }
}
