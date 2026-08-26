// MeilisearchSettingsRow.swift — the Meilisearch row on Settings → Cloud →
// Manage → Enrichment (T5a, #2771).
//
// Carries two rules ported from `meilisearchFormToPatch` (workers.vm.ts):
// a blank API key OMITS the field so the saved key survives (it is
// write-only and never seeded back — same as the Cloudflare secret in T1),
// and the three numerics (timeout, semantic blend, rate limit) reset to
// `null` rather than clamp when out of range. See MeilisearchConfigPatch's
// doc comment for the exact per-field wire rules.

import SwiftUI
import MapleCore
import MapleUI

struct MeilisearchSettingsRow: View {
    let client: EnrichmentConfigClient
    let snapshot: EnrichmentConfig
    let onSaved: (EnrichmentConfig) -> Void

    @State private var form: MeilisearchSettingsForm
    @State private var saveState: ServerAdminActionState = .idle
    @State private var testState: ServerAdminActionState = .idle
    @State private var saveConfirmationTask: Task<Void, Never>?

    private var apiKeyIsSet: Bool { snapshot.meilisearchAPIKeySet }

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
        Section("Meilisearch") {
            LabeledContent("URL") {
                TextField("", text: $form.url, prompt: Text("http://localhost:7700"))
                    .font(.system(.body, design: .monospaced))
                    #if os(iOS)
                    .autocorrectionDisabled()
                    .textInputAutocapitalization(.never)
                    #endif
                    .accessibilityIdentifier("enrichment.meilisearch.url")
            }

            LabeledContent("API key") {
                SecureField(
                    "", text: $form.apiKey,
                    prompt: Text(EnrichmentSettingsVM.meilisearchAPIKeyPlaceholder(apiKeyIsSet: apiKeyIsSet)))
                    .font(.system(.body, design: .monospaced))
                    .accessibilityIdentifier("enrichment.meilisearch.apiKey")
            }
            Text("Write-only — never sent back. Leave blank to keep the saved key.")
                .font(.caption)
                .foregroundStyle(.secondary)

            Toggle("Enable hybrid semantic search", isOn: $form.semanticEnabled)
                .accessibilityIdentifier("enrichment.meilisearch.semanticEnabled")

            LabeledContent("Ollama URL (from Describe)") {
                Text(snapshot.meilisearchEmbedderURL)
                    .font(.system(.body, design: .monospaced))
                    .foregroundStyle(.secondary)
            }
            .accessibilityIdentifier("enrichment.meilisearch.embedderURL")

            LabeledContent("Embedding model") {
                TextField("", text: $form.embedderModel, prompt: Text("bge-m3"))
                    .font(.system(.body, design: .monospaced))
                    .accessibilityIdentifier("enrichment.meilisearch.embedderModel")
            }

            LabeledContent("Semantic blend") {
                TextField("", text: $form.semanticRatio, prompt: Text("0.5"))
                    #if os(iOS)
                    .keyboardType(.decimalPad)
                    #endif
                    .accessibilityIdentifier("enrichment.meilisearch.semanticRatio")
            }
            Text("0 to 1 in 0.05 steps. Out-of-range resets to the default, not the nearest edge.")
                .font(.caption)
                .foregroundStyle(.secondary)

            LabeledContent("Index task timeout (sec)") {
                TextField("", text: $form.taskTimeoutSeconds, prompt: Text("600"))
                    #if os(iOS)
                    .keyboardType(.numberPad)
                    #endif
                    .accessibilityIdentifier("enrichment.meilisearch.taskTimeout")
            }
            Text("30 to 3600. Out-of-range resets to the default, not the nearest edge.")
                .font(.caption)
                .foregroundStyle(.secondary)

            LabeledContent("Search rate limit (req/min)") {
                TextField("", text: $form.serviceRateLimitPerMinute, prompt: Text("60"))
                    #if os(iOS)
                    .keyboardType(.numberPad)
                    #endif
                    .accessibilityIdentifier("enrichment.meilisearch.serviceRateLimit")
            }
            Text("1 to 10000. Out-of-range resets to the default, not the nearest edge.")
                .font(.caption)
                .foregroundStyle(.secondary)

            serverAdminActionButton(
                "Test", state: testState, successText: "Connected.",
                identifier: "enrichment.meilisearch.test",
                disabledReason: EnrichmentSettingsVM.meilisearchTestDisabledReason(form),
                disabled: form.testCredentials() == nil,
                action: { Task { await test() } }
            )

            serverAdminActionButton(
                "Save", variant: .primary, state: saveState, successText: "Saved.",
                identifier: "enrichment.meilisearch.save",
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
        guard let credentials = form.testCredentials() else { return }
        testState = .running
        do {
            try await client.testMeilisearch(url: credentials.url, apiKey: credentials.apiKey)
            testState = .succeeded
        } catch {
            testState = .failed(error.localizedDescription)
        }
    }
}
