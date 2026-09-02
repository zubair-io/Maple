// MirrorSettingsView.swift — the Backup (mirror) maintenance panel on the
// Workers page (T5b, #2772). Mirrors MirrorSettingsComponent
// (src/web/.../workers/mirror-settings.component.ts): per-library backup
// location with a Test action and an enable toggle, plus reconcile status, a
// Reconcile now action, and Retry dead. Reconcile spans every library at
// once (POST /api/mirror/reconcile takes no library id), so it and the
// standing queue counts are shown once beneath the per-library rows.
//
// Polling: status is refreshed once on load, then only re-polled at 1200ms
// while `MaintenancePanelsVM.mirrorShouldPoll` says a reconcile is actively
// running — never unconditionally, per the ticket's own instruction.

import SwiftUI
import MapleCore
import MapleUI

struct MirrorSettingsView: View {
    let client: MirrorConfigClient
    let foldersClient: CloudFoldersClient

    private struct MirrorForm: Equatable {
        var path: String
        var enabled: Bool
    }

    @State private var libraries: [CloudFolder] = []
    @State private var forms: [String: MirrorForm] = [:]
    @State private var saveStates: [String: ServerAdminActionState] = [:]
    @State private var testStates: [String: ServerAdminActionState] = [:]
    @State private var loading = true
    @State private var loadError: String?
    @State private var queue: MirrorQueueStatus.Queue?
    @State private var reconcileProgress: MirrorReconcileProgress?
    @State private var reconcileError: String?
    @State private var retrying = false
    @State private var pollTask: Task<Void, Never>?

    var body: some View {
        Section("Backup") {
            if loading {
                HStack {
                    Text("Loading…").foregroundStyle(.secondary)
                    Spacer()
                    ProgressView().controlSize(.small)
                }
            } else if let loadError {
                MuiBanner(
                    variant: .error, message: "Failed to load mirror config: \(loadError)",
                    actionLabel: "Retry", actionPressed: { Task { await load() } }
                )
                .accessibilityIdentifier("workers.mirror.loadError")
            } else {
                ForEach(libraries) { library in
                    libraryRow(library)
                }
                reconcileSection
            }
        }
        .listRowBackground(MapleTokens.surface)
        .task { await load() }
        .onDisappear { pollTask?.cancel() }
    }

    @ViewBuilder
    private func libraryRow(_ library: CloudFolder) -> some View {
        let form = forms[library.id] ?? MirrorForm(path: "", enabled: true)
        VStack(alignment: .leading, spacing: 6) {
            LabeledContent(library.label) {
                MuiInput(
                    value: Binding(
                        get: { forms[library.id]?.path ?? "" },
                        set: { forms[library.id] = MirrorForm(path: $0, enabled: form.enabled) }),
                    accessibilityLabel: "Backup path for \(library.label)",
                    placeholder: "/Volumes/Backup/\(library.label)", monospaced: true,
                    autocorrectionDisabled: true
                )
                .accessibilityIdentifier("workers.mirror.path.\(library.id)")
            }
            MuiToggle(
                checked: Binding(
                    get: { forms[library.id]?.enabled ?? true },
                    set: { forms[library.id] = MirrorForm(path: form.path, enabled: $0) }),
                label: "Enabled"
            )
            .accessibilityIdentifier("workers.mirror.enabled.\(library.id)")

            HStack(spacing: 8) {
                serverAdminActionButton(
                    "Test", state: testStates[library.id] ?? .idle, successText: "Reachable.",
                    identifier: "workers.mirror.test.\(library.id)",
                    disabled: form.path.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty,
                    action: { Task { await test(library) } }
                )
                serverAdminActionButton(
                    "Save", variant: .primary, state: saveStates[library.id] ?? .idle,
                    successText: "Saved.", identifier: "workers.mirror.save.\(library.id)",
                    action: { Task { await save(library) } }
                )
            }
        }
        .padding(.vertical, 4)
    }

    @ViewBuilder
    private var reconcileSection: some View {
        Divider()
        Text(MaintenancePanelsVM.mirrorSummaryLine(progress: reconcileProgress, queue: queue))
            .font(.caption)
            .foregroundStyle(.secondary)
            .accessibilityIdentifier("workers.mirror.summary")

        HStack(spacing: 8) {
            Button("Reconcile now") { Task { await reconcileNow() } }
                .disabled(MaintenancePanelsVM.mirrorShouldPoll(reconcileProgress))
                .accessibilityIdentifier("workers.mirror.reconcileNow")

            Button("Retry dead") { Task { await retryDead() } }
                .disabled(retrying || (queue?.dead ?? 0) == 0)
                .accessibilityIdentifier("workers.mirror.retryDead")
        }

        if let reconcileError {
            MuiStatusText(state: .error, text: reconcileError)
                .accessibilityIdentifier("workers.mirror.reconcileError")
        }
    }

    // @MainActor because a SwiftUI View is not globally actor-isolated in
    // Swift 5 mode and `.task` takes a @Sendable closure, so an unannotated
    // async method mutating @State would publish from the cooperative pool.
    @MainActor
    private func load() async {
        loading = true
        loadError = nil
        do {
            let libs = try await foldersClient.listFolders()
            libraries = libs
            var seeded: [String: MirrorForm] = [:]
            for lib in libs {
                if let mirrors = try? await client.mirrors(forLibrary: lib.id), let first = mirrors.first {
                    seeded[lib.id] = MirrorForm(path: first.path, enabled: first.enabled)
                } else {
                    seeded[lib.id] = MirrorForm(path: "", enabled: true)
                }
            }
            forms = seeded
            await refreshStatus()
            resumePollingIfNeeded()
        } catch {
            loadError = error.localizedDescription
        }
        loading = false
    }

    @MainActor
    private func test(_ library: CloudFolder) async {
        let path = forms[library.id]?.path.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
        guard !path.isEmpty else { return }
        testStates[library.id] = .running
        do {
            let result = try await client.testPath(path)
            testStates[library.id] = result.ok ? .succeeded : .failed(result.error ?? "Not reachable.")
        } catch {
            testStates[library.id] = .failed(error.localizedDescription)
        }
    }

    @MainActor
    private func save(_ library: CloudFolder) async {
        guard let form = forms[library.id] else { return }
        let path = form.path.trimmingCharacters(in: .whitespacesAndNewlines)
        saveStates[library.id] = .running
        do {
            let mirrors = path.isEmpty ? [] : [MirrorLocation(path: path, enabled: form.enabled)]
            _ = try await client.setMirrors(mirrors, forLibrary: library.id)
            saveStates[library.id] = .succeeded
            await refreshStatus()
        } catch {
            saveStates[library.id] = .failed(error.localizedDescription)
        }
    }

    @MainActor
    private func reconcileNow() async {
        reconcileError = nil
        do {
            let result = try await client.reconcile()
            if !result.started, let reason = result.reason {
                reconcileError = "Reconcile not started: \(reason)"
            }
            await refreshStatus()
            resumePollingIfNeeded()
        } catch {
            reconcileError = error.localizedDescription
        }
    }

    @MainActor
    private func retryDead() async {
        retrying = true
        do {
            _ = try await client.retryDead()
            await refreshStatus()
        } catch {
            reconcileError = error.localizedDescription
        }
        retrying = false
    }

    @MainActor
    private func refreshStatus() async {
        guard let status = try? await client.status() else { return }
        queue = status.queue
        reconcileProgress = status.reconcile
    }

    /// Starts (or leaves stopped) the poll loop based on the freshest
    /// progress — resumes a reconcile that was already running when this
    /// panel appeared (e.g. started from another tab).
    @MainActor
    private func resumePollingIfNeeded() {
        pollTask?.cancel()
        guard MaintenancePanelsVM.mirrorShouldPoll(reconcileProgress) else { return }
        pollTask = Task { @MainActor in
            while !Task.isCancelled {
                try? await Task.sleep(for: .seconds(MaintenancePanelsVM.pollIntervalSeconds))
                if Task.isCancelled { return }
                await refreshStatus()
                if !MaintenancePanelsVM.mirrorShouldPoll(reconcileProgress) { return }
            }
        }
    }
}
