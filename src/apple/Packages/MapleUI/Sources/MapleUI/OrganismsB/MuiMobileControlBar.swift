// MuiMobileControlBar.swift — Maple UI Organisms · Editing surfaces
// (unified-component-catalog.md §4.5). Phone bottom control stack: a tool
// row above the armed tool's Control Surface, built from Tool Dock,
// Control Surface, Tabs. Unlike the web reference (which stands a plain
// action-button row in for Tool Dock because that organism hadn't landed
// yet in that wave), this Apple wave composes the real `MuiToolDock`
// shipped in A6a.

import SwiftUI

public struct MuiMobileControlBarTool: Identifiable, Sendable {
    public let id: String
    public let icon: String
    public let label: String

    public init(id: String, icon: String, label: String) {
        self.id = id
        self.icon = icon
        self.label = label
    }
}

public struct MuiMobileControlBar: View {
    public let tools: [MuiMobileControlBarTool]
    @Binding public var activeToolId: String?
    public let tabs: [MuiTab]
    @Binding public var activeTabId: String
    public let sliders: [MuiControlSurfaceSlider]
    public let toolSelected: ((String) -> Void)?
    public let sliderChanged: ((String, Double) -> Void)?

    public init(
        tools: [MuiMobileControlBarTool],
        activeToolId: Binding<String?>,
        tabs: [MuiTab],
        activeTabId: Binding<String>,
        sliders: [MuiControlSurfaceSlider],
        toolSelected: ((String) -> Void)? = nil,
        sliderChanged: ((String, Double) -> Void)? = nil
    ) {
        self.tools = tools
        self._activeToolId = activeToolId
        self.tabs = tabs
        self._activeTabId = activeTabId
        self.sliders = sliders
        self.toolSelected = toolSelected
        self.sliderChanged = sliderChanged
    }

    public var body: some View {
        VStack(spacing: 0) {
            MuiControlSurface(tabs: tabs, activeTabId: $activeTabId, sliders: sliders, sliderChanged: sliderChanged)
                .padding(MuiTokens.spacingMd)

            MuiDivider()

            MuiToolDock(
                entries: tools.map { .item(MuiToolDockItem(id: $0.id, icon: $0.icon, label: $0.label)) },
                orientation: .horizontal,
                activeId: $activeToolId,
                toolSelected: toolSelected
            )
            .padding(.vertical, MuiTokens.spacingSm)
        }
        .background(MuiTokens.surface)
    }
}

#Preview("MuiMobileControlBar") {
    struct Demo: View {
        @State private var activeTool: String? = "adjust"
        @State private var activeTab = "light"
        var body: some View {
            MuiMobileControlBar(
                tools: [
                    MuiMobileControlBarTool(id: "crop", icon: "crop", label: "Crop"),
                    MuiMobileControlBarTool(id: "adjust", icon: "slider.horizontal.3", label: "Adjust"),
                ],
                activeToolId: $activeTool,
                tabs: [MuiTab(id: "light", label: "Light")],
                activeTabId: $activeTab,
                sliders: [MuiControlSurfaceSlider(id: "exposure", label: "Exposure", value: 0.2, min: -5, max: 5, step: 0.1)]
            )
            .frame(width: 320)
            .background(MuiTokens.bg)
        }
    }
    return Demo()
}
