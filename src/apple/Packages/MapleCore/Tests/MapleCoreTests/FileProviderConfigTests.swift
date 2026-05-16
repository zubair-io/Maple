import XCTest
@testable import MapleCore

final class FileProviderConfigTests: XCTestCase {
    func testRoundTrip() throws {
        let defaults = UserDefaults(suiteName: "test.\(UUID().uuidString)")!
        let store = FileProviderConfig(defaults: defaults)
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
}
