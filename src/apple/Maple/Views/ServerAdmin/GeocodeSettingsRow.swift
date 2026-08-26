// GeocodeSettingsRow.swift — the Geocode row on Settings → Cloud → Manage
// → Enrichment (T5a, #2771).
//
// The one row where the required base field and the row-owned field
// coincide: `nominatim_url` is both a field every PUT must carry and the
// URL this row actually edits. See GeocodeConfigPatch's doc comment for why
// an out-of-range rate is sent through unclamped rather than reset to null
// — that rule is specific to the three Meilisearch numerics on the next row.

import SwiftUI
import MapleCore
import MapleUI

struct GeocodeSettingsRow: View {
    let client: EnrichmentConfigClient
    let snapshot: EnrichmentConfig
    let onSaved: (EnrichmentConfig) -> Void

    @State private var form: GeocodeSettingsForm
    @State private var saveState: ServerAdminActionState = .idle
    @State private var testState: ServerAdminActionState = .idle
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
        Section("Geocode") {
            LabeledContent("Nominatim URL") {
                TextField("", text: $form.nominatimURL, prompt: Text("https://nominatim.example.com"))
                    .font(.system(.body, design: .monospaced))
                    #if os(iOS)
                    .autocorrectionDisabled()
                    .textInputAutocapitalization(.never)
                    #endif
                    .accessibilityIdentifier("enrichment.geocode.nominatimURL")
            }

            LabeledContent("Rate limit (req/sec)") {
                TextField("", text: $form.rateLimitPerSec, prompt: Text("10"))
                    #if os(iOS)
                    .keyboardType(.decimalPad)
                    #endif
                    .accessibilityIdentifier("enrichment.geocode.rateLimit")
            }
            Text("0.1 to 100. Out-of-range values are rejected on save, not clamped.")
                .font(.caption)
                .foregroundStyle(.secondary)

            serverAdminActionButton(
                "Test", state: testState, successText: "Connected.",
                identifier: "enrichment.geocode.test",
                disabledReason: EnrichmentSettingsVM.geocodeTestDisabledReason(form),
                disabled: form.testURL() == nil,
                action: { Task { await test() } }
            )

            serverAdminActionButton(
                "Save", variant: .primary, state: saveState, successText: "Saved.",
                identifier: "enrichment.geocode.save",
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
        testState = .idle
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

    @MainActor
    private func test() async {
        guard let url = form.testURL() else { return }
        testState = .running
        do {
            try await client.testGeocode(nominatimURL: url)
            testState = .succeeded
        } catch {
            testState = .failed(error.localizedDescription)
        }
    }
}
