// The open Duo's landscape editor uses the system's vertical toolbar rail.
// The four adjustment groups stay at its top; less-frequent tools remain
// reachable from the bottom without covering the photo or inspector.

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

      ToolbarItem(placement: .bottomBar) {
        Menu {
          ForEach(specialTools, id: \.self) { tool in
            Button {
              state.arm(tool: tool)
              if tool == .presets { onPresetsTap() }
            } label: {
              if state.armedTool == tool {
                Label(tool.displayName, systemImage: "checkmark")
              } else {
                Text(tool.displayName)
              }
            }
            .accessibilityIdentifier("editor-dock-tool-\(tool.rawValue)")
          }
        } label: {
          Image(systemName: "ellipsis.circle")
        }
        .accessibilityLabel("More editor tools")
        .accessibilityIdentifier("editor-more-tools")
      }
    }
  }

#endif
