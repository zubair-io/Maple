// NetworkSettingsView+VM.swift — Pure-function view-model helpers for
// NetworkSettingsView.
//
// Co-located sibling of NetworkSettingsView.swift. Holds derivations that
// take typed inputs and return typed outputs — no SwiftUI, no @State, no
// view-builder closures. The view calls these and feeds the results into
// its body.
//
// Pattern (issue #192): every SwiftUI view with non-trivial derivation gets
// a sibling `+VM.swift` whose contents are unit-testable in isolation. To
// preserve that guarantee this file MUST NOT `import SwiftUI`. If a helper
// needs `View` context it doesn't belong here.
//
// The form's own seeding and validation rules live one layer down, in
// `NetworkSettingsForm` (MapleCloudKit), so they're reachable from the
// package test target too.

import Foundation
import MapleCore

// MARK: - NetworkSettingsVM

/// Namespace for pure Network-settings derivations. A caseless enum keeps
/// the helpers grouped without ever being instantiated.
enum NetworkSettingsVM {

    /// Parenthesised provenance suffix shown after the resolved address and
    /// port — "(operator override)", "(auto-detected)", and so on.
    ///
    /// `.unknown` renders as an empty string rather than a placeholder: it
    /// only occurs when a newer server reports a source value this build
    /// doesn't know, and inventing a label for it would be a guess. The
    /// value itself still displays.
    static func provenanceLabel(_ source: NetworkValueSource) -> String {
        switch source {
        case .dbOverride: return "(operator override)"
        case .autoDetected: return "(auto-detected)"
        case .unavailable: return "(unavailable)"
        case .defaultValue: return "(default)"
        case .unknown: return ""
        }
    }

    /// The address column's text, falling back to "none" when the server
    /// resolved no LAN address at all.
    static func addressDisplay(_ config: NetworkConfig) -> String {
        config.localIP ?? "none"
    }

    /// Whether to show the "no LAN address could be detected" warning.
    ///
    /// Only meaningful when advertising is actually switched on — an
    /// undetectable address is not a problem the operator needs to act on
    /// while the feature is off, and warning anyway trains them to ignore
    /// it. The common cause is a container with a bridge network, which the
    /// override field exists to solve.
    static func shouldWarnNoLANAddress(_ config: NetworkConfig) -> Bool {
        config.source.localIP == .unavailable && config.enabled
    }
}
