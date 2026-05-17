/**
 WorkingSet — bounded in-memory table of the asset identifiers the
 File Provider extension keeps "warm" for the OS (Phase 5b).

 Capacity caps growth; eviction policy is kind-aware:
   - .xmp, .favorite       — never evicted (eviction-immune)
   - .active               — evicted only after all .recent drained
   - .recent               — evicted first, oldest by lastTouched

 Not thread-safe by itself. The long-lived owner is the
 WorkingSetEnumerator running inside FileProviderExtension; if multiple
 actors ever need concurrent access, wrap externally with a mutex or
 actor isolation.
 */

import Foundation

public enum WorkingSetKind: Int, Comparable, Sendable {
    /// Eviction-immune. Sidecars are central to the editing story —
    /// dropping them from the OS's view costs an extra refresh later.
    case xmp = 3
    /// Eviction-immune. User-flagged content (rating >= 1).
    case favorite = 2
    /// Evicted last among evictables. The OS explicitly asked for it.
    case active = 1
    /// Evicted first. Recency heuristic — last 30 days of captures.
    case recent = 0

    public static func < (lhs: WorkingSetKind, rhs: WorkingSetKind) -> Bool {
        lhs.rawValue < rhs.rawValue
    }
}

public struct WorkingSetEntry: Sendable, Equatable {
    public var kind: WorkingSetKind
    public var lastTouched: Date

    public init(kind: WorkingSetKind, lastTouched: Date) {
        self.kind = kind
        self.lastTouched = lastTouched
    }
}

public final class WorkingSet: @unchecked Sendable {
    public let capacity: Int
    private var entries: [String: WorkingSetEntry] = [:]

    public init(capacity: Int = 20_000) {
        self.capacity = capacity
    }

    /// Insert or update an entry. `kind` can only move UP the priority
    /// ladder (e.g. .recent → .favorite if the user stars an asset);
    /// downgrades are ignored to preserve eviction immunity once granted.
    public func upsert(identifier: String, kind: WorkingSetKind, lastTouched: Date) {
        if let existing = entries[identifier] {
            let newKind = max(existing.kind, kind)
            entries[identifier] = WorkingSetEntry(kind: newKind, lastTouched: lastTouched)
        } else {
            entries[identifier] = WorkingSetEntry(kind: kind, lastTouched: lastTouched)
        }
        if entries.count > capacity {
            evictUntilUnderCap()
        }
    }

    public func remove(identifier: String) {
        entries.removeValue(forKey: identifier)
    }

    public func entry(for identifier: String) -> WorkingSetEntry? {
        entries[identifier]
    }

    public func allIdentifiers() -> [String] {
        Array(entries.keys)
    }

    public func count() -> Int { entries.count }

    // MARK: - Eviction

    private func evictUntilUnderCap() {
        // Drain by ascending priority: recent first, then active.
        // xmp/favorite are eviction-immune and never appear in this list.
        let evictableKinds: [WorkingSetKind] = [.recent, .active]
        for kind in evictableKinds {
            if entries.count <= capacity { return }
            let candidates = entries
                .filter { $0.value.kind == kind }
                .sorted { $0.value.lastTouched < $1.value.lastTouched }
            for (id, _) in candidates {
                if entries.count <= capacity { return }
                entries.removeValue(forKey: id)
            }
        }
        // If we're still over cap, only xmp + favorite remain; eviction
        // immunity wins. In practice 20k vs ~5k XMPs + 200 favs means
        // this branch should never fire.
    }
}
