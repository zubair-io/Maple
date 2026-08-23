// MuiPipelineMonitor.swift — Maple UI Organisms · Configuration
// (unified-component-catalog.md §4.8). Live per-stage status and metrics
// for the worker pipeline (src/api/src/workers/stages/ — exif, thumb,
// describe, geocode), built from List Row, Progress, Badge, Empty State.

import SwiftUI

public enum MuiPipelineStageStatus: Sendable {
    case running, paused, done, error
}

public struct MuiPipelineStage: Identifiable, Sendable {
    public let id: String
    public let name: String
    public let status: MuiPipelineStageStatus
    public let processed: Int
    public let total: Int

    public init(id: String, name: String, status: MuiPipelineStageStatus, processed: Int, total: Int) {
        self.id = id
        self.name = name
        self.status = status
        self.processed = processed
        self.total = total
    }
}

public struct MuiPipelineMonitor: View {
    public let stages: [MuiPipelineStage]
    public let stagePauseToggled: ((String) -> Void)?
    public let stageRetried: ((String) -> Void)?

    public init(stages: [MuiPipelineStage], stagePauseToggled: ((String) -> Void)? = nil, stageRetried: ((String) -> Void)? = nil) {
        self.stages = stages
        self.stagePauseToggled = stagePauseToggled
        self.stageRetried = stageRetried
    }

    public var body: some View {
        VStack(alignment: .leading, spacing: MuiTokens.spacingSm) {
            if stages.isEmpty {
                MuiEmptyState(icon: "gearshape.2", title: "No pipeline stages", message: "Stages appear once the worker registers them.")
            } else {
                MuiProgress(shape: .bar, value: Double(Self.overallProgress(stages)), label: "\(Self.overallProgress(stages))% overall")

                VStack(spacing: 0) {
                    ForEach(stages) { stage in
                        stageRow(stage)
                    }
                }
                .background(MuiTokens.surface, in: RoundedRectangle(cornerRadius: MuiTokens.radiusLg, style: .continuous))
            }
        }
    }

    private func stageRow(_ stage: MuiPipelineStage) -> some View {
        MuiListRow(icon: Self.statusIcon(stage.status), label: stage.name, subtitle: "\(stage.processed)/\(stage.total)", trailing: {
            HStack(spacing: MuiTokens.spacingSm) {
                MuiBadge(variant: Self.badgeVariant(stage.status), value: Self.statusLabel(stage.status))
                if Self.canToggle(stage) {
                    MuiButton(label: stage.status == .running ? "Pause" : "Resume", variant: .ghost, size: .sm) { stagePauseToggled?(stage.id) }
                }
                if stage.status == .error {
                    MuiButton(label: "Retry", variant: .ghost, size: .sm) { stageRetried?(stage.id) }
                }
            }
        })
    }

    // MARK: - Pure logic (unit-testable without a live view)

    public static func overallProgress(_ stages: [MuiPipelineStage]) -> Int {
        guard !stages.isEmpty else { return 0 }
        let totals = stages.reduce((processed: 0, total: 0)) { acc, stage in (acc.processed + stage.processed, acc.total + stage.total) }
        guard totals.total > 0 else { return 0 }
        return Int((Double(totals.processed) / Double(totals.total) * 100).rounded())
    }

    public static func stageProgress(_ stage: MuiPipelineStage) -> Int {
        guard stage.total > 0 else { return 0 }
        return Int((Double(stage.processed) / Double(stage.total) * 100).rounded())
    }

    public static func canToggle(_ stage: MuiPipelineStage) -> Bool {
        stage.status == .running || stage.status == .paused
    }

    public static func statusLabel(_ status: MuiPipelineStageStatus) -> String {
        switch status {
        case .running: return "Running"
        case .paused: return "Paused"
        case .done: return "Done"
        case .error: return "Error"
        }
    }

    public static func badgeVariant(_ status: MuiPipelineStageStatus) -> MuiBadgeVariant {
        status == .running || status == .error ? .signal : .count
    }

    private static func statusIcon(_ status: MuiPipelineStageStatus) -> String {
        switch status {
        case .running: return "clock.arrow.circlepath"
        case .paused: return "pause.circle"
        case .done: return "checkmark.circle"
        case .error: return "xmark.circle"
        }
    }
}

#Preview("MuiPipelineMonitor") {
    MuiPipelineMonitor(stages: [
        MuiPipelineStage(id: "exif", name: "EXIF", status: .done, processed: 4200, total: 4200),
        MuiPipelineStage(id: "thumb", name: "Thumbnails", status: .running, processed: 3100, total: 4200),
        MuiPipelineStage(id: "describe", name: "Describe", status: .paused, processed: 900, total: 4200),
        MuiPipelineStage(id: "geocode", name: "Geocode", status: .error, processed: 0, total: 4200),
    ])
    .padding()
    .frame(width: 320)
    .background(MuiTokens.bg)
}
