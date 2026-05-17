/**
 ChangeCursorStore — persists the last-seen server cursor per
 File Provider domain (Phase 5b).

 The extension reconnects to /api/changes/subscribe on every launch /
 SSE-failure with `?since=<load(domain:)>`, so loss of state forces a
 full re-enumeration via the 409 stale-cursor path. Persistence here
 keeps that path rare.

 Storage: the shared App Group UserDefaults so the host app and the
 extension see the same value. Per-domain keys allow multiple Maple
 servers (one FP domain each) on a single Mac.
 */

import Foundation

public final class ChangeCursorStore: @unchecked Sendable {
    private let defaults: UserDefaults
    private let prefix = "fileprovider.cursor."
    /// Serialises read-modify-write in `save` against other in-process
    /// callers (the extension creates one store, the host app another,
    /// but both run in their own process and use the App Group
    /// suite). Cross-process races still exist — see the comment on
    /// `save` — but the in-process lock removes the easy half.
    private let lock = NSLock()

    public init(defaults: UserDefaults? = nil) {
        if let d = defaults {
            self.defaults = d
        } else {
            self.defaults =
                UserDefaults(suiteName: FileProviderConfig.appGroupSuiteName)
                ?? .standard
        }
    }

    /// Last-seen cursor for `domain`, or 0 if the domain has never
    /// received an event.
    public func load(domain: String) -> Int64 {
        // UserDefaults stores Int64 as NSNumber; both numeric forms
        // round-trip cleanly via `.object(forKey:) as? Int64`.
        if let n = defaults.object(forKey: prefix + domain) as? NSNumber {
            return n.int64Value
        }
        return 0
    }

    /// Persists `cursor` for `domain`, but only if it is greater than
    /// the currently-persisted value — the cursor must never regress.
    ///
    /// App Group `UserDefaults` is last-writer-wins across processes
    /// with async-flushed writes, so under churn a stale host-app save
    /// can clobber a fresh extension save. The read-then-write here
    /// narrows the race window from "any concurrent write" to
    /// "concurrent write inside the read-modify-write" — it does NOT
    /// fully close it (true atomicity would require a file lock or
    /// per-domain CFPreferences value-and-tag, which neither host
    /// nor extension currently set up). In practice the regression is
    /// at most one cursor step and is healed by the next SSE event +
    /// save; the worst case is a brief stale `since=` on reconnect,
    /// which the server replays harmlessly.
    public func save(_ cursor: Int64, domain: String) {
        lock.lock()
        defer { lock.unlock() }
        let key = prefix + domain
        let current = (defaults.object(forKey: key) as? NSNumber)?.int64Value ?? 0
        if cursor <= current { return }
        defaults.set(NSNumber(value: cursor), forKey: key)
    }

    public func reset(domain: String) {
        lock.lock()
        defer { lock.unlock() }
        defaults.removeObject(forKey: prefix + domain)
    }
}
