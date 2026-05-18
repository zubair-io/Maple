import XCTest
@testable import MapleCore

final class ChangeCursorStoreTests: XCTestCase {
    /// Each test gets its own tmp directory. The store accepts a
    /// `directory:` override so we never touch the real App Group
    /// container during testing.
    private func freshDirectory() -> URL {
        let url = URL(fileURLWithPath: NSTemporaryDirectory())
            .appendingPathComponent("cursorstore-\(UUID().uuidString)", isDirectory: true)
        try? FileManager.default.createDirectory(at: url, withIntermediateDirectories: true)
        return url
    }

    private func cleanup(_ url: URL) {
        try? FileManager.default.removeItem(at: url)
    }

    func testInitiallyZero() {
        let dir = freshDirectory()
        defer { cleanup(dir) }
        let store = ChangeCursorStore(directory: dir)
        XCTAssertEqual(store.load(domain: "d"), 0)
    }

    func testSaveAndLoad() {
        let dir = freshDirectory()
        defer { cleanup(dir) }
        let s1 = ChangeCursorStore(directory: dir)
        s1.save(123, domain: "d")
        let s2 = ChangeCursorStore(directory: dir)
        XCTAssertEqual(s2.load(domain: "d"), 123)
    }

    func testSaveAndLoadLargeCursor() {
        let dir = freshDirectory()
        defer { cleanup(dir) }
        let store = ChangeCursorStore(directory: dir)
        let big: Int64 = 4_000_000_000  // > Int32 max
        store.save(big, domain: "d")
        XCTAssertEqual(store.load(domain: "d"), big)
    }

    func testPerDomainIsolation() {
        let dir = freshDirectory()
        defer { cleanup(dir) }
        let store = ChangeCursorStore(directory: dir)
        store.save(10, domain: "a")
        store.save(20, domain: "b")
        XCTAssertEqual(store.load(domain: "a"), 10)
        XCTAssertEqual(store.load(domain: "b"), 20)
    }

    func testReset() {
        let dir = freshDirectory()
        defer { cleanup(dir) }
        let store = ChangeCursorStore(directory: dir)
        store.save(5, domain: "d")
        store.reset(domain: "d")
        XCTAssertEqual(store.load(domain: "d"), 0)
    }

    /// Cursors must never regress: a stale save (lower value) is
    /// ignored. This is the in-process guard against a host-app race
    /// clobbering a fresher extension save.
    func testSaveNeverRegresses() {
        let dir = freshDirectory()
        defer { cleanup(dir) }
        let store = ChangeCursorStore(directory: dir)
        store.save(100, domain: "d")
        store.save(50, domain: "d")
        XCTAssertEqual(store.load(domain: "d"), 100)
        store.save(99, domain: "d")
        XCTAssertEqual(store.load(domain: "d"), 100)
        store.save(101, domain: "d")
        XCTAssertEqual(store.load(domain: "d"), 101)
    }

    /// Simulates two concurrent processes (host + extension) writing
    /// to the same App Group container. The higher cursor must win
    /// regardless of arrival order — this is the behaviour the
    /// extension relies on when the host occasionally checkpoints.
    func testConcurrentProcessesPreserveHighestCursor() {
        let dir = freshDirectory()
        defer { cleanup(dir) }
        // Two store instances against the same backing directory stand
        // in for two processes sharing the App Group container.
        let host = ChangeCursorStore(directory: dir)
        let ext  = ChangeCursorStore(directory: dir)

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
    }

    // MARK: - Phase 6 item 3: cross-process atomicity

    /// Two stores point at the same directory (standing in for two
    /// processes). Both load cursor 0, then save with one higher than
    /// the other. The persisted value must be the max regardless of
    /// arrival order. Exercises BOTH orderings.
    func testCrossProcessMaxRegardlessOfOrder() {
        // Order 1: A=100 first, then B=50.
        do {
            let dir = freshDirectory()
            defer { cleanup(dir) }
            let a = ChangeCursorStore(directory: dir)
            let b = ChangeCursorStore(directory: dir)
            XCTAssertEqual(a.load(domain: "d"), 0)
            XCTAssertEqual(b.load(domain: "d"), 0)
            a.save(100, domain: "d")
            b.save(50, domain: "d")
            XCTAssertEqual(a.load(domain: "d"), 100, "A-then-B: max wins")
            XCTAssertEqual(b.load(domain: "d"), 100, "A-then-B: max wins")
        }
        // Order 2: B=50 first, then A=100.
        do {
            let dir = freshDirectory()
            defer { cleanup(dir) }
            let a = ChangeCursorStore(directory: dir)
            let b = ChangeCursorStore(directory: dir)
            b.save(50, domain: "d")
            a.save(100, domain: "d")
            XCTAssertEqual(a.load(domain: "d"), 100, "B-then-A: max wins")
            XCTAssertEqual(b.load(domain: "d"), 100, "B-then-A: max wins")
        }
        // Order 3: B=100 first, then A=50 (A's lower value must not regress).
        do {
            let dir = freshDirectory()
            defer { cleanup(dir) }
            let a = ChangeCursorStore(directory: dir)
            let b = ChangeCursorStore(directory: dir)
            b.save(100, domain: "d")
            a.save(50, domain: "d")
            XCTAssertEqual(a.load(domain: "d"), 100, "B=100 then A=50: 100 wins")
            XCTAssertEqual(b.load(domain: "d"), 100, "B=100 then A=50: 100 wins")
        }
    }

    /// Concurrent write storm: two queues each issue 1000 monotonically
    /// increasing writes into the same directory. After both finish the
    /// persisted value must equal the largest attempted (2000).
    func testConcurrentWriteStormPreservesMax() {
        let dir = freshDirectory()
        defer { cleanup(dir) }
        let storeA = ChangeCursorStore(directory: dir)
        let storeB = ChangeCursorStore(directory: dir)

        let q1 = DispatchQueue(label: "cursor-storm-1", attributes: .concurrent)
        let q2 = DispatchQueue(label: "cursor-storm-2", attributes: .concurrent)
        let group = DispatchGroup()

        group.enter()
        q1.async {
            for i in 1...1000 {
                storeA.save(Int64(i), domain: "d")
            }
            group.leave()
        }
        group.enter()
        q2.async {
            for i in 1001...2000 {
                storeB.save(Int64(i), domain: "d")
            }
            group.leave()
        }
        group.wait()

        let reader = ChangeCursorStore(directory: dir)
        XCTAssertEqual(
            reader.load(domain: "d"), 2000,
            "max of all attempted writes must survive the storm"
        )
    }

    /// Distinct Unicode scalars whose low byte coincides must NOT share
    /// a cursor file. Earlier the percent-encoder did `scalar.value & 0xFF`,
    /// which mapped both U+00E4 ("ä") and U+01E4 ("Ǥ") to `%E4` — saving
    /// a cursor under one domain would silently overwrite the other.
    /// The fix percent-encodes the scalar's UTF-8 byte sequence instead,
    /// so each domain occupies its own file.
    func testPercentEncodingDoesNotCollideOnLowByte() {
        let dir = freshDirectory()
        defer { cleanup(dir) }
        let store = ChangeCursorStore(directory: dir)

        let domainA = "\u{00E4}"  // ä — UTF-8 C3 A4
        let domainB = "\u{01E4}"  // Ǥ — UTF-8 C7 A4 (same low byte as scalar.value)

        store.save(111, domain: domainA)
        store.save(222, domain: domainB)

        XCTAssertEqual(store.load(domain: domainA), 111,
                       "U+00E4 cursor must not be clobbered by U+01E4 save")
        XCTAssertEqual(store.load(domain: domainB), 222,
                       "U+01E4 cursor must not collide with U+00E4")

        // And the on-disk filenames must actually differ.
        let files = (try? FileManager.default.contentsOfDirectory(atPath: dir.path)) ?? []
        let cursorFiles = files.filter { $0.hasSuffix(".cursor") }
        XCTAssertEqual(cursorFiles.count, 2,
                       "expected two distinct cursor files, got: \(cursorFiles)")
    }

    /// Cross-process TOCTOU regression test: spawns concurrent saves
    /// from two store instances pointing at the same directory and
    /// requires that the persisted max equals the largest attempted
    /// value (100), not some intermediate value lost to an interleaved
    /// read-modify-write. The pre-fix code used `Data.write(.atomic)` —
    /// atomic write per process but no inter-process serialisation of
    /// the read-max-write window — and could regress under load. The
    /// fix uses `NSFileCoordinator` to serialise the entire RMW.
    func testCrossProcessConcurrentSavesDoNotRegress() async throws {
        let dir = freshDirectory()
        defer { cleanup(dir) }
        let storeA = ChangeCursorStore(directory: dir)
        let storeB = ChangeCursorStore(directory: dir)
        let domain = "test"
        await withTaskGroup(of: Void.self) { group in
            for i in 1...100 {
                let aVal = Int64(i)
                let bVal = Int64(101 - i)
                group.addTask { storeA.save(aVal, domain: domain) }
                group.addTask { storeB.save(bVal, domain: domain) }
            }
        }
        XCTAssertEqual(storeA.load(domain: domain), 100,
                       "concurrent RMW from two processes must not regress max")
        XCTAssertEqual(storeB.load(domain: domain), 100,
                       "concurrent RMW from two processes must not regress max")
    }

    /// Simulates a stray tmp file from a crashed write (or any garbage
    /// file in the directory). `load()` must return the last
    /// successfully-saved value — never a partial / stale sibling file.
    func testStrayTempFileDoesNotCorruptLoad() throws {
        let dir = freshDirectory()
        defer { cleanup(dir) }
        let store = ChangeCursorStore(directory: dir)
        store.save(777, domain: "d")
        XCTAssertEqual(store.load(domain: "d"), 777)

        // Drop a stray tmp file with garbage next to the real one.
        let garbageURL = dir.appendingPathComponent("d.cursor.tmp")
        try "garbage-not-a-cursor".write(to: garbageURL, atomically: true, encoding: .utf8)
        let unrelatedURL = dir.appendingPathComponent("d.cursor.bak")
        try "9999999".write(to: unrelatedURL, atomically: true, encoding: .utf8)

        // load() reads only `d.cursor`, ignores siblings.
        XCTAssertEqual(store.load(domain: "d"), 777)
        // A fresh store sees the same canonical value.
        let store2 = ChangeCursorStore(directory: dir)
        XCTAssertEqual(store2.load(domain: "d"), 777)
    }
}
