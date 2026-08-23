// MuiTabShell.swift — Maple UI Templates (unified-component-catalog.md
// §5). Two-region layout: a Tab bar (built from the existing `MuiTabs`
// molecule) and a Content region. Backs the TV Timeline and TV Map pages
// (§6). Regions only — the tab data itself is the one exception, since the
// tab bar isn't a projected slot but a driven instance of `MuiTabs`, same
// as the web reference's `mui-tab-shell` wrapping `mui-tabs`.
//
// Placement is "top on tablet/desktop, bottom on phone" per the catalog's
// "per breakpoint" note. `.auto` resolves by host width (see
// `MuiTabShellMath`) rather than a horizontal size class — see
// `MuiSplitLayout`'s doc comment for why width beats a size class here.
// `placement` can still force one side explicitly (a caller that already
// knows its context, e.g. always-bottom tvOS remote navigation, shouldn't
// have to fight the auto behavior).

import SwiftUI

public enum MuiTabShellPlacement: Sendable {
    case auto, top, bottom
}

public struct MuiTabShell<Content: View>: View {
    public let tabs: [MuiTab]
    @Binding public var activeId: String
    public let accessibilityLabel: String
    public let placement: MuiTabShellPlacement
    public let content: Content

    public init(
        tabs: [MuiTab],
        activeId: Binding<String>,
        accessibilityLabel: String = "Tabs",
        placement: MuiTabShellPlacement = .auto,
        @ViewBuilder content: () -> Content
    ) {
        self.tabs = tabs
        self._activeId = activeId
        self.accessibilityLabel = accessibilityLabel
        self.placement = placement
        self.content = content()
    }

    public var body: some View {
        GeometryReader { geo in
            let bottom = MuiTabShellMath.isBottom(placement: placement, hostWidth: Double(geo.size.width))

            VStack(spacing: 0) {
                if !bottom {
                    tabBar
                }
                content.frame(maxWidth: .infinity, maxHeight: .infinity)
                if bottom {
                    tabBar
                }
            }
        }
    }

    private var tabBar: some View {
        MuiTabs(tabs: tabs, activeId: $activeId, accessibilityLabel: accessibilityLabel)
            .padding(.horizontal, MuiTokens.spacingMd)
            .padding(.vertical, MuiTokens.spacingSm)
            .background(MuiTokens.surface)
    }
}

#Preview("MuiTabShell — top") {
    struct Demo: View {
        @State private var activeId = "grid"

        var body: some View {
            MuiTabShell(
                tabs: [
                    MuiTab(id: "grid", label: "Grid"),
                    MuiTab(id: "map", label: "Map"),
                ],
                activeId: $activeId,
                placement: .top
            ) {
                MuiTokens.imageCanvas.overlay(MuiText("Content", variant: .body, color: .muted))
            }
        }
    }
    return Demo().frame(width: 500, height: 300)
}

#Preview("MuiTabShell — bottom (phone width)") {
    struct Demo: View {
        @State private var activeId = "grid"

        var body: some View {
            MuiTabShell(
                tabs: [
                    MuiTab(id: "grid", label: "Grid"),
                    MuiTab(id: "map", label: "Map"),
                ],
                activeId: $activeId
            ) {
                MuiTokens.imageCanvas.overlay(MuiText("Content", variant: .body, color: .muted))
            }
        }
    }
    return Demo().frame(width: 360, height: 500)
}
