// src/apple/Packages/MapleCore/Tests/MapleCoreTests/ApnsPushRegistrarTests.swift
//
// Unit tests for #1025's push-received / token-updated handling.
// `PKPushCredentials` and `PKPushPayload` have no public initializer, so
// these drive `ApnsPushRegistrar`'s testable seams
// (`handleTokenUpdate(_:)` / `handleIncomingPush(completion:)`) directly
// rather than the real `PKPushRegistryDelegate` methods, which are
// one-line wrappers around them — see that file's "Testable seams"
// section. Real PushKit delivery is untestable outside a real device with
// a production APNs key.

import FileProvider
import XCTest

@testable import MapleCore

final class ApnsPushRegistrarTests: XCTestCase {
    private func makeRegistrationClient(
        respond: @escaping (URLRequest) -> (Data, HTTPURLResponse)
    ) -> ApnsDeviceRegistrationClient {
        let server = URL(string: "https://maple.example.com")!
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

    /// A domain identifier not actually registered with the OS —
    /// `NSFileProviderManager(for:)` returns nil for it in the SwiftPM
    /// test sandbox (same reality `FileProviderMountTests
    /// .testDomainForServerReturnsNilWhenUnregistered` documents), so
    /// `handleIncomingPush` silently skips the real OS signal and this
    /// test instead asserts on the `onWake` hook — the seam that exists
    /// specifically because the real signal isn't observable here.
    private func testDomain() -> NSFileProviderDomain {
        NSFileProviderDomain(
            identifier: .init("test-domain-\(UUID().uuidString)"),
            displayName: "Test")
    }

    // MARK: - handleTokenUpdate

    func testHandleTokenUpdateRegistersWithTheServer() async throws {
        var captured: URLRequest?
        let registrationClient = makeRegistrationClient { req in
            captured = req
            return self.jsonResponse(req, status: 204)
        }
        let registrar = ApnsPushRegistrar(domain: testDomain(), registrationClient: registrationClient)

        await registrar.handleTokenUpdate("deadbeef")

        let req = try XCTUnwrap(captured)
        XCTAssertEqual(req.httpMethod, "POST")
        let body = try XCTUnwrap(URLProtocolStub.capturedBodies[req.url?.absoluteString ?? ""])
        let json = try XCTUnwrap(try JSONSerialization.jsonObject(with: body) as? [String: Any])
        XCTAssertEqual(json["device_token"] as? String, "deadbeef")
        let confirmed = await registrationClient.hasRegisteredSuccessfully
        XCTAssertTrue(confirmed)
    }

    func testHandleTokenUpdateSendsThePlatformThisProcessRunsOn() async throws {
        var captured: URLRequest?
        let registrationClient = makeRegistrationClient { req in
            captured = req
            return self.jsonResponse(req, status: 204)
        }
        let registrar = ApnsPushRegistrar(domain: testDomain(), registrationClient: registrationClient)
        await registrar.handleTokenUpdate("tok")

        let req = try XCTUnwrap(captured)
        let body = try XCTUnwrap(URLProtocolStub.capturedBodies[req.url?.absoluteString ?? ""])
        let json = try XCTUnwrap(try JSONSerialization.jsonObject(with: body) as? [String: Any])
        #if os(iOS)
            XCTAssertEqual(json["platform"] as? String, "ios")
        #else
            XCTAssertEqual(json["platform"] as? String, "macos")
        #endif
    }

    // MARK: - handleIncomingPush

    func testHandleIncomingPushInvokesOnWakeAndCompletion() async {
        let registrationClient = makeRegistrationClient { req in self.jsonResponse(req, status: 204) }
        let wakeCount = Box()
        let registrar = ApnsPushRegistrar(
            domain: testDomain(),
            registrationClient: registrationClient,
            onWake: { wakeCount.value += 1 }
        )

        // `completion` is called SYNCHRONOUSLY inside `handleIncomingPush`
        // (a plain call, not deferred to another Task), and this test
        // awaits `handleIncomingPush` itself — so by the time `await`
        // returns, both `onWake` and `completion` have already run. No
        // sleep/poll needed (a fixed sleep here would be exactly the kind
        // of timing-dependent flake risk `Box` avoids).
        let completionCalled = Box()
        await registrar.handleIncomingPush { completionCalled.value += 1 }

        XCTAssertEqual(wakeCount.value, 1)
        XCTAssertEqual(completionCalled.value, 1)
    }

    func testHandleIncomingPushCallsCompletionEvenWithoutAnOnWakeHook() async {
        // The PushKit contract requires completion() to be called
        // regardless of whether the caller supplied an onWake hook —
        // failing to call it eventually gets the extension killed for a
        // hung push delivery.
        let registrationClient = makeRegistrationClient { req in self.jsonResponse(req, status: 204) }
        let registrar = ApnsPushRegistrar(domain: testDomain(), registrationClient: registrationClient)

        let completionCalled = Box()
        await registrar.handleIncomingPush { completionCalled.value += 1 }

        XCTAssertEqual(completionCalled.value, 1)
    }
}

/// Minimal mutable reference box for closures to write into. Safe without
/// actor isolation here because every write happens synchronously within
/// the single `await handleIncomingPush(...)` call each test makes — see
/// that call's doc comment above for why no `Task`/sleep is needed either.
private final class Box: @unchecked Sendable {
    var value = 0
}
