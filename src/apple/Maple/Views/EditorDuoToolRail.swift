// The open Duo's landscape editor uses the system's vertical toolbar rail.
// The adjustment groups stay at its top; direct special-tool buttons occupy
// the bottom, like the action stack on other Duo apps.

#if os(iOS)

  import MapleCore
  import SwiftUI

  struct EditorDuoToolRail: ToolbarContent {
    @Bindable var state: EditorState
    let onPresetsTap: () -> Void

    private let specialTools: [Tool] = [
      .crop, .toneCurve, .filmLook, .geometry, .mask, .presets, .heal,
    ]

    var body: some ToolbarContent {
      ToolbarItemGroup(placement: .topBarTrailing) {
        ForEach(ToolGroup.allCases, id: \.self) { group in
          Button {
            withAnimation(MapleTokens.Motion.groupSwap) {
              state.arm(group: group)
            }
          } label: {
            Image(systemName: group.dockSymbol)
              .overlay(alignment: .bottomTrailing) {
                if group.hasEdits(in: state.session.model) {
                  Circle()
                    .fill(ProTokens.accent)
                    .frame(width: 5, height: 5)
                    .offset(x: 4, y: 4)
                }
              }
          }
          .tint(state.armedGroup == group ? ProTokens.accent : ProTokens.text)
          .accessibilityLabel(group.displayName)
          .accessibilityAddTraits(state.armedGroup == group ? .isSelected : [])
          .accessibilityIdentifier("editor-dock-group-\(group.rawValue)")
        }
      }

      ToolbarItemGroup(placement: .bottomBar) {
        ForEach(specialTools, id: \.self) { tool in
          Button {
            state.arm(tool: tool)
            if tool == .presets { onPresetsTap() }
          } label: {
            ToolGlyph.icon(for: tool, size: 20)
              .foregroundStyle(state.armedTool == tool ? ProTokens.accent : ProTokens.text)
              .overlay(alignment: .bottomTrailing) {
                if tool.hasEdits(in: state.session.model) {
                  Circle()
                    .fill(ProTokens.accent)
                    .frame(width: 5, height: 5)
                    .offset(x: 4, y: 4)
                }
              }
          }
          .tint(state.armedTool == tool ? ProTokens.accent : ProTokens.text)
          .accessibilityLabel(tool.displayName)
          .accessibilityAddTraits(state.armedTool == tool ? .isSelected : [])
          .accessibilityIdentifier("editor-dock-tool-\(tool.rawValue)")
        }
      }
    }
  }

#endif
