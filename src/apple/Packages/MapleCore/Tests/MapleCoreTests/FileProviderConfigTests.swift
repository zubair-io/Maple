import XCTest
@testable import MapleCore

final class FileProviderConfigTests: XCTestCase {
    func testRoundTrip() throws {
        let tmp = URL(fileURLWithPath: NSTemporaryDirectory())
            .appendingPathComponent("fp-config-test-\(UUID().uuidString)", isDirectory: true)
        defer { try? FileManager.default.removeItem(at: tmp) }
        let store = FileProviderConfig(directory: tmp)
        XCTAssertNil(store.load(domain: "d1"))
        store.save(.init(domainIdentifier: "d1",
                         displayName: "My Server",
                         serverURL: URL(string: "https://example.com")!))
        let loaded = try XCTUnwrap(store.load(domain: "d1"))
        XCTAssertEqual(loaded.displayName, "My Server")
        XCTAssertEqual(loaded.serverURL, URL(string: "https://example.com")!)
        store.remove(domain: "d1")
        XCTAssertNil(store.load(domain: "d1"))
    }

    /// Pre-PR-#79 the domain config was persisted in
    /// `UserDefaults(suiteName: appGroupSuiteName)` under
    /// `fileprovider.domain.<id>`. Upgrading installs must see those
    /// values transparently and have them rewritten via the new file
    /// layout on first read.
    func testMigratesLegacyUserDefaultsToFileLayout() throws {
        let tmp = URL(fileURLWithPath: NSTemporaryDirectory())
            .appendingPathComponent("fp-config-test-\(UUID().uuidString)", isDirectory: true)
        defer { try? FileManager.default.removeItem(at: tmp) }
        let suiteName = "fp-config-legacy-test-\(UUID().uuidString)"
        let legacy = try XCTUnwrap(UserDefaults(suiteName: suiteName))
        defer { legacy.removePersistentDomain(forName: suiteName) }

        let seeded = FileProviderDomainConfig(domainIdentifier: "legacy-domain",
                                              displayName: "Legacy Server",
                                              serverURL: URL(string: "https://legacy.example.test")!)
        let encoded = try JSONEncoder().encode(seeded)
        legacy.set(encoded, forKey: FileProviderConfig.legacyDefaultsKeyPrefix + "legacy-domain")

        let store = FileProviderConfig(directory: tmp, legacyDefaults: legacy)
        let loaded = try XCTUnwrap(store.load(domain: "legacy-domain"))
        XCTAssertEqual(loaded, seeded)

        // New backend now has the entry — a second loader with the same
        // directory but NO legacy fallback should still find it.
        let detached = FileProviderConfig(directory: tmp,
                                          legacyDefaults: UserDefaults(suiteName: "fp-config-empty-\(UUID().uuidString)"))
        XCTAssertEqual(detached.load(domain: "legacy-domain"), seeded)

        // Legacy entry is gone — the migration cleared it so we don't
        // spin on the fallback every launch.
        XCTAssertNil(legacy.data(forKey: FileProviderConfig.legacyDefaultsKeyPrefix + "legacy-domain"))
    }
}
