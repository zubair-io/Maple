// MapleLayout.swift — responsive-program S0a (epic #577, ticket #581).
//
// Two concepts, not one:
//   • MapleShellKind   — *which* shell renders (.phoneTab on iPhone idiom;
//                        .pane on iPad / Mac / web ≥768pt). Idiom-based.
//   • MapleLayout      — *what density* the pane renders at (.phone <768pt,
//                        .tablet 768-1024pt, .desktop >1024pt). Width-based.
//
// New code routes all idiom checks through `MapleShellKind.current` so
// the platform call is made exactly once per process. The one legacy call
// site (`src/apple/Maple/Views/DetailPanelWidth.swift`) was deleted along
// with the rest of the legacy `FullImageView` pane shell in #1807.
//
// SwiftUI Environment plumbing for `MapleLayout` lives in the app target
// (`src/apple/Maple/Views/MapleLayoutEnvironment.swift`) so this module
// stays free of a SwiftUI dependency and can be consumed in headless
// contexts. Width-based density decisions read `@Environment(\.mapleLayout)`
// from there.
//
// Spec: docs/design/responsive-program/s0-primitives.md §2.

import CoreGraphics
#if os(iOS)
import UIKit
#endif

// MARK: - MapleLayout (width-derived density)

public enum MapleLayout: Equatable, Sendable {
    case phone     // <768pt effective width
    case tablet    // 768-1024pt
    case desktop   // >1024pt

    /// Single source of truth for the breakpoint thresholds. All other code
    /// (web `LayoutService`, future view-layer branches) MUST mirror these.
    public static func from(width: CGFloat) -> MapleLayout {
        if width < 768 { return .phone }
        if width <= 1024 { return .tablet }
        return .desktop
    }
}

// MARK: - MapleDeviceIdiom (cross-platform mirror of UIUserInterfaceIdiom)

/// Cross-platform device idiom enum. Lets `MapleShellKind.from(idiom:)` be
/// a pure function we can unit-test on macOS without `UIDevice`. The Apple
/// runtime hop happens once in `MapleShellKind.currentIdiom`.
public enum MapleDeviceIdiom: Equatable, Sendable {
    case phone, pad, mac, other
}

// MARK: - MapleShellKind (idiom-derived shell selector)

public enum MapleShellKind: Equatable, Sendable {
    case phoneTab   // iPhone idiom — bottom tab bar shell
    case pane       // iPad, Mac, web ≥768pt — three-column pane shell

    /// Pure-function shell selection. Tested directly; production callers go
    /// through `current` (which reads the platform idiom).
    public static func from(idiom: MapleDeviceIdiom) -> MapleShellKind {
        idiom == .phone ? .phoneTab : .pane
    }

    /// The platform-derived idiom for the current process. Resolved once at
    /// first access and cached for the process lifetime — idiom is constant
    /// per process, so re-reading `UIDevice.current.userInterfaceIdiom` from
    /// the view tree would be wasted work.
    public static let currentIdiom: MapleDeviceIdiom = {
        #if os(macOS)
        return .mac
        #elseif os(iOS)
        switch UIDevice.current.userInterfaceIdiom {
        case .phone: return .phone
        case .pad: return .pad
        case .mac: return .mac
        default: return .other
        }
        #else
        return .other
        #endif
    }()

    /// The shell to render on this process. Read this — do not call
    /// `UIDevice.userInterfaceIdiom` directly elsewhere.
    public static var current: MapleShellKind {
        from(idiom: currentIdiom)
    }
}
