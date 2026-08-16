// WorkersSettingsView+VM.swift — Pure-function view-model helpers for the
// Workers page.
//
// Pattern (issue #192): no SwiftUI import, unit-testable in isolation. That
// constraint is why `statusTone` returns a semantic case rather than a
// `Color` — the view owns the palette, this file owns the meaning.

import Foundation
import MapleCore

enum WorkersSettingsVM {

    /// Semantic colour role for a stage's status dot. Mirrors the web's
    /// three hex values (#4ade80 / #a8a29e / #f87171) without importing a
    /// UI framework to say so.
    enum StatusTone: Equatable {
        case active
        case idle
        case fault
    }

    static func statusTone(_ state: StageRunState) -> StatusTone {
        switch state {
        case .running: return .active
        case .error: return .fault
        case .paused, .starting, .restarting, .stopped, .unknown: return .idle
        }
    }

    /// Throughput as items per minute, or an em-dash when a stage has done
    /// nothing. Zero is rendered as "—" rather than "0 /min" so an idle
    /// stage doesn't read as a stalled one.
    static func throughputLabel(_ throughput: Double) -> String {
        guard throughput > 0 else { return "—" }
        return "\(Int(throughput.rounded())) /min"
    }

    /// In-flight against the batch ceiling, e.g. "2 / 8".
    ///
    /// The ceiling comes from the stage config, which the uncounted
    /// snapshot nulls — `deriveBatchSize(0)` makes it 0 — so a "/ 0" would
    /// be reporting a server-side placeholder as a real limit.
    static func inFlightLabel(_ stage: StageStatus, counted: Bool = true) -> String {
        guard counted, stage.batchSize > 0 else { return "\(stage.inFlight)" }
        return "\(stage.inFlight) / \(stage.batchSize)"
    }

    /// Placeholder for a count the server hasn't actually computed yet.
    ///
    /// The uncounted snapshot zeroes `ready`, `blocked` and `dead` rather
    /// than omitting them, so rendering it verbatim claims a stage has no
    /// backlog when it may have hundreds of thousands (#2910). An em-dash
    /// says "not known yet", which is the truth.
    static let unknownCount = "—"

    /// Queue depth, annotating the blocked share when there is one.
    ///
    /// Blocked means an upstream stage hasn't produced what this one needs.
    /// Surfacing it inline matters because a stage sitting at zero ready
    /// with thousands blocked looks broken until you know that.
    static func pendingLabel(_ stage: StageStatus, counted: Bool = true) -> String {
        guard counted else { return unknownCount }
        guard stage.blocked > 0 else { return "\(stage.ready)" }
        return "\(stage.ready) · \(stage.blocked) blkd"
    }

    /// Dead count, or the unknown marker before counts have been computed.
    static func deadLabel(_ stage: StageStatus, counted: Bool = true) -> String {
        counted ? "\(stage.dead)" : unknownCount
    }

    /// Banner shown while only the registry snapshot has arrived.
    ///
    /// Without it the page looks like a fully-idle pipeline rather than one
    /// whose numbers haven't loaded — the failure in #2910, where a stage
    /// with 27,080 dead jobs displayed a confident `0`.
    static func countsPendingNotice(hasCountedData: Bool, hasPayload: Bool) -> String? {
        guard hasPayload, !hasCountedData else { return nil }
        return "Queue counts haven't loaded yet — showing live status only."
    }

    /// Whether the row's action pauses (true) or resumes (false).
    static func isPausable(_ state: StageRunState) -> Bool {
        state != .paused
    }

    static func pauseActionLabel(_ state: StageRunState) -> String {
        isPausable(state) ? "Pause" : "Resume"
    }

    /// Connection banner text, or nil when the live feed is healthy.
    ///
    /// Only shown once something has been displayed: before the first
    /// payload the page already shows its own loading state, and stacking a
    /// "reconnecting" banner on top of that is noise.
    static func connectionNotice(isLive: Bool, hasPayload: Bool) -> String? {
        guard hasPayload, !isLive else { return nil }
        return "Live updates disconnected — reconnecting."
    }
}
