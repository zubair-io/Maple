// StageSpecificPanel.swift — the three stage-scoped knobs that live inside
// an expanded row rather than on a page of their own (#2770).
//
//   missing-reaper → prune window, in hours
//   preview        → RAW decode pool size, plus live pool stats
//   migration      → per-migration enable / reset
//
// Anything not in that list renders nothing, which is the common case.

import SwiftUI
import MapleCore

struct StageSpecificPanel: View {
    let stage: StageStatus
    let client: WorkersAdminClient

    var body: some View {
        switch stage.name {
        case "missing-reaper": PruneWindowPanel(client: client)
        case "preview": DecodePoolPanel(client: client)
        case "migration": MigrationsPanel(client: client)
        default: EmptyView()
        }
    }
}

// MARK: - missing-reaper

private struct PruneWindowPanel: View {
    let client: WorkersAdminClient

    @State private var hours: String = ""
    @State private var loaded: Int?
    @State private var error: String?

    var body: some View {
        VStack(alignment: .leading, spacing: 4) {
            Text("PRUNE WINDOW")
                .font(.caption2)
                .foregroundStyle(.secondary)
            HStack(spacing: 8) {
                TextField("", text: $hours)
                    .font(.system(.callout, design: .monospaced))
                    .frame(maxWidth: 90)
                    #if os(iOS)
                    .keyboardType(.numberPad)
                    #endif
                    .accessibilityIdentifier("workers.reaper.hours")
                Text("hours")
                    .font(.caption)
                    .foregroundStyle(.secondary)
                Button("Apply") { Task { await save() } }
                    .buttonStyle(.borderless)
                    .controlSize(.small)
                    .disabled(Int(hours) == nil || Int(hours) == loaded)
            }
            Text("How long a file may stay missing before it is pruned. 1–8760.")
                .font(.caption2)
                .foregroundStyle(.secondary)
            if let error {
                Text(error).font(.caption2).foregroundStyle(.red)
            }
        }
        .task { await load() }
    }

    private func load() async {
        do {
            let value = try await client.pruneWindowHours()
            loaded = value
            hours = String(value)
        } catch {
            self.error = error.localizedDescription
        }
    }

    @MainActor
    private func save() async {
        guard let value = Int(hours) else { return }
        do {
            loaded = try await client.setPruneWindowHours(value)
            error = nil
        } catch {
            self.error = error.localizedDescription
        }
    }
}

// MARK: - preview

private struct DecodePoolPanel: View {
    let client: WorkersAdminClient

    @State private var perf: WorkerPerformance?
    @State private var workers: String = ""
    @State private var error: String?

    var body: some View {
        VStack(alignment: .leading, spacing: 4) {
            Text("RAW DECODE WORKERS")
                .font(.caption2)
                .foregroundStyle(.secondary)
            HStack(spacing: 8) {
                TextField("", text: $workers)
                    .font(.system(.callout, design: .monospaced))
                    .frame(maxWidth: 90)
                    #if os(iOS)
                    .keyboardType(.numberPad)
                    #endif
                    .accessibilityIdentifier("workers.performance.ffiWorkers")
                Button("Apply") { Task { await save() } }
                    .buttonStyle(.borderless)
                    .controlSize(.small)
                    .disabled(Int(workers) == nil || Int(workers) == perf?.ffiWorkers)
            }
            if let perf {
                Text(WorkersRuntimeVM.poolSummary(perf))
                    .font(.caption2)
                    .foregroundStyle(.secondary)
                    .accessibilityIdentifier("workers.performance.pool")
                if let note = WorkersRuntimeVM.sourceNote(perf.source) {
                    Text(note).font(.caption2).foregroundStyle(.orange)
                }
            }
            if let error {
                Text(error).font(.caption2).foregroundStyle(.red)
            }
        }
        .task { await load() }
    }

    private func load() async {
        do {
            let value = try await client.performance()
            perf = value
            workers = String(value.ffiWorkers)
        } catch {
            self.error = error.localizedDescription
        }
    }

    @MainActor
    private func save() async {
        guard let value = Int(workers) else { return }
        do {
            perf = try await client.setFFIWorkers(value)
            workers = String(perf?.ffiWorkers ?? value)
            error = nil
        } catch {
            self.error = error.localizedDescription
        }
    }
}

// MARK: - migration

private struct MigrationsPanel: View {
    let client: WorkersAdminClient

    @State private var migrations: [MigrationInfo] = []
    @State private var error: String?
    @State private var busy: String?

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            Text("MIGRATIONS")
                .font(.caption2)
                .foregroundStyle(.secondary)
            ForEach(migrations) { migration in
                VStack(alignment: .leading, spacing: 3) {
                    HStack {
                        Toggle(
                            migration.title,
                            isOn: Binding(
                                get: { migration.enabled },
                                set: { on in Task { await set(migration, enabled: on) } })
                        )
                        .font(.callout)
                        .disabled(busy == migration.id)
                        .accessibilityIdentifier("workers.migration.toggle.\(migration.id)")
                    }
                    Text(WorkersRuntimeVM.migrationProgress(migration))
                        .font(.caption2)
                        .foregroundStyle(.secondary)
                    if let last = migration.lastError {
                        Text(last).font(.caption2).foregroundStyle(.red).lineLimit(2)
                    }
                    if WorkersRuntimeVM.canReset(migration) {
                        Button("Reset") { Task { await reset(migration) } }
                            .buttonStyle(.borderless)
                            .controlSize(.small)
                            .disabled(busy == migration.id)
                            .accessibilityIdentifier("workers.migration.reset.\(migration.id)")
                    }
                }
            }
            if let error {
                Text(error).font(.caption2).foregroundStyle(.red)
            }
        }
        .task { await load() }
    }

    private func load() async {
        do {
            migrations = try await client.migrations()
            error = nil
        } catch {
            self.error = error.localizedDescription
        }
    }

    @MainActor
    private func set(_ migration: MigrationInfo, enabled: Bool) async {
        busy = migration.id
        defer { busy = nil }
        do {
            try await client.updateMigration(id: migration.id, command: .setEnabled(enabled))
            await load()
        } catch {
            self.error = error.localizedDescription
        }
    }

    @MainActor
    private func reset(_ migration: MigrationInfo) async {
        busy = migration.id
        defer { busy = nil }
        do {
            try await client.updateMigration(id: migration.id, command: .reset)
            await load()
        } catch {
            self.error = error.localizedDescription
        }
    }
}
