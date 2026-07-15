// IPhoneLegacyControlBar.swift — original S5 controls, restored for iPhone.
//
// The intentional vertical order is slider, group tabs, then tool buttons.
// iPad and macOS continue to use the canvas-first dock/panel controls.

import MapleCore
import SwiftUI

struct IPhoneLegacyControlBar: View {
  @Bindable var state: EditorState
  var onPresetsTap: () -> Void = {}

  var body: some View {
    VStack(spacing: 0) {
      SubParamRow(state: state)

      if state.armedTool == .crop {
        CropToolbar(state: state)
      } else {
        DragBar(state: state)
          .padding(.vertical, 7)
      }

      if state.armedGroup == .color {
        ColorAccessoryRow(state: state)
          .transition(.opacity)
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
