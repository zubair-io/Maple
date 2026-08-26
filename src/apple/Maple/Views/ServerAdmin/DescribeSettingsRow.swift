// DescribeSettingsRow.swift — the Describe row on Settings → Cloud →
// Manage → Enrichment (T5a, #2771).
//
// Local vision-LLM via Ollama. Only the URL is editable; the model is
// locked in code (`EnrichmentModels.describeModel`) and rendered read-only
// with no picker — the describe stage only parses that model's exact
// output shape, so it is not operator-configurable.

import SwiftUI
import MapleCore
import MapleUI

struct DescribeSettingsRow: View {
    let client: EnrichmentConfigClient
    let snapshot: EnrichmentConfig
    let onSaved: (EnrichmentConfig) -> Void

    // Seeded once from the snapshot present when this row first appears —
    // see EnrichmentSettingsView.swift's file comment. `snapshot` itself
    // (a plain `let`, not `@State`) still refreshes on every re-render, so
    // `patch(echoing:)` at Save time always echoes the freshest base fields.
    @State private var form: DescribeSettingsForm
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
        Section("Describe") {
            LabeledContent("Ollama URL") {
                TextField("", text: $form.providerURL, prompt: Text("http://localhost:11434"))
                    .font(.system(.body, design: .monospaced))
                    #if os(iOS)
                    .autocorrectionDisabled()
                    .textInputAutocapitalization(.never)
                    #endif
                    .accessibilityIdentifier("enrichment.describe.providerURL")
            }

            LabeledContent("Model") {
                Text(EnrichmentModels.describeModel)
                    .font(.system(.body, design: .monospaced))
                    .foregroundStyle(.secondary)
            }
            .accessibilityIdentifier("enrichment.describe.model")
            Text("Locked in code — the describe stage only accepts this model's output shape.")
                .font(.caption)
                .foregroundStyle(.secondary)

            serverAdminActionButton(
                "Test", state: testState, successText: "Connected.",
                identifier: "enrichment.describe.test",
                action: { Task { await test() } }
            )

            serverAdminActionButton(
                "Save", variant: .primary, state: saveState, successText: "Saved.",
                identifier: "enrichment.describe.save",
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
            // Re-seed from the server's answer, matching CloudflareSettingsView.
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
        testState = .running
        do {
            try await client.testDescribe(providerURL: form.testProviderURL())
            testState = .succeeded
        } catch {
            testState = .failed(error.localizedDescription)
        }
    }
}
