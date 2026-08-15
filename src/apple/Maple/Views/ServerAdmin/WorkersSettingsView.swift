// WorkersSettingsView.swift — Settings → Cloud → Manage → Workers (#2768).
//
// The operator's live view of the pipeline. Two sources feed it: a one-shot
// GET /api/workers/status and the /api/events push stream. `WorkersFeed`
// arbitrates between them — see its docs for why an uncounted frame must not
// overwrite real numbers.
//
// Scope: the collapsed table, header chips, and pause/resume. Dead/damaged
// drawers are #2769; per-stage runtime config is #2770.

import SwiftUI
import MapleCore

struct WorkersSettingsView: View {
    let client: WorkersAdminClient
    let events: WorkerEventsClient

    @State private var feed = WorkersFeed()
    @State private var isLive = false
    @State private var loadError: String?
    @State private var actionError: String?
    @State private var busyStage: String?

    private var stages: [StageStatus] { feed.payload?.stages ?? [] }

    var body: some View {
        Form {
            if let payload = feed.payload {
                summarySection(payload)
                ForEach(StageCatalog.grouped(stages), id: \.group) { entry in
                    if !entry.rows.isEmpty {
                        Section(entry.group.rawValue) {
                            ForEach(entry.rows) { stage in
                                WorkersStageRow(
                                    stage: stage,
                                    onTogglePause: { Task { await togglePause(stage) } },
                                    isBusy: busyStage == stage.name)
                            }
                        }
                        .listRowBackground(MapleTokens.surface)
                    }
                }
            } else if let loadError {
                Section {
                    Text("Failed to load worker status: \(loadError)")
                        .foregroundStyle(.red)
                        .accessibilityIdentifier("workers.loadError")
                    Button("Retry") { Task { await loadFallback() } }
                }
                .listRowBackground(MapleTokens.surface)
            } else {
                Section {
                    HStack {
                        Text("Loading worker status…").foregroundStyle(.secondary)
                        Spacer()
                        ProgressView().controlSize(.small)
                    }
                }
                .listRowBackground(MapleTokens.surface)
            }
        }
        .formStyle(.grouped)
        .mapleSettingsBackground()
        .task { await loadFallback() }
        .task { await consumeEvents() }
    }

    // MARK: - Sections

    @ViewBuilder
    private func summarySection(_ payload: WorkersStatusPayload) -> some View {
        let summary = StageCatalog.summarize(payload.stages)
        Section {
            HStack(spacing: 16) {
                chip("Running", "\(summary.running)")
                chip("Paused", "\(summary.paused)")
                chip("Dead", "\(summary.dead)", tint: summary.dead > 0 ? .red : nil)
                chip("Pending", "\(summary.pending)")
                chip("Damaged", "\(payload.damaged)", tint: payload.damaged > 0 ? .orange : nil)
            }
            .accessibilityIdentifier("workers.summary")

            if let notice = WorkersSettingsVM.connectionNotice(
                isLive: isLive, hasPayload: feed.payload != nil)
            {
                Label(notice, systemImage: "antenna.radiowaves.left.and.right.slash")
                    .font(.caption)
                    .foregroundStyle(.orange)
                    .accessibilityIdentifier("workers.connectionNotice")
            }
            if let actionError {
                Label(actionError, systemImage: "xmark.circle")
                    .font(.caption)
                    .foregroundStyle(.red)
                    .accessibilityIdentifier("workers.actionError")
            }
        }
        .listRowBackground(MapleTokens.surface)
    }

    @ViewBuilder
    private func chip(_ label: String, _ value: String, tint: Color? = nil) -> some View {
        VStack(spacing: 2) {
            Text(value)
                .font(.system(.title3, design: .rounded))
                .foregroundStyle(tint ?? .primary)
            Text(label)
                .font(.caption2)
                .foregroundStyle(.secondary)
        }
    }

    // MARK: - Data

    private func loadFallback() async {
        do {
            let snapshot = try await client.status()
            feed.applyFallback(snapshot)
            loadError = nil
        } catch {
            // Only surface this if the socket hasn't already populated the
            // table — a failed fallback is invisible when live data works.
            if feed.payload == nil { loadError = error.localizedDescription }
        }
    }

    private func consumeEvents() async {
        for await frame in await events.frames() {
            isLive = true
            feed.apply(frame)
        }
        // The stream only finishes when the client stops retrying or the
        // view goes away.
        isLive = false
    }

    private func togglePause(_ stage: StageStatus) async {
        guard busyStage == nil else { return }
        busyStage = stage.name
        actionError = nil
        defer { busyStage = nil }
        do {
            if WorkersSettingsVM.isPausable(stage.status) {
                try await client.pause(stage: stage.name)
            } else {
                try await client.resume(stage: stage.name)
            }
            // No optimistic flip: the next counted frame (≤2s) carries the
            // authoritative state, and guessing wrong here would show a
            // stage as paused while it kept draining its batch.
            await loadFallbackAfterAction()
        } catch {
            actionError = error.localizedDescription
        }
    }

    /// Re-read status straight after a pause/resume so the row updates
    /// without waiting for the next broadcast tick.
    private func loadFallbackAfterAction() async {
        guard let snapshot = try? await client.status() else { return }
        feed.applyAuthoritative(snapshot)
    }
}

#Preview("Unreachable server") {
    WorkersSettingsView(
        client: .preview(),
        events: WorkerEventsClient(
            server: URL(string: "https://preview.maple.invalid")!,
            tokenProvider: { "preview" }))
        .frame(width: 720, height: 620)
}
