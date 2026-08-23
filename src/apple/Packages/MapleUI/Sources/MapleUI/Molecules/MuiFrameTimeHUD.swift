// MuiFrameTimeHUD.swift — Maple UI Molecules-L1 (unified-component-catalog.md
// §2.3). Performance readout overlay, built from Text only. Color-codes
// against Maple's own perf invariants (16ms slider-tick target, 50ms hard
// limit — CONTRIBUTING.md "Performance invariants") so the HUD itself flags
// a budget breach rather than just reporting a number.

import SwiftUI

public enum MuiFrameTimeStatus: Sendable {
    case good, warn, bad
}

public struct MuiFrameTimeHUD: View {
    public let frameMs: Double
    public let fps: Int?
    /// Target frame budget in ms — at/under this is `good`.
    public let budgetMs: Double
    /// Hard limit in ms — over this is `bad`; between budget and this is
    /// `warn`.
    public let hardLimitMs: Double

    public init(frameMs: Double, fps: Int? = nil, budgetMs: Double = 16, hardLimitMs: Double = 50) {
        self.frameMs = frameMs
        self.fps = fps
        self.budgetMs = budgetMs
        self.hardLimitMs = hardLimitMs
    }

    public var body: some View {
        let status = Self.status(frameMs: frameMs, budgetMs: budgetMs, hardLimitMs: hardLimitMs)
        MuiText(
            "\(String(format: "%.1f", frameMs))ms avg · \(Self.displayFps(frameMs: frameMs, fps: fps))fps",
            variant: .valueChip,
            color: .main
        )
        .padding(.horizontal, MuiTokens.spacingSm)
        .padding(.vertical, 4)
        .background(Self.color(for: status).opacity(0.18), in: Capsule())
        .overlay(Capsule().stroke(Self.color(for: status), lineWidth: 1))
        .accessibilityElement(children: .combine)
    }

    /// The rounded frames-per-second readout — `fps` when explicitly
    /// supplied, otherwise derived from `frameMs`. Public + static so this
    /// is unit-testable without rendering a view.
    public static func displayFps(frameMs: Double, fps: Int?) -> Int {
        if let fps { return fps }
        guard frameMs > 0 else { return 0 }
        return Int((1000 / frameMs).rounded())
    }

    /// Classifies `frameMs` against the budget/hard-limit thresholds.
    /// Public + static so this is unit-testable without rendering a view.
    public static func status(frameMs: Double, budgetMs: Double, hardLimitMs: Double) -> MuiFrameTimeStatus {
        if frameMs > hardLimitMs { return .bad }
        if frameMs > budgetMs { return .warn }
        return .good
    }

    private static func color(for status: MuiFrameTimeStatus) -> Color {
        switch status {
        case .good: return MuiTokens.successText
        case .warn: return MuiTokens.warn
        case .bad: return MuiTokens.errorText
        }
    }
}

#Preview("MuiFrameTimeHUD") {
    VStack(spacing: 12) {
        MuiFrameTimeHUD(frameMs: 11.2)
        MuiFrameTimeHUD(frameMs: 28.4)
        MuiFrameTimeHUD(frameMs: 62.1)
    }
    .padding()
    .background(MuiTokens.imageCanvas)
}
