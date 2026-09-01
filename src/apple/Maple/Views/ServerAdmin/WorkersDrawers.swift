// WorkersDrawers.swift — dead-job and damaged-asset triage (#2769).
//
// Both are read-through: they fetch on open rather than subscribing,
// because neither list rides the `/api/events` feed. Kept in their own file
// so WorkersSettingsView stays well inside the 400-line soft budget as
// #2770 grows the row.
//
// Presented as sheets on every platform. A macOS-style side drawer would
// need a bespoke overlay, and on iPhone the same list has to work in a
// narrow column anyway — one presentation is fewer ways to be wrong.

import SwiftUI
import MapleCore

// MARK: - Dead jobs

struct DeadJobsDrawer: View {
    let stage: String
    let client: WorkersAdminClient
    let onDismiss: () -> Void

    @State private var jobs: [DeadJob]?
    @State private var loadError: String?
    @State private var isRetrying = false
    @State private var retryNote: String?

    var body: some View {
        NavigationStack {
            List {
                if let retryNote {
                    Text(retryNote)
                        .font(.caption)
                        .foregroundStyle(.secondary)
                        .accessibilityIdentifier("workers.dead.retryNote")
                }
                if let loadError {
                    Text(loadError)
                        .foregroundStyle(.red)
                        .accessibilityIdentifier("workers.dead.error")
                } else if let jobs {
                    if jobs.isEmpty {
                        ContentUnavailableView(
                            "No dead jobs", systemImage: "checkmark.circle",
                            description: Text("Nothing on \(stage) has exhausted its retries."))
                    } else {
                        ForEach(jobs) { job in
                            DeadJobRow(job: job)
                        }
                    }
                } else {
                    HStack {
                        Text("Loading…").foregroundStyle(.secondary)
                        Spacer()
                        ProgressView().controlSize(.small)
                    }
                }
            }
            .navigationTitle("Dead jobs · \(stage)")
            #if !os(macOS)
            .navigationBarTitleDisplayMode(.inline)
            #endif
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button("Done", action: onDismiss)
                }
                ToolbarItem(placement: .primaryAction) {
                    Button(isRetrying ? "Retrying…" : "Retry all") {
                        Task { await retryAll() }
                    }
                    .disabled(isRetrying || jobs?.isEmpty != false)
                    .accessibilityIdentifier("workers.dead.retryAll")
                }
            }
            .task { await load() }
        }
    }

    // @MainActor: a SwiftUI View is not globally actor-isolated in Swift 5
    // mode and `.task`/`Task {}` closures run on the cooperative pool by
    // default, so an unannotated async method mutating @State is a
    // "publishing changes from background threads" hazard (#2887 — same fix
    // already applied to NetworkSettingsView and CloudflareSettingsView).

    @MainActor
    private func load() async {
        do {
            jobs = try await client.deadJobs(stage: stage)
            loadError = nil
        } catch {
            loadError = error.localizedDescription
        }
    }

    @MainActor
    private func retryAll() async {
        isRetrying = true
        defer { isRetrying = false }
        do {
            let result = try await client.retryDead(stage: stage)
            // Report the server's count rather than assuming success:
            // "Re-armed 0" means something else already cleared them, which
            // is a different situation from the call failing.
            retryNote = WorkersTriageVM.retryNote(affected: result.affected)
            await load()
        } catch {
            loadError = error.localizedDescription
        }
    }
}

private struct DeadJobRow: View {
    let job: DeadJob

    var body: some View {
        VStack(alignment: .leading, spacing: 3) {
            Text(WorkersTriageVM.pathDisplay(job.absPath))
                .font(.system(.callout, design: .monospaced))
                .lineLimit(2)
                .truncationMode(.middle)
            if let error = job.lastError {
                Text(error)
                    .font(.caption)
                    .foregroundStyle(.red)
                    .lineLimit(3)
            }
            Text(WorkersTriageVM.deadJobDetail(job))
                .font(.caption2)
                .foregroundStyle(.secondary)
        }
        .padding(.vertical, 2)
        .listRowBackground(MapleTokens.surface)
    }
}

// MARK: - Damaged assets

struct DamagedAssetsDrawer: View {
    let client: WorkersAdminClient
    let onDismiss: () -> Void

    @State private var assets: [DamagedAsset]?
    @State private var loadError: String?
    @State private var busy = false
    @State private var clearNote: String?
    @State private var confirmingClearAll = false

    var body: some View {
        NavigationStack {
            List {
                if let clearNote {
                    Text(clearNote)
                        .font(.caption)
                        .foregroundStyle(.secondary)
                        .accessibilityIdentifier("workers.damaged.clearNote")
                }
                if let loadError {
                    Text(loadError)
                        .foregroundStyle(.red)
                        .accessibilityIdentifier("workers.damaged.error")
                } else if let assets {
                    if assets.isEmpty {
                        ContentUnavailableView(
                            "Nothing damaged", systemImage: "checkmark.circle",
                            description: Text("No assets are parked as unreadable."))
                    } else {
                        ForEach(assets) { asset in
                            DamagedAssetRow(asset: asset, isBusy: busy) {
                                Task { await clear(id: asset.id) }
                            }
                        }
                    }
                } else {
                    HStack {
                        Text("Loading…").foregroundStyle(.secondary)
                        Spacer()
                        ProgressView().controlSize(.small)
                    }
                }
            }
            .navigationTitle("Damaged assets")
            #if !os(macOS)
            .navigationBarTitleDisplayMode(.inline)
            #endif
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button("Done", action: onDismiss)
                }
                ToolbarItem(placement: .primaryAction) {
                    Button("Clear all") { confirmingClearAll = true }
                        .disabled(busy || assets?.isEmpty != false)
                        .accessibilityIdentifier("workers.damaged.clearAll")
                }
            }
            // Clear-all re-queues every damaged asset at once. It is not
            // destructive, but on a large library it re-admits thousands of
            // files to the pipeline, so it asks first.
            .confirmationDialog(
                "Clear all damaged tags and re-queue?",
                isPresented: $confirmingClearAll, titleVisibility: .visible
            ) {
                Button("Clear all", role: .destructive) {
                    Task { await clear(id: nil) }
                }
                Button("Cancel", role: .cancel) {}
            }
            .task { await load() }
        }
    }

    @MainActor
    private func load() async {
        do {
            assets = try await client.damagedAssets()
            loadError = nil
        } catch {
            loadError = error.localizedDescription
        }
    }

    @MainActor
    private func clear(id: String?) async {
        busy = true
        defer { busy = false }
        do {
            let result = try await client.clearDamaged(id: id)
            clearNote = WorkersTriageVM.clearNote(affected: result.affected)
            await load()
        } catch {
            loadError = error.localizedDescription
        }
    }
}

private struct DamagedAssetRow: View {
    let asset: DamagedAsset
    let isBusy: Bool
    let onClear: () -> Void

    var body: some View {
        HStack(alignment: .top, spacing: 8) {
            VStack(alignment: .leading, spacing: 3) {
                Text(WorkersTriageVM.pathDisplay(asset.absPath))
                    .font(.system(.callout, design: .monospaced))
                    .lineLimit(2)
                    .truncationMode(.middle)
                if let reason = asset.reason {
                    Text(reason)
                        .font(.caption)
                        .foregroundStyle(.orange)
                        .lineLimit(2)
                }
                Text(WorkersTriageVM.damagedDetail(asset))
                    .font(.caption2)
                    .foregroundStyle(.secondary)
            }
            Spacer(minLength: 4)
            Button("Clear", action: onClear)
                .controlSize(.small)
                .disabled(isBusy)
                .accessibilityIdentifier("workers.damaged.clear.\(asset.id)")
        }
        .padding(.vertical, 2)
        .listRowBackground(MapleTokens.surface)
    }
}
