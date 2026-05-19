// FileProviderTokensStoreTests.swift — round-trip + legacy-keychain
// migration coverage for the file-provider tokens store.
//
// These tests write to the real keychain. Each case uses a
// UUID-suffixed `serviceBase` so leaked entries don't collide with
// real Maple items, and tears down both the new and legacy items in
// `tearDown`. Skips with `XCTSkip` when the runner can't write to the
// data-protection keychain — that backend requires entitlements that
// host-less `swift test` bundles don't carry (-34018
// errSecMissingEntitlement). Same items run inside the Xcode app
// target carry the shared-keychain entitlement and pass without skip.

import XCTest
import Security
@testable import MapleCore

final class FileProviderTokensStoreTests: XCTestCase {
    private var serviceBase: String!
    private var store: FileProviderTokensStore!

    override func setUp() {
        super.setUp()
        serviceBase = "app.justmaple.aperture.fileprovider.test.\(UUID().uuidString)"
        // `accessGroup: nil` so the test doesn't need the shared-
        // keychain entitlement (absent in plain `swift test` runs).
        store = FileProviderTokensStore(serviceBase: serviceBase, accessGroup: nil)
    }

    override func tearDown() {
        // Wipe both new (data-protection) and legacy (no flag) entries
        // for every domain this test might have touched. Either backend
        // can hold leftovers if the test crashed mid-flight.
        for domain in ["d1", "legacy-domain"] {
            let service = "\(serviceBase!).\(domain)"
            let newQuery: [CFString: Any] = [
                kSecClass: kSecClassGenericPassword,
                kSecAttrService: service,
                kSecUseDataProtectionKeychain: true,
            ]
            SecItemDelete(newQuery as CFDictionary)
            let legacyQuery: [CFString: Any] = [
                kSecClass: kSecClassGenericPassword,
                kSecAttrService: service,
            ]
            SecItemDelete(legacyQuery as CFDictionary)
        }
        super.tearDown()
    }

    func testRoundTrip() throws {
        try skipIfDataProtectionUnavailable()
        let tokens = AuthTokens(access: "a", refresh: "r")
        store.save(tokens, domain: "d1")
        let loaded = try XCTUnwrap(store.load(domain: "d1"))
        XCTAssertEqual(loaded.access, "a")
        XCTAssertEqual(loaded.refresh, "r")
    }

    /// Pre-PR-#79 the tokens were written without
    /// `kSecUseDataProtectionKeychain`. Seed a legacy-shaped item and
    /// confirm `load` finds it, copies it into data-protection storage,
    /// then deletes the legacy entry.
    func testMigratesLegacyKeychainEntry() throws {
        try skipIfDataProtectionUnavailable()
        let tokens = AuthTokens(access: "legacy-access", refresh: "legacy-refresh")
        let service = "\(serviceBase!).legacy-domain"
        let data = try JSONEncoder().encode(tokens)
        // Seed with the legacy shape (no `kSecUseDataProtectionKeychain`).
        let legacyAdd: [CFString: Any] = [
            kSecClass: kSecClassGenericPassword,
            kSecAttrService: service,
            kSecValueData: data,
            kSecAttrAccessible: kSecAttrAccessibleAfterFirstUnlock,
        ]
        let addStatus = SecItemAdd(legacyAdd as CFDictionary, nil)
        guard addStatus == errSecSuccess else {
            throw XCTSkip("Keychain not writeable for legacy seed (OSStatus \(addStatus))")
        }

        // Load via the new store — should migrate transparently.
        let loaded = try XCTUnwrap(store.load(domain: "legacy-domain"))
        XCTAssertEqual(loaded.access, "legacy-access")
        XCTAssertEqual(loaded.refresh, "legacy-refresh")

        // The new (data-protection) backend now has the entry.
        let newQuery: [CFString: Any] = [
            kSecClass: kSecClassGenericPassword,
            kSecAttrService: service,
            kSecUseDataProtectionKeychain: true,
            kSecReturnData: true,
            kSecMatchLimit: kSecMatchLimitOne,
        ]
        var newRef: AnyObject?
        let newStatus = SecItemCopyMatching(newQuery as CFDictionary, &newRef)
        XCTAssertEqual(newStatus, errSecSuccess, "new backend should hold migrated entry")
        let newData = try XCTUnwrap(newRef as? Data)
        let newTokens = try JSONDecoder().decode(AuthTokens.self, from: newData)
        XCTAssertEqual(newTokens, tokens)

        // The legacy entry is gone — migration cleared it.
        let legacyCheck: [CFString: Any] = [
            kSecClass: kSecClassGenericPassword,
            kSecAttrService: service,
            kSecReturnData: true,
            kSecMatchLimit: kSecMatchLimitOne,
        ]
        var legacyRef: AnyObject?
        let legacyStatus = SecItemCopyMatching(legacyCheck as CFDictionary, &legacyRef)
        XCTAssertEqual(legacyStatus, errSecItemNotFound,
                       "legacy entry should be cleared after successful migration")
    }

    // MARK: helpers

    /// Skip when the runner can't write to the data-protection
    /// keychain. Mirrors the SMBCredentialStore pattern — soft pass
    /// instead of red CI. On macOS, host-less swift-test bundles get
    /// -34018 errSecMissingEntitlement because data-protection
    /// requires an explicit entitlement; the Xcode app target carries
    /// it and runs the body.
    private func skipIfDataProtectionUnavailable() throws {
        let probeService = "\(serviceBase!).probe-\(UUID().uuidString)"
        let add: [CFString: Any] = [
            kSecClass: kSecClassGenericPassword,
            kSecAttrService: probeService,
            kSecValueData: Data([0xFF]),
            kSecAttrAccessible: kSecAttrAccessibleAfterFirstUnlock,
            kSecUseDataProtectionKeychain: true,
        ]
        let status = SecItemAdd(add as CFDictionary, nil)
        defer {
            let del: [CFString: Any] = [
                kSecClass: kSecClassGenericPassword,
                kSecAttrService: probeService,
                kSecUseDataProtectionKeychain: true,
            ]
            SecItemDelete(del as CFDictionary)
        }
        if status != errSecSuccess {
            throw XCTSkip("data-protection keychain unavailable (OSStatus \(status)) — likely missing entitlement in plain `swift test`")
        }
    }
}
