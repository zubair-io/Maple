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

struct GeocodeSettingsRow: View {
    let client: EnrichmentConfigClient
    let snapshot: EnrichmentConfig
    let onSaved: (EnrichmentConfig) -> Void

    @State private var form: GeocodeSettingsForm
    @State private var saveState: EnrichmentActionState = .idle
    @State private var testState: EnrichmentActionState = .idle
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

            Button {
                Task { await test() }
            } label: {
                HStack {
                    Text(testState == .running ? "Testing…" : "Test")
                    if testState == .running {
                        Spacer()
                        ProgressView().controlSize(.small)
                    }
                }
            }
            .disabled(form.testURL() == nil || testState == .running)
            .accessibilityIdentifier("enrichment.geocode.test")
            if let reason = EnrichmentSettingsVM.geocodeTestDisabledReason(form) {
                Text(reason)
                    .font(.caption)
                    .foregroundStyle(.secondary)
                    .accessibilityIdentifier("enrichment.geocode.testDisabledReason")
            }
            actionStateLabel(
                testState, successText: "Connected.", identifier: "enrichment.geocode.testResult")

            Button {
                Task { await save() }
            } label: {
                HStack {
                    Text(saveState == .running ? "Saving…" : "Save")
                    if saveState == .running {
                        Spacer()
                        ProgressView().controlSize(.small)
                    }
                }
            }
            .disabled(saveState == .running)
            .accessibilityIdentifier("enrichment.geocode.save")
            actionStateLabel(
                saveState, successText: "Saved.", identifier: "enrichment.geocode.saveResult")
        }
        .listRowBackground(MapleTokens.surface)
        .onDisappear { saveConfirmationTask?.cancel() }
    }

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
