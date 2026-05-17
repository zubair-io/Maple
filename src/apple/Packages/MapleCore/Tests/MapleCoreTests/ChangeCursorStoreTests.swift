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

    /// Cursors must never regress: a stale save (lower value) is
    /// ignored. This is the in-process guard against a host-app race
    /// clobbering a fresher extension save.
    func testSaveNeverRegresses() {
        let store = ChangeCursorStore(defaults: freshDefaults())
        store.save(100, domain: "d")
        store.save(50, domain: "d")
        XCTAssertEqual(store.load(domain: "d"), 100)
        store.save(99, domain: "d")
        XCTAssertEqual(store.load(domain: "d"), 100)
        store.save(101, domain: "d")
        XCTAssertEqual(store.load(domain: "d"), 101)
    }

    /// Simulates two concurrent processes (host + extension) writing
    /// to the same App Group suite. The higher cursor must win
    /// regardless of arrival order — this is the behaviour the
    /// extension relies on when the host occasionally checkpoints.
    func testConcurrentProcessesPreserveHighestCursor() {
        let suite = "test-cursorstore-shared-\(UUID().uuidString)"
        let d1 = UserDefaults(suiteName: suite)!
        let d2 = UserDefaults(suiteName: suite)!
        // Two store instances against the same backing suite stand in
        // for two processes sharing the App Group.
        let host = ChangeCursorStore(defaults: d1)
        let ext  = ChangeCursorStore(defaults: d2)

        ext.save(500, domain: "d")
        // Host writes a stale value (e.g. its cached cursor from
        // before the extension's most recent SSE event).
        host.save(400, domain: "d")
        XCTAssertEqual(host.load(domain: "d"), 500)
        XCTAssertEqual(ext.load(domain: "d"), 500)

        // Host writes a newer value — now it should win.
        host.save(600, domain: "d")
        XCTAssertEqual(ext.load(domain: "d"), 600)

        // Ext writes stale; load still reflects host's 600.
        ext.save(550, domain: "d")
        XCTAssertEqual(host.load(domain: "d"), 600)

        // Cleanup.
        d1.removePersistentDomain(forName: suite)
    }
}
