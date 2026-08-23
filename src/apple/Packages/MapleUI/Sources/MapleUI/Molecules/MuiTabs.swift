// MuiTabs.swift — Maple UI Molecules-L1 (unified-component-catalog.md
// §2.2). Tab row with a sliding selection indicator, built from Text +
// Icon.

import SwiftUI

public struct MuiTab: Identifiable, Hashable, Sendable {
    public let id: String
    public let label: String
    public let icon: String?

    public init(id: String, label: String, icon: String? = nil) {
        self.id = id
        self.label = label
        self.icon = icon
    }
}

public struct MuiTabs: View {
    public let tabs: [MuiTab]
    @Binding public var activeId: String
    public let accessibilityLabel: String

    @Namespace private var indicatorNamespace
    @FocusState private var focusedId: String?

    public init(tabs: [MuiTab], activeId: Binding<String>, accessibilityLabel: String = "Tabs") {
        self.tabs = tabs
        self._activeId = activeId
        self.accessibilityLabel = accessibilityLabel
    }

    public var body: some View {
        HStack(spacing: MuiTokens.spacingMd) {
            ForEach(tabs) { tab in
                let isActive = tab.id == activeId
                Button {
                    activeId = tab.id
                } label: {
                    HStack(spacing: 4) {
                        if let icon = tab.icon {
                            MuiIcon(name: icon, size: .sm, color: isActive ? MuiTokens.textMain : MuiTokens.textMuted)
                        }
                        MuiText(tab.label, variant: .chipLabel, color: isActive ? .main : .muted)
                    }
                    .padding(.vertical, MuiTokens.spacingXs)
                    .overlay(alignment: .bottom) {
                        if isActive {
                            Rectangle()
                                .fill(MuiTokens.primary)
                                .frame(height: 2)
                                .matchedGeometryEffect(id: "indicator", in: indicatorNamespace)
                        }
                    }
                }
                .buttonStyle(.plain)
                .focused($focusedId, equals: tab.id)
                .accessibilityAddTraits(isActive ? [.isButton, .isSelected] : .isButton)
            }
        }
        .animation(MuiTokens.Motion.groupSwap, value: activeId)
        .accessibilityElement(children: .contain)
        .accessibilityLabel(accessibilityLabel)
    }
}

#Preview("MuiTabs") {
    struct Demo: View {
        @State private var activeId = "grid"

        var body: some View {
            MuiTabs(
                tabs: [
                    MuiTab(id: "grid", label: "Grid", icon: "square.grid.2x2"),
                    MuiTab(id: "list", label: "List", icon: "list.bullet"),
                    MuiTab(id: "map", label: "Map", icon: "map"),
                ],
                activeId: $activeId
            )
            .padding()
            .background(MuiTokens.bg)
        }
    }
    return Demo()
}
