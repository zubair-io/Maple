// RenderTypes.swift — small value types shared across the edit-session
// render layer.
//
// Split from EditSession.swift (issue #120) so the residual `EditSession`
// type holds only live working state. These types are the public protocol
// between EditSession and its callers (Views, tests, the rendering layer).

import Foundation
import os

// MARK: - Loggers

// Subsystem used by the slider → render boundary so Console filtering lets a
// user confirm that slider ticks are actually reaching the render scheduler.
// Filter in Console.app with: subsystem:app.justmaple.aperture category:EditSession
//
// `internal` (default) so the render / hydration / deep-zoom extensions in
// sibling files in this module can share the same Logger instance.
let editSessionLogger = Logger(
    subsystem: "app.justmaple.aperture",
    category: "EditSession"
)

// Signposter for the render pipeline. Surfaced in Instruments (Points of
// Interest + Timeline) so the cold-open waterfall is visible without extra
// tooling. Events we emit:
//   - "open"           event  on ensureRenderStarted entry
//   - "embedded paint" event  when the embedded JPEG lands on screen
//   - "fast"           interval for the fast-phase render pass
//   - "refine"         interval for the refine-phase render pass
//   - "decode"         interval around the Rust decode call
// To view: Xcode → Open Developer Tool → Instruments → Points of Interest,
// or Profile the app and filter by subsystem.
let editSessionSignposter = OSSignposter(
    subsystem: "app.justmaple.aperture",
    category: "EditSession"
)

// MARK: - RenderPhase

/// Two-phase rendering per spec § 02 / § 05.
public enum RenderPhase: Sendable, Equatable {
    /// Fast preview at reduced resolution (≤ 50ms target).
    case fast
    /// Full-resolution final render (≤ 300ms target).
    case refine
}

// MARK: - RenderError

/// Errors surfaced by `EditSession._render`.
public enum RenderError: Error, LocalizedError, Sendable {
    case pipelineFailed

    public var errorDescription: String? {
        switch self {
        case .pipelineFailed:
            return "Failed to render preview."
        }
    }
}

