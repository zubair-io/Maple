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
import MapleUI

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
                    MuiBanner(
                        variant: .error, message: "Failed to load config: \(message)",
                        actionLabel: "Retry", actionPressed: { Task { await load() } }
                    )
                    .accessibilityIdentifier("enrichment.loadError")
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

    // @MainActor because a SwiftUI View is not globally actor-isolated in
    // Swift 5 mode and `.task` takes a @Sendable closure, so an unannotated
    // async method mutating @State would publish from the cooperative pool.
    @MainActor
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
