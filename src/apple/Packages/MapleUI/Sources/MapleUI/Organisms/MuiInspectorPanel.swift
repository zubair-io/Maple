// MuiInspectorPanel.swift — Maple UI Organisms · Inspectors & panels
// (unified-component-catalog.md §4.3). Tabbed right-side detail region,
// built from Tabs, Page Header. A thin shell: it owns the header and the
// tab strip's active-tab selection, but the body is entirely projected —
// the caller decides what to render for the active tab, matching the
// catalog's "hosting projected content" description exactly. No internal
// data states of its own.

import SwiftUI

public struct MuiInspectorPanel<Body: View>: View {
    public let title: String
    public let tabs: [MuiTab]
    public let showBack: Bool
    public let showMore: Bool
    @Binding public var activeTabId: String
    public let back: (() -> Void)?
    public let more: (() -> Void)?
    @ViewBuilder public let body_: Body

    public init(
        title: String,
        tabs: [MuiTab],
        showBack: Bool = true,
        showMore: Bool = false,
        activeTabId: Binding<String>,
        back: (() -> Void)? = nil,
        more: (() -> Void)? = nil,
        @ViewBuilder body: () -> Body
    ) {
        self.title = title
        self.tabs = tabs
        self.showBack = showBack
        self.showMore = showMore
        self._activeTabId = activeTabId
        self.back = back
        self.more = more
        self.body_ = body()
    }

    public var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            MuiPageHeader(title: title, showBack: showBack, showMore: showMore, back: back, more: more)
            if !tabs.isEmpty {
                MuiTabs(tabs: tabs, activeId: $activeTabId)
                    .padding(.horizontal, MuiTokens.spacingMd)
                    .padding(.vertical, MuiTokens.spacingSm)
                MuiDivider()
            }
            body_
        }
    }
}

#Preview("MuiInspectorPanel") {
    struct Demo: View {
        @State private var activeTab = "info"
        var body: some View {
            MuiInspectorPanel(
                title: "IMG_0042.dng",
                tabs: [MuiTab(id: "info", label: "Info"), MuiTab(id: "edit", label: "Edit")],
                activeTabId: $activeTab
            ) {
                MuiText(activeTab == "info" ? "Info body goes here." : "Edit body goes here.", variant: .body, color: .muted)
                    .padding(MuiTokens.spacingMd)
            }
            .frame(width: 280, height: 220)
            .background(MuiTokens.bg)
        }
    }
    return Demo()
}
