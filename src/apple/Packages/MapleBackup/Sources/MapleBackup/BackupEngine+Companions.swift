// Sources/MapleBackup/BackupEngine+Companions.swift
//
// Outstanding-companion accounting (#702), split out of BackupEngine.swift to
// keep that file under the 570-line headroom gate (#2311). A "companion" is the
// best-effort sidecar / rendered-bytes upload that rides alongside a photo's
// bytes: the photo is done when its bytes land, but the progress VM needs to
// distinguish "uploaded" from "uploaded, companions still pending".

import Foundation

extension BackupEngine {
    // MARK: - Outstanding-companion accounting (#702)

    /// Record that one more companion for `taskId` has entered its bounded
    /// retry path. Emits `.companionPending` only on the 0→1 transition so the
    /// progress VM flips the photo to "uploaded, companions pending" exactly
    /// once regardless of how many companions are outstanding.
    func companionBecamePending(_ taskId: BackupTaskID) async {
        let prior = outstandingCompanions[taskId] ?? 0
        outstandingCompanions[taskId] = prior + 1
        if prior == 0 {
            await queue.emit(.companionPending(taskId))
        }
    }

    /// Record that one companion for `taskId` reached a terminal state (landed
    /// or exhausted). Emits `.companionsResolved` only on the →0 transition so
    /// the photo flips back to fully "done" exactly once.
    func companionResolved(_ taskId: BackupTaskID) async {
        guard let prior = outstandingCompanions[taskId], prior > 0 else { return }
        if prior == 1 {
            outstandingCompanions.removeValue(forKey: taskId)
            await queue.emit(.companionsResolved(taskId))
        } else {
            outstandingCompanions[taskId] = prior - 1
        }
    }

    /// Exponential backoff capped at 1 hour. The `companionBackoff` default
    /// argument inlines the same formula (a `public` init can't reference a
    /// non-public member in a default value).
    static func backoffSeconds(for retryCount: Int) -> TimeInterval {
        min(3600, pow(2.0, Double(retryCount)))
    }
}
