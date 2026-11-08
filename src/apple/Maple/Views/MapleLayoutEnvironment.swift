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

/// #5710: the editor and Preview draw the photo under the bars on iPad, the
/// open Duo and the Mac. A landscape iPhone keeps its inset canvas: its
/// sensor housing and home indicator sit on the long edges, where the
/// photo would otherwise run beneath them. The open Duo can report a
/// compact height in landscape, so the screen's shape tells them apart: a
/// conventional iPhone is at least 16:9 (1.78:1), the open Duo's inner
/// display about 1.4:1.
enum FullBleedCanvas {
    static let maximumInsetFreePhoneAspect: CGFloat = 1.6

    static func isAllowed(idiom: MapleDeviceIdiom, screen: CGSize) -> Bool {
        guard idiom == .phone, screen.width > screen.height, screen.height > 0 else { return true }
        return screen.width / screen.height < maximumInsetFreePhoneAspect
    }

    /// The whole window behind `geometry`, safe areas included.
    static func screen(of geometry: GeometryProxy) -> CGSize {
        let insets = geometry.safeAreaInsets
        return CGSize(
            width: geometry.size.width + insets.leading + insets.trailing,
            height: geometry.size.height + insets.top + insets.bottom)
    }
}
