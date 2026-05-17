import XCTest
@testable import MapleCore

final class ChangeCursorStoreTests: XCTestCase {
    private func freshDefaults() -> UserDefaults {
        let suite = "test-cursorstore-\(UUID().uuidString)"
        return UserDefaults(suiteName: suite)!
    }

    func testInitiallyZero() {
        let store = ChangeCursorStore(defaults: freshDefaults())
        XCTAssertEqual(store.load(domain: "d"), 0)
    }

    func testSaveAndLoad() {
        let d = freshDefaults()
        let s1 = ChangeCursorStore(defaults: d)
        s1.save(123, domain: "d")
        let s2 = ChangeCursorStore(defaults: d)
        XCTAssertEqual(s2.load(domain: "d"), 123)
    }

    func testSaveAndLoadLargeCursor() {
        let store = ChangeCursorStore(defaults: freshDefaults())
        let big: Int64 = 4_000_000_000  // > Int32 max
        store.save(big, domain: "d")
        XCTAssertEqual(store.load(domain: "d"), big)
    }

    func testPerDomainIsolation() {
        let store = ChangeCursorStore(defaults: freshDefaults())
        store.save(10, domain: "a")
        store.save(20, domain: "b")
        XCTAssertEqual(store.load(domain: "a"), 10)
        XCTAssertEqual(store.load(domain: "b"), 20)
    }

    func testReset() {
        let store = ChangeCursorStore(defaults: freshDefaults())
        store.save(5, domain: "d")
        store.reset(domain: "d")
        XCTAssertEqual(store.load(domain: "d"), 0)
    }
}
