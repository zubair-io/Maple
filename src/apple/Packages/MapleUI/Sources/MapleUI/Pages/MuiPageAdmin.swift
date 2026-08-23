// MuiPageAdmin.swift — Maple UI Pages (unified-component-catalog.md §6).
// Settings Shell hosting Pipeline Monitor, Setup Wizard, Backup Monitor,
// and Diagnostics — Self Hosted's operator console.
//
// The Shell's section nav picks which one organism the Pane shows, a
// direct switch over the active section (same shape as Settings). The
// genuinely new wiring at this tier: pausing/resuming or retrying a
// pipeline stage is applied to this page's own `stages` array —
// `MuiPageAdmin.togglingPause` / `retrying` are the pure reducers behind
// those two paths (Pipeline Monitor only emits the stage id; it doesn't
// know how to flip its own status, same "organism emits, page decides"
// split as Settings' revoke/invite). The Setup Wizard's own step-gating
// is already organism-tested, so it's wired here with no page-level
// reducer of its own.

import SwiftUI

public enum MuiPageAdminSectionId: String, CaseIterable, Identifiable, Sendable {
    case pipeline, setup, backups, diagnostics

    public var id: String { rawValue }
    public var label: String {
        switch self {
        case .pipeline: return "Pipeline"
        case .setup: return "Setup"
        case .backups: return "Backups"
        case .diagnostics: return "Diagnostics"
        }
    }
    public var icon: String {
        switch self {
        case .pipeline: return "gearshape.2"
        case .setup: return "wand.and.stars"
        case .backups: return "externaldrive.badge.checkmark"
        case .diagnostics: return "stethoscope"
        }
    }
}

public struct MuiPageAdmin: View {
    @State private var activeSectionId: MuiPageAdminSectionId = .pipeline
    @State private var stages: [MuiPipelineStage]
    @State private var wizardStepIndex = 0
    @State private var backupDestination = "/volumes/backups"
    @State private var backupSchedule = "Nightly at 2am"
    @State private var setupServerHost = "maple.local"
    @State private var setupStoragePath = "/volumes/photos"

    public init(stages: [MuiPipelineStage] = MuiPageAdmin.defaultStages) {
        self._stages = State(initialValue: stages)
    }

    public var body: some View {
        MuiSettingsShell {
            VStack(spacing: 0) {
                ForEach(MuiPageAdminSectionId.allCases) { section in
                    MuiListRow(icon: section.icon, label: section.label, active: section.id == activeSectionId.id, pressed: { activeSectionId = section })
                }
            }
        } pane: {
            switch activeSectionId {
            case .pipeline:
                MuiPipelineMonitor(
                    stages: stages,
                    stagePauseToggled: { id in stages = Self.togglingPause(stages, id: id) },
                    stageRetried: { id in stages = Self.retrying(stages, id: id) }
                )
            case .setup:
                MuiSetupWizard(steps: ["Server", "Storage", "Review"], stepIndex: $wizardStepIndex) { index in
                    switch index {
                    case 0: MuiFormField(label: "Server host", value: $setupServerHost)
                    case 1: MuiFormField(label: "Storage path", value: $setupStoragePath)
                    default: MuiText("Ready to finish setup.", variant: .body, color: .muted)
                    }
                }
            case .backups:
                MuiBackupMonitor(
                    destinationPath: $backupDestination, schedule: $backupSchedule,
                    lastResult: MuiBackupResult(message: "Last backup completed 2 hours ago.", variant: .success)
                )
            case .diagnostics:
                MuiDiagnostics(checks: Self.defaultChecks, output: "gpu: adapter \"Apple M4\" — 24 cores")
            }
        }
        .background(MuiTokens.bg)
    }

    // MARK: - Pure wiring logic (unit-testable without a live view)

    /// `stages` with the matching stage's status flipped between running
    /// and paused — a no-op on a stage that's `done` or `error`, since
    /// Pipeline Monitor's own `canToggle` already hides the pause/resume
    /// button for those, so this only ever needs to handle the two
    /// toggleable statuses.
    public static func togglingPause(_ stages: [MuiPipelineStage], id: String) -> [MuiPipelineStage] {
        stages.map { stage in
            guard stage.id == id, MuiPipelineMonitor.canToggle(stage) else { return stage }
            let nextStatus: MuiPipelineStageStatus = stage.status == .running ? .paused : .running
            return MuiPipelineStage(id: stage.id, name: stage.name, status: nextStatus, processed: stage.processed, total: stage.total)
        }
    }

    /// `stages` with the matching errored stage reset to `running` — a
    /// retry always resumes from its last processed count rather than
    /// zeroing it, matching the real worker stages' resumable design
    /// (docs/best-practices.md's stage `dependsOn`/rearm contract).
    public static func retrying(_ stages: [MuiPipelineStage], id: String) -> [MuiPipelineStage] {
        stages.map { stage in
            guard stage.id == id, stage.status == .error else { return stage }
            return MuiPipelineStage(id: stage.id, name: stage.name, status: .running, processed: stage.processed, total: stage.total)
        }
    }

    // MARK: - Default mock data

    public static let defaultStages: [MuiPipelineStage] = [
        MuiPipelineStage(id: "exif", name: "EXIF", status: .done, processed: 4_200, total: 4_200),
        MuiPipelineStage(id: "thumb", name: "Thumbnails", status: .running, processed: 3_100, total: 4_200),
        MuiPipelineStage(id: "describe", name: "Describe", status: .paused, processed: 900, total: 4_200),
        MuiPipelineStage(id: "geocode", name: "Geocode", status: .error, processed: 0, total: 4_200),
    ]

    public static let defaultChecks: [MuiDiagnosticCheck] = [
        MuiDiagnosticCheck(id: "1", label: "XMP sidecars readable", status: .pass),
        MuiDiagnosticCheck(id: "2", label: "Rust core loaded", status: .pass),
        MuiDiagnosticCheck(id: "3", label: "GPU pipeline available", status: .pass),
        MuiDiagnosticCheck(id: "4", label: "MongoDB reachable", status: .pending),
    ]
}

#Preview("MuiPageAdmin") {
    MuiPageAdmin()
        .frame(width: 700, height: 460)
}
