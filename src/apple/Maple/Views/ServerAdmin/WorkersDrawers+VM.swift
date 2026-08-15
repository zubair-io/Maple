// WorkersDrawers+VM.swift — Pure-function helpers for the triage drawers.
//
// Pattern (issue #192): no SwiftUI import, unit-testable in isolation.
// Everything here is about rendering half-known rows, because the server's
// dead and damaged records are mostly nullable — see WorkerTriage.swift.

import Foundation
import MapleCore

enum WorkersTriageVM {

    /// Path for a triage row, or a marker when the server couldn't resolve
    /// one.
    ///
    /// A missing path still gets a row: the record exists, and hiding it
    /// would under-report the queue. The marker says the path is unknown
    /// rather than leaving a blank line that reads as a rendering bug.
    static func pathDisplay(_ absPath: String?) -> String {
        guard let absPath, !absPath.isEmpty else { return "(path unavailable)" }
        return absPath
    }

    /// Secondary line for a dead job: attempts and when it last ran.
    ///
    /// Both halves are optional and either can be missing on its own, so
    /// this assembles whatever is known instead of requiring the pair.
    static func deadJobDetail(_ job: DeadJob) -> String {
        var parts: [String] = []
        if let attempts = job.attempts {
            parts.append(attempts == 1 ? "1 attempt" : "\(attempts) attempts")
        }
        if let processedAt = job.processedAt, !processedAt.isEmpty {
            parts.append("last run \(processedAt)")
        }
        return parts.isEmpty ? "no attempt history recorded" : parts.joined(separator: " · ")
    }

    /// Secondary line for a damaged asset: which stage tagged it, and when.
    ///
    /// The tagging stage is the first place to look, so it leads even
    /// though it is not necessarily where the corruption originated.
    static func damagedDetail(_ asset: DamagedAsset) -> String {
        var parts: [String] = []
        if let stage = asset.stage, !stage.isEmpty {
            parts.append("tagged by \(stage)")
        }
        if let since = asset.since, !since.isEmpty {
            parts.append("since \(since)")
        }
        if let mapleID = asset.mapleID, !mapleID.isEmpty {
            parts.append(mapleID)
        }
        return parts.isEmpty ? "no details recorded" : parts.joined(separator: " · ")
    }

    /// Outcome text after Retry all.
    ///
    /// Zero is called out explicitly. It means the rows were already
    /// re-armed by something else — a different situation from the request
    /// failing, and one the operator would otherwise read as a silent
    /// no-op.
    static func retryNote(affected: Int) -> String {
        switch affected {
        case 0: return "Nothing to re-arm — these jobs were already reset."
        case 1: return "Re-armed 1 job."
        default: return "Re-armed \(affected) jobs."
        }
    }

    /// Outcome text after clearing damaged tags.
    static func clearNote(affected: Int) -> String {
        switch affected {
        case 0: return "Nothing to clear — these assets were already re-queued."
        case 1: return "Cleared 1 asset and re-queued it."
        default: return "Cleared \(affected) assets and re-queued them."
        }
    }
}
