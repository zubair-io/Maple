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

    /// `allDomains()` backs `FileProviderDomainController.reconcile`, which
    /// uses it to find orphaned domains (config on disk with no matching
    /// connected server) and tear them down.
    func testAllDomainsEnumeratesEveryPersistedConfig() throws {
        let tmp = URL(fileURLWithPath: NSTemporaryDirectory())
            .appendingPathComponent("fp-config-test-\(UUID().uuidString)", isDirectory: true)
        defer { try? FileManager.default.removeItem(at: tmp) }
        let store = FileProviderConfig(directory: tmp)
        XCTAssertEqual(store.allDomains().count, 0)

        store.save(.init(domainIdentifier: "maple.lawrence.io",
                         displayName: "Lawrence",
                         serverURL: URL(string: "https://maple.lawrence.io")!))
        store.save(.init(domainIdentifier: "localhost-3000",
                         displayName: "Dev",
                         serverURL: URL(string: "http://localhost:3000")!))

        let ids = Set(store.allDomains().map(\.domainIdentifier))
        XCTAssertEqual(ids, ["maple.lawrence.io", "localhost-3000"])

        // Removing one config drops it from enumeration — the orphan is gone.
        store.remove(domain: "maple.lawrence.io")
        XCTAssertEqual(store.allDomains().map(\.domainIdentifier), ["localhost-3000"])
    }
}
