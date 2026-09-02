// FaceDetectSettingsRow.swift — the Face-detect row on Settings → Cloud →
// Manage → Enrichment (T5b, #2772).
//
// Owns the shared model directory plus the detector's own download URL /
// sha256 / minimum face size. Sends ONLY those fields on save — never a
// face_recognizer_* key, which belongs to FaceEmbedSettingsRow and would
// otherwise be clobbered with this row's stale seeded-at-load copy (the
// merge hazard called out in the ticket, workers.component.ts:459-526).
//
// Embeds the sub-threshold face purge panel (FacePurgePanel) beneath the
// fields, matching the web layout (workers.component.html's face-detect
// case) — the purge is scoped by the SAME face_min_detection_size this row
// edits, so it lives here rather than as a fifth top-level enrichment row.

import SwiftUI
import MapleCore
import MapleUI

struct FaceDetectSettingsRow: View {
    let client: EnrichmentConfigClient
    let purgeClient: FacePurgeClient
    let snapshot: EnrichmentConfig
    let onSaved: (EnrichmentConfig) -> Void

    @State private var form: FaceDetectSettingsForm
    @State private var saveState: ServerAdminActionState = .idle
    @State private var saveConfirmationTask: Task<Void, Never>?

    init(
        client: EnrichmentConfigClient, purgeClient: FacePurgeClient, snapshot: EnrichmentConfig,
        onSaved: @escaping (EnrichmentConfig) -> Void
    ) {
        self.client = client
        self.purgeClient = purgeClient
        self.snapshot = snapshot
        self.onSaved = onSaved
        self._form = State(initialValue: .seeded(from: snapshot))
    }

    var body: some View {
        Section("Face detect") {
            modelStatusBanner

            LabeledContent("Model directory") {
                MuiInput(
                    value: $form.modelDir, accessibilityLabel: "Model directory",
                    placeholder: "~/.maple/models/", monospaced: true, autocorrectionDisabled: true
                )
                .accessibilityIdentifier("enrichment.faceDetect.modelDir")
            }
            Text("Where the worker stages scrfd_10g.onnx and arcface_r100_glint360k.onnx.")
                .font(.caption)
                .foregroundStyle(.secondary)

            LabeledContent("Detector download URL") {
                MuiInput(
                    value: $form.detectorURL, accessibilityLabel: "Detector download URL",
                    placeholder: "https://example.com/scrfd_10g.onnx", monospaced: true,
                    autocorrectionDisabled: true
                )
                .accessibilityIdentifier("enrichment.faceDetect.detectorURL")
            }
            Text("Used only when the file isn't already in the model dir. Empty auto-downloads.")
                .font(.caption)
                .foregroundStyle(.secondary)

            LabeledContent("Detector sha256") {
                MuiInput(
                    value: $form.detectorSHA256, accessibilityLabel: "Detector sha256",
                    placeholder: "optional sha256 (hex)", monospaced: true, autocorrectionDisabled: true
                )
                .accessibilityIdentifier("enrichment.faceDetect.detectorSHA256")
            }

            LabeledContent("Minimum face size") {
                TextField("", text: $form.minDetectionSize, prompt: Text("0.06"))
                    #if os(iOS)
                    .keyboardType(.decimalPad)
                    #endif
                    .accessibilityIdentifier("enrichment.faceDetect.minSize")
            }
            Text(
                "Fraction of the 640-px detection frame (0 to 0.99). Blank resets to the default "
                    + "— never sent as 0, which would silently disable the filter."
            )
            .font(.caption)
            .foregroundStyle(.secondary)

            serverAdminActionButton(
                "Save", variant: .primary, state: saveState, successText: "Saved.",
                identifier: "enrichment.faceDetect.save",
                action: { Task { await save() } }
            )
        }
        .listRowBackground(MapleTokens.surface)
        .onDisappear { saveConfirmationTask?.cancel() }

        Section {
            FacePurgePanel(client: purgeClient)
        }
        .listRowBackground(MapleTokens.surface)
    }

    @ViewBuilder
    private var modelStatusBanner: some View {
        let headline = EnrichmentSettingsVM.faceModelStatusHeadline(snapshot.faceModels)
        if let detector = snapshot.faceModels?.detector {
            MuiBanner(
                variant: snapshot.faceModels?.status == .loaded ? .success : .warning,
                message: "\(headline) scrfd_10g.onnx · \(EnrichmentSettingsVM.formatModelBytes(detector.bytes)) · \(detector.path)"
            )
            .accessibilityIdentifier("enrichment.faceDetect.statusBanner")
        }
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
