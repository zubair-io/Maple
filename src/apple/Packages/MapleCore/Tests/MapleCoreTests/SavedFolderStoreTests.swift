import XCTest

@testable import MapleCore

final class SavedFolderStoreTests: XCTestCase {
    private let suiteName = "SavedFolderStoreTests-\(UUID().uuidString)"
    private var defaults: UserDefaults!

    override func setUp() {
        defaults = UserDefaults(suiteName: suiteName)!
        defaults.removePersistentDomain(forName: suiteName)
    }

    override func tearDown() {
        defaults.removePersistentDomain(forName: suiteName)
    }

    private func folder(_ name: String, openedSecondsAgo: TimeInterval) -> SavedFolder {
        // Anchor to a fixed epoch so ordering is deterministic (no wall-clock).
        let base = Date(timeIntervalSince1970: 1_700_000_000)
        return SavedFolder(
            path: "/Volumes/\(name)",
            displayName: name,
            bookmark: Data(name.utf8),
            lastOpened: base.addingTimeInterval(-openedSecondsAgo))
    }

    /// The reported bug: folders shifted by last-opened. They must display in
    /// stable alphabetical order regardless of the order they were opened.
    func testLoadReturnsAlphabeticalOrderNotRecency() {
        // Insert in reverse-alphabetical, most-recent-first order.
        SavedFolderStore.upsert(folder("Zebra", openedSecondsAgo: 0), into: defaults)
        SavedFolderStore.upsert(folder("Mango", openedSecondsAgo: 10), into: defaults)
        SavedFolderStore.upsert(folder("Apple", openedSecondsAgo: 20), into: defaults)

        let names = SavedFolderStore.load(from: defaults).map(\.displayName)
        XCTAssertEqual(names, ["Apple", "Mango", "Zebra"])
    }

    /// Alphabetical sort is Finder-standard: case-insensitive and numeric-aware,
    /// so "Trip 2" precedes "Trip 10".
    func testLoadSortIsCaseInsensitiveAndNumericAware() {
        SavedFolderStore.upsert(folder("Trip 10", openedSecondsAgo: 0), into: defaults)
        SavedFolderStore.upsert(folder("Trip 2", openedSecondsAgo: 1), into: defaults)
        SavedFolderStore.upsert(folder("beta", openedSecondsAgo: 2), into: defaults)
        SavedFolderStore.upsert(folder("Alpha", openedSecondsAgo: 3), into: defaults)

        let names = SavedFolderStore.load(from: defaults).map(\.displayName)
        XCTAssertEqual(names, ["Alpha", "beta", "Trip 2", "Trip 10"])
    }

    /// Display order changed to alphabetical, but eviction must still track
    /// recency: when over capacity the least-recently-opened folder is dropped,
    /// not the alphabetically-last one.
    func testEvictionKeepsMostRecentlyOpenedNotAlphabeticallyLast() {
        let capacity = SavedFolderStore.capacity
        // Fill to capacity with alphabetically-early names, all opened long ago.
        for i in 0..<capacity {
            let name = String(format: "A%02d", i)  // A00…A09
            SavedFolderStore.upsert(
                folder(name, openedSecondsAgo: 1000 - Double(i)), into: defaults)
        }
        // "A00" is the least-recently-opened (largest openedSecondsAgo).
        // Open a brand-new, alphabetically-last folder just now.
        SavedFolderStore.upsert(folder("Zzz", openedSecondsAgo: 0), into: defaults)

        let names = SavedFolderStore.load(from: defaults).map(\.displayName)
        XCTAssertEqual(names.count, capacity, "stays at capacity")
        XCTAssertTrue(names.contains("Zzz"), "the just-opened folder is kept")
        XCTAssertFalse(names.contains("A00"), "the least-recently-opened folder is evicted")
    }

    /// Re-opening an existing folder refreshes it in place (no duplicate) and,
    /// because display order is alphabetical, its position does not change.
    func testUpsertExistingRefreshesWithoutDuplicating() {
        SavedFolderStore.upsert(folder("Apple", openedSecondsAgo: 100), into: defaults)
        SavedFolderStore.upsert(folder("Mango", openedSecondsAgo: 50), into: defaults)
        SavedFolderStore.upsert(folder("Apple", openedSecondsAgo: 0), into: defaults)

        let names = SavedFolderStore.load(from: defaults).map(\.displayName)
        XCTAssertEqual(names, ["Apple", "Mango"])
    }
}
