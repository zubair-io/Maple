// EnrichmentSettingsView+VM.swift — Pure-function view-model helpers shared
// by the four enrichment row views.
//
// Pattern (issue #192): every SwiftUI view with non-trivial derivation gets
// a sibling `+VM.swift` whose contents are unit-testable in isolation. This
// file MUST NOT `import SwiftUI`. The forms' own rules (seeding, patch
// building, the merge-hazard base fields) live one layer down in
// EnrichmentSettingsForms.swift (MapleCloudKit), so the package test target
// can reach them too — this file only holds copy/derivation that needs
// nothing beyond the form + snapshot types.

import Foundation
import MapleCore

enum EnrichmentSettingsVM {

    /// Why the Geocode row's Test button is disabled, or nil when it's
    /// available. Mirrors `workers.component.ts`'s client-side
    /// "Enter a URL to test." guard.
    static func geocodeTestDisabledReason(_ form: GeocodeSettingsForm) -> String? {
        form.testURL() == nil ? "Enter a URL to test." : nil
    }

    /// Why the Meilisearch row's Test button is disabled, or nil when it's
    /// available. Same guard as Geocode — a blank URL, not a missing key
    /// (the key falls back to the saved one server-side when omitted).
    static func meilisearchTestDisabledReason(_ form: MeilisearchSettingsForm) -> String? {
        form.testCredentials() == nil ? "Enter a URL to test." : nil
    }

    /// Placeholder for the Meilisearch API key field. Signals that a key is
    /// already stored without revealing anything about it — the server
    /// never sends it back, so this is the only affordance telling the
    /// operator that leaving the field blank is safe. Same shape as
    /// `CloudflareSettingsVM.secretPlaceholder`.
    static func meilisearchAPIKeyPlaceholder(apiKeyIsSet: Bool) -> String {
        apiKeyIsSet ? "••••••••  (unchanged — leave blank to keep)" : ""
    }

    /// Headline for the face model-status banner (T5b, #2772). "Loaded" is
    /// the only state that reads as ready; every other loader state
    /// (idle/downloading/error) is a variant of "not ready yet", matching the
    /// web panel's binary loaded/not-loaded banner text.
    static func faceModelStatusHeadline(_ status: FaceModelsStatus?) -> String {
        guard let status else { return "Model status unknown." }
        switch status.status {
        case .loaded: return "Models loaded."
        case .downloading: return "Downloading models…"
        case .error: return "Model load failed: \(status.errorDetail ?? "unknown error")."
        case .idle: return "Models not yet loaded."
        }
    }

    /// Human-readable byte count for a model file, e.g. "15.9 MB".
    static func formatModelBytes(_ bytes: Int) -> String {
        ByteCountFormatter.string(fromByteCount: Int64(bytes), countStyle: .file)
    }

    /// File detail suffix for the model-status banner — filename, size, and
    /// path — or empty when the probe is unavailable (e.g. `face_models` is
    /// absent from the response). The banner itself must still render in
    /// that case (headline-only); this only covers the trailing detail.
    static func faceModelDetailSuffix(fileLabel: String, probe: FaceModelsStatus.FileProbe?) -> String {
        guard let probe else { return "" }
        return " \(fileLabel) · \(formatModelBytes(probe.bytes)) · \(probe.path)"
    }
}
