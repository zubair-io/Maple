// WorkersStageRow.swift — one stage line in the Workers table.
//
// Split from WorkersSettingsView to keep both files well under the 400-line
// soft budget, and because #2769/#2770 will grow this row with an expansion
// body (dead-job drawer, runtime config).

import SwiftUI
import MapleCore

struct WorkersStageRow: View {
    let stage: StageStatus
    /// Nil while a pause/resume for this stage is in flight.
    let onTogglePause: (() -> Void)?
    let isBusy: Bool

    private var meta: StageMeta { StageCatalog.meta(for: stage.name) }

    var body: some View {
        HStack(spacing: 10) {
            Image(systemName: meta.icon)
                .frame(width: 18)
                .foregroundStyle(.secondary)

            VStack(alignment: .leading, spacing: 2) {
                Text(stage.name)
                    .font(.system(.body, design: .monospaced))
                HStack(spacing: 5) {
                    Circle()
                        .fill(toneColor)
                        .frame(width: 7, height: 7)
                    Text(StageCatalog.statusLabel(stage.status))
                        .font(.caption)
                        .foregroundStyle(.secondary)
                }
            }

            Spacer(minLength: 8)

            metric(WorkersSettingsVM.inFlightLabel(stage), caption: "in flight")
            metric(WorkersSettingsVM.pendingLabel(stage), caption: "ready")
                .help(StageCatalog.pendingDetail(stage))
            metric("\(stage.dead)", caption: "dead")
                .foregroundStyle(stage.dead > 0 ? .red : .primary)
            metric(WorkersSettingsVM.throughputLabel(stage.throughput), caption: "rate")

            Button(WorkersSettingsVM.pauseActionLabel(stage.status)) {
                onTogglePause?()
            }
            .controlSize(.small)
            .disabled(onTogglePause == nil || isBusy)
            .accessibilityIdentifier("workers.toggle.\(stage.name)")
        }
        .padding(.vertical, 3)
        .accessibilityElement(children: .contain)
        .accessibilityIdentifier("workers.stage.\(stage.name)")
    }

    private var toneColor: Color {
        switch WorkersSettingsVM.statusTone(stage.status) {
        case .active: return .green
        case .idle: return .secondary
        case .fault: return .red
        }
    }

    @ViewBuilder
    private func metric(_ value: String, caption: String) -> some View {
        VStack(alignment: .trailing, spacing: 1) {
            Text(value)
                .font(.system(.callout, design: .monospaced))
            Text(caption)
                .font(.caption2)
                .foregroundStyle(.secondary)
        }
        .frame(minWidth: 56, alignment: .trailing)
    }
}
