// SelfHostedCredentialStoreTests.swift — Keychain round-trip for self-hosted
// bearer tokens. Mirrors `SMBCredentialStoreTests`.
//
// These tests write to the real login Keychain. They clean up after themselves
// via `removeToken(forServerURL:)`, and XCTSkip on sandboxes where `SecItemAdd`
// returns an error (e.g. locked-down CI environments).

import XCTest
@testable import MapleCore

final class SelfHostedCredentialStoreTests: XCTestCase {

    /// Unique per-test URL so parallel runs don't stomp each other.
    private func makeURL(suffix: String = UUID().uuidString) -> URL {
        URL(string: "https://unit-test-\(suffix).local:3000")!
    }

    // MARK: Round trip

    func testSetAndFetchToken() async throws {
        let store = SelfHostedCredentialStore.shared
        let url = makeURL()
        let token = "bearer-token-\(UUID().uuidString)"

        do {
            try await store.setToken(token, forServerURL: url)
        } catch {
            // Keychain unavailable in this sandbox — skip, not fail.
            throw XCTSkip("Keychain not writeable: \(error)")
        }

        let fetched = await store.tokenForServerURL(url)
        XCTAssertEqual(fetched, token)

        try? await store.removeToken(forServerURL: url)
        let afterDelete = await store.tokenForServerURL(url)
        XCTAssertNil(afterDelete)
    }

    // MARK: Known-servers list

    func testKnownServersTracksSetRemove() async throws {
        let store = SelfHostedCredentialStore.shared
        let url = makeURL()

        do {
            try await store.setToken("t", forServerURL: url)
        } catch {
            throw XCTSkip("Keychain not writeable: \(error)")
        }

        let list = await store.knownServers()
        // Server-list comparison is tolerant of scheme/port differences —
        // only the host is keyed, but the URL list is what we enumerate.
        XCTAssertTrue(list.contains(url),
                      "knownServers should include the new entry, got \(list)")

        try? await store.removeToken(forServerURL: url)
        let listAfter = await store.knownServers()
        XCTAssertFalse(listAfter.contains(url),
                       "knownServers should drop the removed entry")
    }

    // MARK: Back-compat optional-token setter

    func testOptionalSetterNilRemovesToken() async throws {
        let store = SelfHostedCredentialStore.shared
        let url = makeURL()

        do {
            try await store.setToken("abc", forServerURL: url)
        } catch {
            throw XCTSkip("Keychain not writeable: \(error)")
        }

        await store.setToken(nil, forServerURL: url)
        let fetched = await store.tokenForServerURL(url)
        XCTAssertNil(fetched)
    }

    // MARK: Host-only keying

    /// Two URLs that differ only by path/scheme resolve to the same host —
    /// setting on one is visible via the other.
    func testHostKeyingIgnoresPath() async throws {
        let store = SelfHostedCredentialStore.shared
        let suffix = UUID().uuidString
        let urlA = URL(string: "https://hostkey-\(suffix).local:3000")!
        let urlB = URL(string: "https://hostkey-\(suffix).local:3000/api")!

        do {
            try await store.setToken("shared", forServerURL: urlA)
        } catch {
            throw XCTSkip("Keychain not writeable: \(error)")
        }

        let fetched = await store.tokenForServerURL(urlB)
        XCTAssertEqual(fetched, "shared")

        try? await store.removeToken(forServerURL: urlA)
    }
}
