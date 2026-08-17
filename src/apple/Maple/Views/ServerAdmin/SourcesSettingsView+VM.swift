// SourcesSettingsView+VM.swift — Pure-function view-model helpers for
// SourcesSettingsView.
//
// Co-located sibling of SourcesSettingsView.swift per issue #192: typed
// inputs → typed outputs, no SwiftUI, no @State, unit-testable in
// isolation (SourcesSettingsVMTests). The view's load/network machinery
// stays view-side, matching every other ServerAdmin page.

import Foundation
import MapleCore

// MARK: - SourcesSettingsVM

/// Namespace for pure Sources-page derivations. A caseless enum keeps the
/// helpers grouped without ever being instantiated.
enum SourcesSettingsVM {

    /// How many of the server's roots are currently unreachable.
    static func disconnectedCount(_ folders: [CloudFolder]) -> Int {
        folders.count { !$0.isConnected }
    }

    /// The footer hint under the source list, or nil when everything is
    /// reachable. Mirrors the web Sources page's wording: it must reassure
    /// that hiding is non-destructive.
    static func disconnectedHint(_ folders: [CloudFolder]) -> String? {
        let count = disconnectedCount(folders)
        guard count > 0 else { return nil }
        let verb = count == 1 ? "source is" : "sources are"
        return "\(count) \(verb) currently unreachable and hidden from the sidebar. Nothing was removed — files and edits reappear when the source is reachable again."
    }

    /// Per-row status column text.
    static func statusLabel(isConnected: Bool) -> String {
        isConnected ? "Connected" : "Not connected"
    }

    /// Per-row file-count column text.
    static func fileCountLabel(_ folder: CloudFolder) -> String {
        "\(folder.file_count) files"
    }
}
