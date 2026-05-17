import XCTest
@testable import MapleCore

final class WorkingSetTests: XCTestCase {
    func testInsertAndEnumerate() {
        let ws = WorkingSet(capacity: 100)
        ws.upsert(identifier: "asset/1", kind: .recent, lastTouched: Date())
        ws.upsert(identifier: "asset/2", kind: .favorite, lastTouched: Date())
        let ids = ws.allIdentifiers().sorted()
        XCTAssertEqual(ids, ["asset/1", "asset/2"])
    }

    func testCapNeverDropsXMPsOrFavorites() {
        let ws = WorkingSet(capacity: 3)
        let now = Date()
        ws.upsert(identifier: "xmp/1", kind: .xmp,
                  lastTouched: now.addingTimeInterval(-100))
        ws.upsert(identifier: "fav/1", kind: .favorite,
                  lastTouched: now.addingTimeInterval(-100))
        // Cap = 3 — adding three more recents pushes us over.
        ws.upsert(identifier: "recent/old", kind: .recent,
                  lastTouched: now.addingTimeInterval(-50))
        ws.upsert(identifier: "recent/mid", kind: .recent,
                  lastTouched: now.addingTimeInterval(-25))
        ws.upsert(identifier: "recent/new", kind: .recent, lastTouched: now)
        let ids = Set(ws.allIdentifiers())
        XCTAssertTrue(ids.contains("xmp/1"))
        XCTAssertTrue(ids.contains("fav/1"))
        // Oldest recent is evicted first; newest survives.
        XCTAssertFalse(ids.contains("recent/old"))
        XCTAssertTrue(ids.contains("recent/new"))
    }

    func testTouchUpdatesLastTouched() {
        let ws = WorkingSet(capacity: 10)
        let t0 = Date(timeIntervalSinceReferenceDate: 1000)
        let t1 = Date(timeIntervalSinceReferenceDate: 2000)
        ws.upsert(identifier: "asset/1", kind: .recent, lastTouched: t0)
        ws.upsert(identifier: "asset/1", kind: .recent, lastTouched: t1)
        XCTAssertEqual(ws.entry(for: "asset/1")?.lastTouched, t1)
    }

    func testUpsertCanUpgradeKindButNotDowngradeFromXMP() {
        let ws = WorkingSet(capacity: 10)
        ws.upsert(identifier: "x", kind: .xmp, lastTouched: Date())
        ws.upsert(identifier: "x", kind: .recent, lastTouched: Date())
        // Once tracked as XMP, must stay XMP.
        XCTAssertEqual(ws.entry(for: "x")?.kind, .xmp)

        ws.upsert(identifier: "y", kind: .recent, lastTouched: Date())
        ws.upsert(identifier: "y", kind: .favorite, lastTouched: Date())
        // Upgrade recent → favorite OK.
        XCTAssertEqual(ws.entry(for: "y")?.kind, .favorite)

        ws.upsert(identifier: "z", kind: .favorite, lastTouched: Date())
        ws.upsert(identifier: "z", kind: .recent, lastTouched: Date())
        // No downgrade favorite → recent.
        XCTAssertEqual(ws.entry(for: "z")?.kind, .favorite)
    }

    func testRemoveDeletes() {
        let ws = WorkingSet(capacity: 10)
        ws.upsert(identifier: "a", kind: .recent, lastTouched: Date())
        ws.remove(identifier: "a")
        XCTAssertNil(ws.entry(for: "a"))
    }

    func testEvictsRecentBeforeActive() {
        // Fill with one active + one recent at cap, then add another
        // recent — the older .recent should drop, the .active should stay.
        let ws = WorkingSet(capacity: 2)
        let now = Date()
        ws.upsert(identifier: "active/1", kind: .active,
                  lastTouched: now.addingTimeInterval(-100))
        ws.upsert(identifier: "recent/old", kind: .recent,
                  lastTouched: now.addingTimeInterval(-50))
        ws.upsert(identifier: "recent/new", kind: .recent, lastTouched: now)
        let ids = Set(ws.allIdentifiers())
        XCTAssertTrue(ids.contains("active/1"))
        XCTAssertTrue(ids.contains("recent/new"))
        XCTAssertFalse(ids.contains("recent/old"))
    }

    func testConcurrentUpsertsDoNotCrash() async {
        // Stress test for the NSLock-guarded internal state. Without the
        // lock this would crash under TSAN / sometimes in production via
        // a Swift dictionary mutation race.
        let ws = WorkingSet(capacity: 5_000)
        await withTaskGroup(of: Void.self) { group in
            for taskIdx in 0..<8 {
                group.addTask {
                    for i in 0..<1_000 {
                        let id = "asset/\(taskIdx)/\(i)"
                        ws.upsert(identifier: id,
                                  kind: .recent,
                                  lastTouched: Date())
                        if i % 4 == 0 {
                            _ = ws.entry(for: id)
                        }
                        if i % 7 == 0 {
                            ws.remove(identifier: id)
                        }
                    }
                }
            }
        }
        // Cap should still hold.
        XCTAssertLessThanOrEqual(ws.count(), 5_000)
    }

    func testEvictsActiveOnlyAfterRecentExhausted() {
        let ws = WorkingSet(capacity: 2)
        let now = Date()
        // Two actives — when a recent is added, we go over cap (3) and
        // only .recent is evictable, but no recents exist; so the new
        // .recent itself becomes a candidate (oldest among the kind it
        // belongs to). The two actives stay.
        ws.upsert(identifier: "active/1", kind: .active,
                  lastTouched: now.addingTimeInterval(-100))
        ws.upsert(identifier: "active/2", kind: .active,
                  lastTouched: now.addingTimeInterval(-50))
        ws.upsert(identifier: "recent/1", kind: .recent, lastTouched: now)
        let ids = Set(ws.allIdentifiers())
        XCTAssertTrue(ids.contains("active/1"))
        XCTAssertTrue(ids.contains("active/2"))
        XCTAssertFalse(ids.contains("recent/1"))
    }
}
