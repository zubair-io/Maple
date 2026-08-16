// DescribeSettingsRow.swift — the Describe row on Settings → Cloud →
// Manage → Enrichment (T5a, #2771).
//
// Local vision-LLM via Ollama. Only the URL is editable; the model is
// locked in code (`EnrichmentModels.describeModel`) and rendered read-only
// with no picker — the describe stage only parses that model's exact
// output shape, so it is not operator-configurable.

import SwiftUI
import MapleCore

struct DescribeSettingsRow: View {
    let client: EnrichmentConfigClient
    let snapshot: EnrichmentConfig
    let onSaved: (EnrichmentConfig) -> Void

    // Seeded once from the snapshot present when this row first appears —
    // see EnrichmentSettingsView.swift's file comment. `snapshot` itself
    // (a plain `let`, not `@State`) still refreshes on every re-render, so
    // `patch(echoing:)` at Save time always echoes the freshest base fields.
    @State private var form: DescribeSettingsForm
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
            .disabled(testState == .running)
            .accessibilityIdentifier("enrichment.describe.test")
            actionStateLabel(
                testState, successText: "Connected.", identifier: "enrichment.describe.testResult")

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
            .accessibilityIdentifier("enrichment.describe.save")
            actionStateLabel(
                saveState, successText: "Saved.", identifier: "enrichment.describe.saveResult")
        }
        .listRowBackground(MapleTokens.surface)
        .onDisappear { saveConfirmationTask?.cancel() }
    }

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
