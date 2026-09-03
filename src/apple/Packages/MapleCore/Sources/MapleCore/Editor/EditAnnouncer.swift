// EditAnnouncer.swift — the accessibility half of the edit transaction
// contract (#2432). `EditSession` speaks every committed transaction (and
// every undo / redo) through this seam; the default posts a system
// accessibility announcement, tests inject a recorder.

import Foundation
import SwiftUI

/// Receives the user-visible description of a committed action.
public protocol EditAnnouncer: Sendable {
    func announce(_ text: String)
}

/// Posts through the Observation-era accessibility notification API, which
/// VoiceOver reads on macOS 14 / iOS 17 regardless of which view has focus.
public struct AccessibilityEditAnnouncer: EditAnnouncer {
    public init() {}

    public func announce(_ text: String) {
        AccessibilityNotification.Announcement(text).post()
    }
}
