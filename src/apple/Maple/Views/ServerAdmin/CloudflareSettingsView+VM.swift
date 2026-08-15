// CloudflareSettingsView+VM.swift — Pure-function view-model helpers for
// CloudflareSettingsView.
//
// Pattern (issue #192): every SwiftUI view with non-trivial derivation gets
// a sibling `+VM.swift` whose contents are unit-testable in isolation. This
// file MUST NOT `import SwiftUI`. The form's own rules (seeding, the
// three-state secret, test-credential assembly) live one layer down in
// `CloudflareSettingsForm` so the package test target can reach them too.

import Foundation
import MapleCore

enum CloudflareSettingsVM {

    /// Placeholder for the secret field. Signals that a key is already
    /// stored without revealing anything about it — the server never sends
    /// it, so this is the only affordance telling the operator that leaving
    /// the field blank is safe.
    static func secretPlaceholder(secretIsSet: Bool) -> String {
        secretIsSet ? "••••••••  (unchanged — leave blank to keep)" : ""
    }

    /// Whether Test can run. Mirrors `form.testCredentials() != nil`, exposed
    /// separately so the view can disable the button without building a
    /// credentials struct just to throw it away.
    static func canTest(_ form: CloudflareSettingsForm) -> Bool {
        form.testCredentials() != nil
    }

    /// Why Test is unavailable, or nil when it is available.
    ///
    /// The stored-secret case deserves its own sentence: with a key saved
    /// and every other field filled, a disabled Test button otherwise looks
    /// like a bug rather than a consequence of the key being write-only.
    static func testDisabledReason(_ form: CloudflareSettingsForm, secretIsSet: Bool) -> String? {
        guard form.testCredentials() == nil else { return nil }
        let secretTyped = !form.secretAccessKey
            .trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
        if secretIsSet && !secretTyped {
            return "Re-enter the secret access key to test — the saved key is never sent back."
        }
        return "Fill in account ID, bucket, access key ID, and secret access key to test."
    }

    /// One-line summary of the mirror's state for the section footer.
    static func statusSummary(_ config: CloudflareConfig) -> String {
        guard config.enabled else {
            return "Thumbnails are served only from this server. No data leaves your library."
        }
        return "Thumbnails are uploaded to R2 bucket \"\(config.bucket ?? "—")\"."
    }
}
