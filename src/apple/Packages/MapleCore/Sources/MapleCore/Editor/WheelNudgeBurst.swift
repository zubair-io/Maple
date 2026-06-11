// WheelNudgeBurst.swift — wheel-nudge undo coalescing (#1099 / #1125).
//
// Extracted verbatim from EditorState.swift when #1108 pushed that file
// over the per-file LoC budget; the type is self-contained.

import Foundation

/// Decides when a wheel armed-tool nudge starts a new undo burst.
/// Detents within a burst share one undo snapshot (committing per
/// detent would flood the 32-entry ring); a pause longer than `window`
/// OR a change of the armed (tool, subParam) pair ends the burst. The
/// pair identity is tracked alongside the timestamp because a purely
/// time-based window lets "scroll Tool A → switch → scroll Tool B
/// within the window" land both targets' edits in one snapshot, making
/// undo misbehave across tools (#1125 review) — the same reasoning
/// extends to sub-params (#1108): Luminance → Color within the window
/// must snapshot separately.
///
/// Pure value type next to the rest of the zoom/nudge logic in
/// MapleCore so the burst decision is unit-testable (the SwiftUI
/// `EditorView` host is not).
public struct WheelNudgeBurst: Equatable, Sendable {
    /// Pause that ends a burst — mirrors `DragBar`'s feel of a gesture
    /// boundary for detented input.
    public static let window: TimeInterval = 0.5

    private var lastNudgeAt: Date = .distantPast
    private var lastTool: Tool?
    private var lastSubParamId: String?

    public init() {}

    /// Record a nudge on the (tool, subParam) pair at `now`. Returns
    /// `true` when this nudge starts a NEW burst — the caller snapshots
    /// undo state before applying the edit.
    public mutating func beginsNewBurst(
        tool: Tool, subParamId: String? = nil, at now: Date
    ) -> Bool {
        defer {
            lastNudgeAt = now
            lastTool = tool
            lastSubParamId = subParamId
        }
        return tool != lastTool
            || subParamId != lastSubParamId
            || now.timeIntervalSince(lastNudgeAt) > Self.window
    }
}
