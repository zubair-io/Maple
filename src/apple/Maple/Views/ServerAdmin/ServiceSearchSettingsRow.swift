// ServiceSearchSettingsRow.swift — the service search row on Settings →
// Cloud → Manage → Enrichment (T5a, #2771).
//
// One field: the per-key request budget for the external asset-search
// endpoint. Out-of-range resets to `null` rather than clamping — see
// ServiceSearchConfigPatch's doc comment.

import SwiftUI
import MapleCore
import MapleUI

struct ServiceSearchSettingsRow: View {
    let client: EnrichmentConfigClient
    let snapshot: EnrichmentConfig
    let onSaved: (EnrichmentConfig) -> Void

    @State private var form: ServiceSearchSettingsForm
    @State private var saveState: ServerAdminActionState = .idle
    @State private var saveConfirmationTask: Task<Void, Never>?

    init(
        client: EnrichmentConfigClient, snapshot: EnrichmentConfig,
        onSaved: @escaping (EnrichmentConfig) -> Void
    ) {
        self.client = client
        self.snapshot = snapshot
        self.onSaved = onSaved
        self._form = State(initialValue: .seeded(from: snapshot))
    }

    var body: some View {
        Section("Service search") {
            LabeledContent("Search rate limit (req/min)") {
                TextField("", text: $form.serviceRateLimitPerMinute, prompt: Text("60"))
                    #if os(iOS)
                    .keyboardType(.numberPad)
                    #endif
                    .accessibilityIdentifier("enrichment.serviceSearch.serviceRateLimit")
            }
            Text("1 to 10000. Out-of-range resets to the default, not the nearest edge.")
                .font(.caption)
                .foregroundStyle(.secondary)

            serverAdminActionButton(
                "Save", variant: .primary, state: saveState, successText: "Saved.",
                identifier: "enrichment.serviceSearch.save",
                action: { Task { await save() } }
            )
        }
        .listRowBackground(MapleTokens.surface)
        .onDisappear { saveConfirmationTask?.cancel() }
    }

    // @MainActor because a SwiftUI View is not globally actor-isolated in
    // Swift 5 mode and `.task` takes a @Sendable closure, so an unannotated
    // async method mutating @State would publish from the cooperative pool.
    @MainActor
    private func save() async {
        saveState = .running
        do {
            let config = try await client.save(form.patch(echoing: snapshot))
            form = .seeded(from: config)
            onSaved(config)
            saveState = .succeeded
            saveConfirmationTask?.cancel()
            saveConfirmationTask = Task { @MainActor in
                try? await Task.sleep(for: .seconds(2))
                if !Task.isCancelled, saveState == .succeeded { saveState = .idle }
            }
        } catch {
            saveState = .failed(error.localizedDescription)
        }
    }
}
