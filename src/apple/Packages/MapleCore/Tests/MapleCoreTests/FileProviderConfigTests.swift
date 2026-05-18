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
}
