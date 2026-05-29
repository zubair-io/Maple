// MapleLayoutEnvironment.swift — SwiftUI Environment plumbing for the
// `MapleLayout` density signal defined in MapleCore.
//
// Lives in the app target (not MapleCore) so the shared domain core stays
// free of a SwiftUI dependency and can be consumed in headless contexts
// (CLI, tests, future server-side renderers). MapleCore owns the pure
// enums; this file owns the view-layer plumbing.
//
// Responsive-program S0a (epic #577, ticket #581).
// Spec: docs/design/responsive-program/s0-primitives.md §2.

import MapleCore
import SwiftUI

private struct MapleLayoutKey: EnvironmentKey {
    /// Defaults to `.desktop` so views composed without a shell wrapper
    /// (e.g., in `#Preview` blocks) render their widest variant — safer
    /// than collapsing to a phone-tier fallback that hides chrome.
    static let defaultValue: MapleLayout = .desktop
}

public extension EnvironmentValues {
    var mapleLayout: MapleLayout {
        get { self[MapleLayoutKey.self] }
        set { self[MapleLayoutKey.self] = newValue }
    }
}
