// StageRuntimeSection.swift — the expanded body of a stage row (#2770).
//
// Shows the stage's description and its two runtime knobs, plus whichever
// stage-specific panel applies. Kept out of WorkersStageRow so the row file
// stays a layout concern and this stays a form concern — and so both remain
// well inside the 400-line soft budget.

import SwiftUI
import MapleCore

struct StageRuntimeSection: View {
    let stage: StageStatus
    let client: WorkersAdminClient
    /// Called after a successful save so the table can re-read status.
    let onSaved: () -> Void

    @State private var form = StageRuntimeForm()
    @State private var seededFrom: StageWorkerConfig?
    @State private var saveState: SaveState = .idle
    @State private var confirmationTask: Task<Void, Never>?

    private enum SaveState: Equatable {
        case idle
        case saving
        case saved
        case failed(String)
    }

    private var meta: StageMeta { StageCatalog.meta(for: stage.name) }

    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            if !meta.description.isEmpty {
                Text(meta.description)
                    .font(.caption)
                    .foregroundStyle(.secondary)
                    .fixedSize(horizontal: false, vertical: true)
            }

            runtimeFields

            HStack(spacing: 10) {
                Button(saveState == .saving ? "Saving…" : "Save") {
                    Task { await save() }
                }
                .buttonStyle(.borderless)
                .controlSize(.small)
                .disabled(saveState == .saving || !form.isDirty(comparedTo: seededFrom))
                .accessibilityIdentifier("workers.runtime.save.\(stage.name)")

                switch saveState {
                case .failed(let message):
                    Label(message, systemImage: "xmark.circle")
                        .font(.caption)
                        .foregroundStyle(.red)
                        .accessibilityIdentifier("workers.runtime.error.\(stage.name)")
                case .saved:
                    Label("Saved.", systemImage: "checkmark.circle")
                        .font(.caption)
                        .foregroundStyle(.green)
                case .idle, .saving:
                    EmptyView()
                }
            }

            StageSpecificPanel(stage: stage, client: client)
        }
        .padding(.top, 4)
        .onAppear { seed() }
        .onChange(of: stage.config) { _, _ in seed() }
        .onDisappear { confirmationTask?.cancel() }
    }

    @ViewBuilder
    private var runtimeFields: some View {
        // Deliberately only these two. pollIntervalMs and batchSize were
        // retired as knobs in #674 — cadence is a global constant, batch is
        // 5×concurrency — and the route 400s if either key is sent.
        HStack(spacing: 12) {
            numberField(
                "Concurrency", text: $form.concurrency,
                hint: "\(StageRuntimeForm.concurrencyRange.lowerBound)–\(StageRuntimeForm.concurrencyRange.upperBound)",
                identifier: "workers.runtime.concurrency.\(stage.name)")
            numberField(
                "Max attempts", text: $form.maxAttempts,
                hint: "\(StageRuntimeForm.maxAttemptsRange.lowerBound)–\(StageRuntimeForm.maxAttemptsRange.upperBound)",
                identifier: "workers.runtime.maxAttempts.\(stage.name)")
        }

        if stage.name == "preview" {
            Text("""
                Also caps on-demand preview regeneration, so raising it affects \
                cache-miss requests as well as the queue.
                """)
                .font(.caption2)
                .foregroundStyle(.secondary)
                .fixedSize(horizontal: false, vertical: true)
        }
    }

    @ViewBuilder
    private func numberField(
        _ label: String, text: Binding<String>, hint: String, identifier: String
    ) -> some View {
        VStack(alignment: .leading, spacing: 2) {
            Text(label)
                .font(.caption)
                .foregroundStyle(.secondary)
            TextField("", text: text)
                .font(.system(.callout, design: .monospaced))
                .frame(maxWidth: 90)
                #if os(iOS)
                .keyboardType(.numberPad)
                #endif
                .accessibilityIdentifier(identifier)
            Text(hint)
                .font(.caption2)
                .foregroundStyle(.secondary)
        }
    }

    private func seed() {
        // Re-seed only when the server's config actually changed, so a
        // status tick every couple of seconds doesn't wipe a half-typed
        // value out from under the operator.
        guard seededFrom != stage.config else { return }
        seededFrom = stage.config
        form = StageRuntimeForm.seeded(from: stage.config)
    }

    @MainActor
    private func save() async {
        guard let patch = form.patch() else { return }
        saveState = .saving
        do {
            let saved = try await client.updateRuntime(stage: stage.name, patch: patch)
            seededFrom = saved
            form = StageRuntimeForm.seeded(from: saved)
            saveState = .saved
            onSaved()
            confirmationTask?.cancel()
            confirmationTask = Task { @MainActor in
                try? await Task.sleep(for: .seconds(2))
                if !Task.isCancelled, saveState == .saved { saveState = .idle }
            }
        } catch {
            saveState = .failed(error.localizedDescription)
        }
    }
}
