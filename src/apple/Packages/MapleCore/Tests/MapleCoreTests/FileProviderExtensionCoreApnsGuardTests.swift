// src/apple/Packages/MapleCore/Tests/MapleCoreTests/FileProviderExtensionCoreApnsGuardTests.swift
//
// Regression tests for the invalidate()-vs-APNs-confirmation race
// (Copilot review on #3246): before this fix, `invalidate()` had no way
// to stop the confirmation task it hadn't tracked, so a confirmation that
// was already past its network waits when `invalidate()` ran could still
// go on to stop `changeFeed` and start `apnsMonitorTask` — AFTER teardown.
//
// `apnsConfirmedAndNotInvalidated(registrationClient:)` holds the entire
// guarded decision in terms of a registration client these tests CAN
// fake — `init(domain:)`'s real call site can't be driven directly since
// it reads live TokenStore/FileProviderConfig state (same reasoning as
// `ApnsPushRegistrarTests`'s use of `handleTokenUpdate`/
// `handleIncomingPush`).

import XCTest
import FileProvider
@testable import MapleCore

final class FileProviderExtensionCoreApnsGuardTests: XCTestCase {
    private func makeDormantCore() -> FileProviderExtensionCore {
        FileProviderExtensionCore(
            domain: NSFileProviderDomain(
                identifier: .init("test-domain-\(UUID().uuidString)"),
                displayName: "Test"),
            dormant: true,
            catalog: nil,
            rootCache: nil,
            deviceName: "test-device",
            metaStore: nil,
            workingSet: WorkingSet(capacity: WorkingSet.defaultCapacity),
            cursorStore: ChangeCursorStore(directory: nil),
            workingSetListCache: nil)
    }

    private func makeConfirmedRegistrationClient() -> ApnsDeviceRegistrationClient {
        let server = URL(string: "https://maple.example.com")!
        let session = URLSession.stubbedSequence { req in
            // GET /api/apns/config returns 200 with a JSON body (Elysia's
            // default for a returned object — see
            // src/api/src/routes/apns-config.ts); POST /api/apns/devices
            // (the register() call) returns 204 No Content with an empty
            // body — using the status each real endpoint actually sends,
            // rather than 204 for both, per Copilot review on #3246.
            if req.url?.path == "/api/apns/config" {
                let body: [String: Any] = ["enabled": true, "credentials_configured": true]
                let data = (try? JSONSerialization.data(withJSONObject: body)) ?? Data()
                let resp = HTTPURLResponse(
                    url: req.url!, statusCode: 200, httpVersion: "HTTP/1.1", headerFields: nil)!
                return (data, resp)
            }
            let resp = HTTPURLResponse(
                url: req.url!, statusCode: 204, httpVersion: "HTTP/1.1", headerFields: nil)!
            return (Data(), resp)
        }
        let http = AuthenticatedHTTPClient.unauthenticated(server: server, urlSession: session)
        return ApnsDeviceRegistrationClient(server: server, http: http)
    }

    func testReturnsTrueWhenConfirmedAndNotInvalidated() async {
        let core = makeDormantCore()
        let registrationClient = makeConfirmedRegistrationClient()
        // Registration itself is a separate call from isServerPushConfigured
        // / waitUntilRegistered — drive it first so hasRegisteredSuccessfully
        // is already true when the guard method awaits it.
        await registrationClient.register(deviceToken: "a1".repeated(32), platform: "ios", environment: .sandbox)

        let confirmed = await core.apnsConfirmedAndNotInvalidated(registrationClient: registrationClient)
        XCTAssertTrue(confirmed)
    }

    func testReturnsFalseWhenInvalidatedBeforeTheGuardRuns() async {
        // The regression case: invalidate() has ALREADY run by the time
        // apnsConfirmedAndNotInvalidated does its final isInvalidated
        // check — simulating a confirmation that was in-flight (past its
        // network waits, about to act) exactly when invalidate() landed.
        let core = makeDormantCore()
        let registrationClient = makeConfirmedRegistrationClient()
        await registrationClient.register(deviceToken: "b2".repeated(32), platform: "ios", environment: .sandbox)

        core.invalidate()

        let confirmed = await core.apnsConfirmedAndNotInvalidated(registrationClient: registrationClient)
        XCTAssertFalse(confirmed)
    }

    func testReturnsFalseWhenServerPushIsNotConfigured() async {
        let core = makeDormantCore()
        let server = URL(string: "https://maple.example.com")!
        let session = URLSession.stubbedSequence { req in
            let body: [String: Any] = ["enabled": false, "credentials_configured": false]
            let data = (try? JSONSerialization.data(withJSONObject: body)) ?? Data()
            let resp = HTTPURLResponse(
                url: req.url!, statusCode: 200, httpVersion: "HTTP/1.1", headerFields: nil)!
            return (data, resp)
        }
        let http = AuthenticatedHTTPClient.unauthenticated(server: server, urlSession: session)
        let registrationClient = ApnsDeviceRegistrationClient(server: server, http: http)

        let confirmed = await core.apnsConfirmedAndNotInvalidated(registrationClient: registrationClient)
        XCTAssertFalse(confirmed)
    }

}

extension String {
    fileprivate func repeated(_ times: Int) -> String {
        String(repeating: self, count: times)
    }
}
