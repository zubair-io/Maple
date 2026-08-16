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
}
