// ServerAdminActionState.swift — shared save/test action lifecycle for
// Settings → Cloud → Manage pages (#3021, MA1: Apple Settings + ServerAdmin
// onto MapleUI).
//
// Every ServerAdmin config page follows the same shape: a button that runs
// an async save/test request and shows a spinner while it's in flight,
// followed by a status line reporting success (auto-clearing after ~2s) or
// failure. Before this file that pattern was hand-rolled per screen —
// EnrichmentSettingsView's `actionStateLabel` (shared by its four rows),
// CloudflareSettingsView's private `ActionState`/`stateLabel` (an exact
// copy), and NetworkSettingsView's three separate `@State` flags
// (`isSaving`/`saveError`/`didSave`) doing the same job with a wider
// surface. Collapsed here into one state enum plus one view builder on top
// of `MuiButton`/`MuiStatusText`, so every page renders identically and
// only one place needs to change.

import SwiftUI
import MapleUI

enum ServerAdminActionState: Equatable {
    case idle
    case running
    case succeeded
    case failed(String)
}

/// Renders a save/test action button plus its trailing status line.
///
/// `label` is static — MuiButton's own `isLoading` spinner communicates the
/// in-flight state, replacing the old per-file "Saving…"/"Testing…" verb
/// swap. `disabledReason`, when non-nil, renders as a caption between the
/// button and the status line (the "why is Test disabled" explanation
/// Geocode/Meilisearch/Cloudflare all show).
///
/// `successIdentifier`/`failureIdentifier` default to `"<identifier>Result"`
/// + `.success`/`.error`, matching the convention Enrichment and Cloudflare
/// already used; pass explicit overrides for a screen (e.g. Network) that
/// shipped different accessibility identifiers before this migration, so
/// existing automation keeps working.
@ViewBuilder
func serverAdminActionButton(
    _ label: String,
    variant: MuiButtonVariant = .secondary,
    state: ServerAdminActionState,
    successText: String,
    identifier: String,
    disabledReason: String? = nil,
    disabledReasonIdentifier: String? = nil,
    successIdentifier: String? = nil,
    failureIdentifier: String? = nil,
    disabled: Bool = false,
    action: @escaping () -> Void
) -> some View {
    MuiButton(
        label: label, variant: variant,
        isLoading: state == .running, disabled: disabled || state == .running,
        action: action
    )
    .accessibilityIdentifier(identifier)

    if let disabledReason {
        Text(disabledReason)
            .font(.caption)
            .foregroundStyle(.secondary)
            .accessibilityIdentifier(disabledReasonIdentifier ?? "\(identifier)DisabledReason")
    }

    switch state {
    case .failed(let message):
        MuiStatusText(state: .error, text: message)
            .accessibilityIdentifier(failureIdentifier ?? "\(identifier)Result.error")
    case .succeeded:
        MuiStatusText(state: .saved, text: successText)
            .accessibilityIdentifier(successIdentifier ?? "\(identifier)Result.success")
    case .idle, .running:
        EmptyView()
    }
}
