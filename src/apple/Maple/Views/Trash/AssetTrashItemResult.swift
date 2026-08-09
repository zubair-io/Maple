// AssetTrashItemResult.swift — per-item outcome for a grid multi-select
// trash batch (#2653). Mirrors `AssetDropItemResult`'s shape (id +
// displayName + outcome) so the two batch-report flows read the same way.

import Foundation

struct AssetTrashItemResult: Identifiable {
    let id: UUID
    let displayName: String
    let outcome: Outcome

    init(id: UUID = UUID(), displayName: String, outcome: Outcome) {
        self.id = id
        self.displayName = displayName
        self.outcome = outcome
    }

    /// Which trash an item landed in — surfaces the design doc's
    /// deliberate platform asymmetry (macOS Filesystem → the real OS
    /// Trash; everything else → Maple's in-app `.maple/trash`; Cloud →
    /// the server's trash) directly in the outcome report.
    enum Destination: Equatable {
        case osTrash
        case mapleTrash
        case cloudTrash
    }

    enum Outcome: Equatable {
        case trashed(destination: Destination)
        case failed(String)
    }
}
