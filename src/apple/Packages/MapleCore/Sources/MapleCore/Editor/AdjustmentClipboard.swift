// AdjustmentClipboard.swift — app-level copy/paste clipboard for
// AdjustmentModel (#944).
//
// In-memory, session-scoped only. Deliberately NOT persisted to disk or
// UserDefaults — the ticket asks for an in-session clipboard, and nothing
// downstream needs it to survive a relaunch (YAGNI).

import Foundation

@MainActor
@Observable
public final class AdjustmentClipboard {
    /// A captured model plus the display name of the asset it came from, so
    /// the UI can render "Paste (from IMG_0012)".
    public struct Contents: Sendable {
        public let model: AdjustmentModel
        public let sourceName: String

        public init(model: AdjustmentModel, sourceName: String) {
            self.model = model
            self.sourceName = sourceName
        }
    }

    public private(set) var contents: Contents?

    public init() {}

    public var hasContents: Bool { contents != nil }

    /// Capture `model` into the clipboard, replacing any prior contents.
    public func copy(model: AdjustmentModel, sourceName: String) {
        contents = Contents(model: model, sourceName: sourceName)
    }

    public func clear() {
        contents = nil
    }
}
