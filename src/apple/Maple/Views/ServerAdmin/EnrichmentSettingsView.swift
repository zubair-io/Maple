// EnrichmentSettingsView.swift — Settings → Cloud → Manage → Enrichment
// (T5a, #2771).
//
// Four rows — Describe, Transcribe, Geocode, Meilisearch — each writing to
// the SAME shared `app_settings` document server-side
// (src/api/src/routes/enrichment.ts). Every row is split into its own file
// (DescribeSettingsRow.swift etc.), mirroring the "enrichment forms
// subdivided by stage family" split called out in epic #2765's file-budget
// section, and each row's `patch(echoing:)` sends only the fields that row
// owns (see EnrichmentConfig.swift's file comment for the two required
// passthrough fields every row still has to carry).
//
// Face models and the maintenance panels are #2772 (T5b) and deliberately
// absent — no row here reads or writes a `face_*` field.
//
// Save is unavailable until this page's `.task` resolves the first GET:
// no row exists to save from before then, matching the pattern in
// CloudflareSettingsView / NetworkSettingsView. Saving from an unseeded
// form would echo blank/default base fields onto the PUT and clobber every
// other row's live settings.

import SwiftUI
import MapleCore

/// Shared save/test action lifecycle for the four rows below. Not private
/// to any one row file since all four need the identical states and label
/// rendering — see `actionStateLabel(_:successText:identifier:)`.
enum EnrichmentActionState: Equatable {
    case idle
    case running
    case succeeded
    case failed(String)
}

/// Renders the trailing status label for a save/test action — a red
/// failure message, a green success confirmation, or nothing while idle or
/// running (the button itself already shows a spinner for `.running`).
/// Shared by all four enrichment rows so the four save buttons and three
/// test buttons render identically.
@ViewBuilder
func actionStateLabel(_ state: EnrichmentActionState, successText: String, identifier: String) -> some View {
    switch state {
    case .failed(let message):
        Label(message, systemImage: "xmark.circle")
            .font(.caption)
            .foregroundStyle(.red)
            .accessibilityIdentifier("\(identifier).error")
    case .succeeded:
        Label(successText, systemImage: "checkmark.circle")
            .font(.caption)
            .foregroundStyle(.green)
            .accessibilityIdentifier("\(identifier).success")
    case .idle, .running:
        EmptyView()
    }
}

struct EnrichmentSettingsView: View {
    let client: EnrichmentConfigClient

    private enum LoadState: Equatable {
        case loading
        case loaded(EnrichmentConfig)
        case failed(String)
    }

    @State private var loadState: LoadState = .loading

    var body: some View {
        Form {
            switch loadState {
            case .loading:
                Section {
                    HStack {
                        Text("Loading…").foregroundStyle(.secondary)
                        Spacer()
                        ProgressView().controlSize(.small)
                    }
                }
                .listRowBackground(MapleTokens.surface)
            case .failed(let message):
                Section {
                    Text("Failed to load config: \(message)")
                        .foregroundStyle(.red)
                        .accessibilityIdentifier("enrichment.loadError")
                    Button("Retry") { Task { await load() } }
                }
                .listRowBackground(MapleTokens.surface)
            case .loaded(let config):
                DescribeSettingsRow(
                    client: client, snapshot: config, onSaved: { loadState = .loaded($0) })
                TranscribeSettingsRow(
                    client: client, snapshot: config, onSaved: { loadState = .loaded($0) })
                GeocodeSettingsRow(
                    client: client, snapshot: config, onSaved: { loadState = .loaded($0) })
                MeilisearchSettingsRow(
                    client: client, snapshot: config, onSaved: { loadState = .loaded($0) })
            }
        }
        .formStyle(.grouped)
        .mapleSettingsBackground()
        .task { await load() }
    }

    private func load() async {
        loadState = .loading
        do {
            let config = try await client.fetch()
            loadState = .loaded(config)
        } catch {
            loadState = .failed(error.localizedDescription)
        }
    }
}

#Preview("Unreachable server") {
    EnrichmentSettingsView(client: .preview())
        .frame(width: 620, height: 760)
}
