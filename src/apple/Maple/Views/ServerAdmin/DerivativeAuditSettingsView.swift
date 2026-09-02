// DerivativeAuditSettingsView.swift — the derivative-audit maintenance
// panel on the Workers page (T5b, #2772). Mirrors
// DerivativeAuditSettingsComponent
// (src/web/.../workers/derivative-audit-settings.component.ts): an enable
// toggle, the runtime knobs (max resets/pass, cadence in hours, concurrency,
// deep R2 check), a Run now action, and the last-pass readout.
//
// Polling: status is refreshed once on load, then only re-polled at 1200ms
// while `MaintenancePanelsVM.derivativeAuditShouldPoll` says a pass is
// actively running server-side — never unconditionally.

import SwiftUI
import MapleCore
import MapleUI

struct DerivativeAuditSettingsView: View {
    let client: DerivativeAuditConfigClient

    private struct Draft: Equatable {
        var maxResetsPerPass: String
        var intervalHours: String
        var concurrency: String
        var deepR2Enabled: Bool
    }

    @State private var config: DerivativeAuditConfig?
    @State private var progress: DerivativeAuditSummary?
    @State private var draft: Draft?
    @State private var loading = true
    @State private var loadError: String?
    @State private var saveState: ServerAdminActionState = .idle
    @State private var runState: ServerAdminActionState = .idle
    @State private var pollTask: Task<Void, Never>?

    var body: some View {
        Section("Derivative audit") {
            if loading {
                HStack {
                    Text("Loading…").foregroundStyle(.secondary)
                    Spacer()
                    ProgressView().controlSize(.small)
                }
            } else if let loadError {
                MuiBanner(
                    variant: .error, message: "Failed to load derivative-audit config: \(loadError)",
                    actionLabel: "Retry", actionPressed: { Task { await load() } }
                )
                .accessibilityIdentifier("workers.derivativeAudit.loadError")
            } else if let config, let draft {
                loadedBody(config, draft)
            }
        }
        .listRowBackground(MapleTokens.surface)
        .task { await load() }
        .onDisappear { pollTask?.cancel() }
    }

    @ViewBuilder
    private func loadedBody(_ config: DerivativeAuditConfig, _ draft: Draft) -> some View {
        MuiToggle(
            checked: Binding(
                get: { config.enabled }, set: { next in Task { await toggleEnabled(next) } }),
            label: "Re-arm drifted derivatives automatically"
        )
        .accessibilityIdentifier("workers.derivativeAudit.enabled")

        Text(MaintenancePanelsVM.derivativeAuditSummaryLine(config: config, progress: progress))
            .font(.caption)
            .foregroundStyle(.secondary)
            .accessibilityIdentifier("workers.derivativeAudit.summary")

        LabeledContent("Max resets per pass") {
            TextField("", text: draftBinding(\.maxResetsPerPass), prompt: Text("500"))
                #if os(iOS)
                .keyboardType(.numberPad)
                #endif
                .accessibilityIdentifier("workers.derivativeAudit.maxResets")
        }

        LabeledContent("Scan interval (hours)") {
            TextField("", text: draftBinding(\.intervalHours), prompt: Text("6"))
                #if os(iOS)
                .keyboardType(.decimalPad)
                #endif
                .accessibilityIdentifier("workers.derivativeAudit.intervalHours")
        }

        LabeledContent("Concurrency") {
            TextField("", text: draftBinding(\.concurrency), prompt: Text("8"))
                #if os(iOS)
                .keyboardType(.numberPad)
                #endif
                .accessibilityIdentifier("workers.derivativeAudit.concurrency")
        }

        MuiToggle(
            checked: draftBinding(\.deepR2Enabled), label: "Deep-check Cloudflare R2 objects"
        )
        .accessibilityIdentifier("workers.derivativeAudit.deepR2")

        if !MaintenancePanelsVM.derivativeAuditStageCounts(progress).isEmpty {
            ForEach(MaintenancePanelsVM.derivativeAuditStageCounts(progress), id: \.stage) { row in
                LabeledContent(row.stage, value: "\(row.count)")
                    .font(.caption)
            }
        }

        HStack(spacing: 8) {
            serverAdminActionButton(
                "Save", variant: .primary, state: saveState, successText: "Saved.",
                identifier: "workers.derivativeAudit.save",
                action: { Task { await save() } }
            )
            serverAdminActionButton(
                "Run now", state: runState, successText: "Started.",
                identifier: "workers.derivativeAudit.runNow",
                disabled: MaintenancePanelsVM.derivativeAuditShouldPoll(progress),
                action: { Task { await runNow() } }
            )
        }
    }

    private func draftBinding(_ keyPath: WritableKeyPath<Draft, String>) -> Binding<String> {
        Binding(
            get: { draft?[keyPath: keyPath] ?? "" },
            set: { newValue in draft?[keyPath: keyPath] = newValue })
    }

    private func draftBinding(_ keyPath: WritableKeyPath<Draft, Bool>) -> Binding<Bool> {
        Binding(
            get: { draft?[keyPath: keyPath] ?? false },
            set: { newValue in draft?[keyPath: keyPath] = newValue })
    }

    // @MainActor — see MirrorSettingsView's identical note.
    @MainActor
    private func load() async {
        loading = true
        loadError = nil
        do {
            let status = try await client.status()
            apply(status.config)
            progress = status.progress
            resumePollingIfNeeded()
        } catch {
            loadError = error.localizedDescription
        }
        loading = false
    }

    @MainActor
    private func apply(_ newConfig: DerivativeAuditConfig) {
        config = newConfig
        draft = Draft(
            maxResetsPerPass: String(newConfig.maxResetsPerPass),
            intervalHours: Self.hours(fromMs: newConfig.intervalMs),
            concurrency: String(newConfig.concurrency),
            deepR2Enabled: newConfig.deepR2Enabled)
    }

    private static func hours(fromMs ms: Int) -> String {
        let hours = Double(ms) / 3_600_000
        return hours.truncatingRemainder(dividingBy: 1) == 0 ? String(Int(hours)) : String(hours)
    }

    @MainActor
    private func toggleEnabled(_ enabled: Bool) async {
        let previous = config
        config = previous.map {
            DerivativeAuditConfig(
                enabled: enabled, intervalMs: $0.intervalMs, maxResetsPerPass: $0.maxResetsPerPass,
                concurrency: $0.concurrency, deepR2Enabled: $0.deepR2Enabled)
        }
        do {
            let saved = try await client.save(DerivativeAuditConfigPatch(enabled: enabled))
            apply(saved)
        } catch {
            config = previous
            loadError = error.localizedDescription
        }
    }

    @MainActor
    private func save() async {
        guard let draft else { return }
        guard let maxResets = Int(draft.maxResetsPerPass), let hours = Double(draft.intervalHours),
            let concurrency = Int(draft.concurrency)
        else {
            saveState = .failed("Enter whole numbers for resets/pass and concurrency.")
            return
        }
        saveState = .running
        do {
            let saved = try await client.save(
                DerivativeAuditConfigPatch(
                    intervalMs: Int((hours * 3_600_000).rounded()), maxResetsPerPass: maxResets,
                    concurrency: concurrency, deepR2Enabled: draft.deepR2Enabled))
            apply(saved)
            saveState = .succeeded
        } catch {
            saveState = .failed(error.localizedDescription)
        }
    }

    @MainActor
    private func runNow() async {
        runState = .running
        do {
            let result = try await client.run()
            if !result.started, let reason = result.reason {
                runState = .failed("Not started: \(reason)")
            } else {
                runState = .succeeded
            }
            await refreshProgress()
            resumePollingIfNeeded()
        } catch {
            runState = .failed(error.localizedDescription)
        }
    }

    @MainActor
    private func refreshProgress() async {
        guard let status = try? await client.status() else { return }
        progress = status.progress
    }

    @MainActor
    private func resumePollingIfNeeded() {
        pollTask?.cancel()
        guard MaintenancePanelsVM.derivativeAuditShouldPoll(progress) else { return }
        pollTask = Task { @MainActor in
            while !Task.isCancelled {
                try? await Task.sleep(for: .seconds(MaintenancePanelsVM.pollIntervalSeconds))
                if Task.isCancelled { return }
                await refreshProgress()
                if !MaintenancePanelsVM.derivativeAuditShouldPoll(progress) { return }
            }
        }
    }
}
