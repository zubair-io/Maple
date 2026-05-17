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

    public func save(_ cursor: Int64, domain: String) {
        defaults.set(NSNumber(value: cursor), forKey: prefix + domain)
    }

    public func reset(domain: String) {
        defaults.removeObject(forKey: prefix + domain)
    }
}
