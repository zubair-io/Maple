// FaceEmbedSettingsRow.swift — the Face-embed row on Settings → Cloud →
// Manage → Enrichment (T5b, #2772).
//
// Recognizer-only slice — see FaceDetectSettingsRow's note. The model
// directory is owned by the face-detect row, so it is deliberately not
// shown or sent here.

import SwiftUI
import MapleCore
import MapleUI

struct FaceEmbedSettingsRow: View {
    let client: EnrichmentConfigClient
    let snapshot: EnrichmentConfig
    let onSaved: (EnrichmentConfig) -> Void

    @State private var form: FaceEmbedSettingsForm
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
        Section("Face embed") {
            modelStatusBanner

            LabeledContent("Recognizer download URL") {
                MuiInput(
                    value: $form.recognizerURL, accessibilityLabel: "Recognizer download URL",
                    placeholder: "https://example.com/arcface_r100_glint360k.onnx", monospaced: true,
                    autocorrectionDisabled: true
                )
                .accessibilityIdentifier("enrichment.faceEmbed.recognizerURL")
            }
            Text("Used only when the file isn't already in the model dir. Empty auto-downloads.")
                .font(.caption)
                .foregroundStyle(.secondary)

            LabeledContent("Recognizer sha256") {
                MuiInput(
                    value: $form.recognizerSHA256, accessibilityLabel: "Recognizer sha256",
                    placeholder: "optional sha256 (hex)", monospaced: true, autocorrectionDisabled: true
                )
                .accessibilityIdentifier("enrichment.faceEmbed.recognizerSHA256")
            }

            serverAdminActionButton(
                "Save", variant: .primary, state: saveState, successText: "Saved.",
                identifier: "enrichment.faceEmbed.save",
                action: { Task { await save() } }
            )
        }
        .listRowBackground(MapleTokens.surface)
        .onDisappear { saveConfirmationTask?.cancel() }
    }

    @ViewBuilder
    private var modelStatusBanner: some View {
        let headline = EnrichmentSettingsVM.faceModelStatusHeadline(snapshot.faceModels)
        if let recognizer = snapshot.faceModels?.recognizer {
            MuiBanner(
                variant: snapshot.faceModels?.status == .loaded ? .success : .warning,
                message: "\(headline) arcface_r100_glint360k.onnx · \(EnrichmentSettingsVM.formatModelBytes(recognizer.bytes)) · \(recognizer.path)"
            )
            .accessibilityIdentifier("enrichment.faceEmbed.statusBanner")
        }
    }

    // @MainActor — see FaceDetectSettingsRow's identical note.
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
