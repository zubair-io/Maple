// StageRuntimeSection+VM.swift — Pure-function helpers for the expanded
// stage body (#2770).
//
// Pattern (issue #192): no SwiftUI import, unit-testable in isolation.

import Foundation
import MapleCore

enum WorkersRuntimeVM {

    /// Live decode-pool readout, e.g. "pool 4 target · 4 spawned · 1 busy · 0 queued".
    ///
    /// Worth showing next to the setting because the target and the actual
    /// spawned count diverge while the pool is resizing, which otherwise
    /// looks like the save didn't take.
    static func poolSummary(_ perf: WorkerPerformance) -> String {
        guard let pool = perf.pool else { return "Pool stats unavailable." }
        return
            "pool \(pool.target) target · \(pool.spawned) spawned · \(pool.busy) busy · \(pool.queued) queued"
    }

    /// Warning when the effective value did not come from the database.
    ///
    /// An env-var value cannot be changed from this screen, so a save would
    /// appear to succeed and then be overridden on the next read. Saying so
    /// is cheaper than letting the operator discover it.
    static func sourceNote(_ source: String) -> String? {
        switch source {
        case "env":
            return "Set by an environment variable — changes here won't survive a restart."
        case "db", "default":
            return nil
        default:
            return nil
        }
    }

    /// One-line progress for a migration.
    static func migrationProgress(_ migration: MigrationInfo) -> String {
        var parts = ["\(migration.status)"]
        if migration.processed > 0 { parts.append("\(migration.processed) processed") }
        if migration.remaining > 0 { parts.append("\(migration.remaining) remaining") }
        if migration.errors > 0 { parts.append("\(migration.errors) errors") }
        return parts.joined(separator: " · ")
    }

    /// Reset is offered only once a migration has actually done something.
    ///
    /// Showing it on an untouched migration invites clearing state that was
    /// never written, which is confusing rather than dangerous — but the
    /// button reads as destructive either way, so it stays hidden until it
    /// means something.
    static func canReset(_ migration: MigrationInfo) -> Bool {
        migration.processed > 0 || migration.status != "idle"
    }
}
