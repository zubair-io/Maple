// MaintenancePanelsVM.swift — pure-function view-model helpers shared by the
// three maintenance/rendering panels on the Workers page (T5b, #2772):
// MirrorSettingsView, DerivativeAuditSettingsView, RenderConfigSettingsView.
//
// Pattern (issue #192): no SwiftUI import, unit-testable in isolation. The
// one rule with real risk here is the polling cadence — the ticket calls out
// that Mirror and derivative-audit must poll at 1200ms ONLY while a pass is
// running and stop when idle, mirroring MirrorSettingsComponent /
// DerivativeAuditSettingsComponent (workers.component.ts). An always-on poll
// against a self-hosted server is a real cost, so `shouldPoll` is the single
// source of truth both panels' `refreshStatus()` consults after every fetch.

import Foundation
import MapleCore

enum MaintenancePanelsVM {

    /// Poll interval while a mirror reconcile or derivative-audit pass is
    /// running. Matches the web components exactly.
    static let pollIntervalSeconds: Double = 1.2

    // MARK: - Mirror

    /// Whether the Mirror panel should keep polling `GET /api/mirror/status`.
    /// True only while the reconcile is actively scanning or copying — an
    /// idle or absent (never-run) progress means stop.
    static func mirrorShouldPoll(_ progress: MirrorReconcileProgress?) -> Bool {
        guard let progress else { return false }
        return progress.phase != .idle
    }

    /// One-line summary for the panel header: the active stage, else the
    /// standing queue depth, else "Up to date".
    static func mirrorSummaryLine(progress: MirrorReconcileProgress?, queue: MirrorQueueStatus.Queue?)
        -> String
    {
        if let progress {
            switch progress.phase {
            case .scanning:
                return "Scanning · \(progress.scan.scanned) checked · \(progress.scan.toCopy) to copy"
            case .copying:
                let errors = progress.copy.errors > 0 ? " · \(progress.copy.errors) failed" : ""
                return "Copying · \(progress.copy.copied)/\(progress.copy.total) · "
                    + "\(progress.copy.remaining) left\(errors)"
            case .idle:
                break
            }
        }
        if let queue, queue.pending > 0 || queue.dead > 0 {
            return "\(queue.pending) pending · \(queue.dead) failed"
        }
        return "Up to date"
    }

    // MARK: - Derivative audit

    /// Whether the Derivative-audit panel should keep polling
    /// `GET /api/derivative-audit/status`. True only while a pass is
    /// actually running server-side.
    static func derivativeAuditShouldPoll(_ progress: DerivativeAuditSummary?) -> Bool {
        progress?.running ?? false
    }

    /// One-line last-pass readout for the panel header.
    static func derivativeAuditSummaryLine(config: DerivativeAuditConfig?, progress: DerivativeAuditSummary?)
        -> String
    {
        guard let progress, progress.finishedAt != nil else {
            return (config?.enabled ?? false) ? "Not run yet" : ""
        }
        let errors = progress.errors > 0 ? " · \(progress.errors) errors" : ""
        return "Last pass: \(progress.scanned) scanned · \(progress.reArmed) re-armed\(errors)"
    }

    /// Per-stage re-arm counts of the last pass, sorted by stage name for a
    /// stable render order.
    static func derivativeAuditStageCounts(_ progress: DerivativeAuditSummary?) -> [(
        stage: String, count: Int
    )] {
        (progress?.byStage ?? [:]).sorted { $0.key < $1.key }.map { ($0.key, $0.value) }
    }

    // MARK: - Render config (GPU live render)

    /// What the local app is actually doing right now — Apple's own
    /// build-time/env kill switch, independent of the saved operator value.
    /// Mirrors the web panel's `localGpuEnabled` split
    /// (gpu-live-render-settings.component.ts).
    static func renderStatusLabel(localGpuEnabled: Bool) -> String {
        localGpuEnabled ? "GPU" : "CPU fallback"
    }

    /// Provenance readout: whether the saved value is an explicit operator
    /// choice or the built-in default.
    static func renderProvenanceLine(_ config: RenderConfig?) -> String {
        guard let config else { return "Not loaded" }
        return config.source.gpuLiveRenderEnabled == .db ? "Set by operator" : "Default (no value saved)"
    }
}
