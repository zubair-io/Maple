// ImportsSettingsView+VM.swift — pure display helpers for the Imports
// wizard (#2773).
//
// No SwiftUI import — pattern per issue #192 (see
// CloudflareSettingsView+VM.swift). The actual business rules (source/
// library overlap, per-bucket label blankness) live one layer down in
// MapleCloudKit's `ImportSourceGuard` / `ImportReviewForm` so the package
// test target can reach them too; this file only turns those rules into
// copy and small view-facing values.

import Foundation
import MapleCore

/// Which import path a "queued" notice on step 1 is reporting — set right
/// after `create()` succeeds, cleared as soon as the operator starts
/// picking the next source folder.
enum ImportsQueuedNotice: Equatable {
    case manual
    case auto
}

enum ImportsSettingsVM {

    /// Whether the folder the picker is currently sitting in can be used as
    /// the source. False whenever either side isn't known yet (no listing
    /// loaded, or no library chosen) — there's nothing to compare, so
    /// nothing to block. `ImportSourceGuard.isInsideLibrary` is the actual
    /// rule; this just supplies its arguments from optional view state.
    static func currentBlocked(listingPath: String?, libraryRoot: String?) -> Bool {
        guard let listingPath, let libraryRoot else { return false }
        return ImportSourceGuard.isInsideLibrary(source: listingPath, library: libraryRoot)
    }

    /// Display name for the chosen library, falling back to the raw id if
    /// the library list hasn't loaded (or somehow no longer contains it).
    static func libraryLabel(libraries: [CloudFolder], id: String) -> String {
        libraries.first(where: { $0.id == id })?.displayName ?? id
    }

    /// Copy for the "queued" notice shown back on step 1 after a create —
    /// mirrors the web's `started()` banner.
    static func queuedNoticeText(_ kind: ImportsQueuedNotice?) -> String? {
        switch kind {
        case nil:
            return nil
        case .manual:
            return "Import queued — running in the background. Track it on the Workers page."
        case .auto:
            return "Import queued (auto) — running in the background. Track it on the Workers page."
        }
    }

    /// "N / M files" for the progress step.
    static func filesSummaryText(_ summary: ImportSummary) -> String {
        "\(summary.progress.current) / \(summary.progress.total) files"
    }

    /// "N copied · M skipped · K failed" for the progress step.
    static func countsSummaryText(_ summary: ImportSummary) -> String {
        "\(summary.counts.copied) copied · \(summary.counts.skipped) skipped · "
            + "\(summary.counts.failed) failed"
    }

    /// The Cancel button's label — "Cancelling…" once the server has
    /// acknowledged the request but the job hasn't reached a terminal
    /// status yet (cancel is between-files, not instant).
    static func cancelButtonTitle(cancelRequested: Bool) -> String {
        cancelRequested ? "Cancelling…" : "Cancel"
    }

    /// Whether opening the page should land directly on step 3 — true when
    /// a job id was supplied. This is the native equivalent of the web's
    /// `?job=<id>` deep link, which the Workers page's Import group hands
    /// out (T2, #2765) so an operator can jump straight to a running
    /// import's progress instead of starting the wizard over.
    static func startsOnProgress(jobID: String?) -> Bool {
        jobID != nil
    }
}
