// MuiSplitLayoutMath.swift — pure width-clamping and collapse-decision
// math for MuiSplitLayout (Templates, unified-component-catalog.md §5).
// Kept side-effect-free so it's unit-testable without a live GeometryReader
// or drag gesture. Ports the web reference's
// `mui-split-layout.component.ts` decisions: Detail collapses first (the
// most dispensable region — an inspector or thread panel), then Sidebar,
// leaving Center full-width on a phone.

import Foundation

enum MuiSplitLayoutMath {
    /// Below this host width, Detail collapses even if `showDetail` is
    /// true — there's no room for a third column. Matches the web
    /// reference's `DETAIL_COLLAPSE_PX`.
    static let detailCollapsePx: Double = 900
    /// Below this host width, Sidebar collapses too, leaving Center alone.
    /// Matches the web reference's `SIDEBAR_COLLAPSE_PX`.
    static let sidebarCollapsePx: Double = 640

    static func clamp(_ value: Double, min: Double, max: Double) -> Double {
        Swift.min(max, Swift.max(min, value))
    }

    /// Whether the Detail region should render at all: hidden outright when
    /// the caller has nothing to put there (`showDetail == false`), or when
    /// the host is too narrow and collapse is enabled.
    static func detailCollapsed(showDetail: Bool, hostWidth: Double, collapseEnabled: Bool) -> Bool {
        !showDetail || (collapseEnabled && hostWidth < detailCollapsePx)
    }

    /// Whether the Sidebar region should render at all.
    static func sidebarCollapsed(hostWidth: Double, collapseEnabled: Bool) -> Bool {
        collapseEnabled && hostWidth < sidebarCollapsePx
    }
}
