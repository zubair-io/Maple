// IPhoneLegacyControlBar.swift — original S5 controls, restored for iPhone.
//
// The intentional vertical order is contextual controls, slider, group tabs,
// then tool buttons.
// iPad and macOS continue to use the canvas-first dock/panel controls.

import MapleCore
import SwiftUI

struct IPhoneLegacyControlBar: View {
    @Bindable var state: EditorState
    var onPresetsTap: () -> Void = {}

    var body: some View {
        VStack(spacing: 0) {
            if state.armedGroup == .color {
                ColorAccessoryRow(state: state, compactStyle: true)
                    .transition(.opacity)
            }

            SubParamRow(state: state)

            if state.armedTool == .crop {
                CropToolbar(state: state)
            } else {
                DragBar(state: state)
                    .padding(.vertical, 7)
            }

            Divider().background(MapleTokens.border)
            GroupTabsView(state: state)
            ToolPillRow(state: state, onPresetsTap: onPresetsTap)
        }
        .frame(maxWidth: .infinity)
        .background(MapleTokens.bg)
        .safeAreaPadding(.bottom, 6)
        .animation(MapleTokens.Motion.groupSwap, value: state.armedGroup)
        .accessibilityElement(children: .contain)
        .accessibilityIdentifier("editor-iphone-legacy-controls")
    }
}
