// Keep each custom-glyph tool eligible for the Duo's vertical system rail.
// The system handles the available height and moves excess items to overflow.

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
        ForEach(ToolGroup.allCases, id: \.self) { group in groupButton(group) }
      }
      ForEach(specialTools, id: \.self) { tool in
        if #available(iOS 27.1, *) {
          ToolbarItem(placement: .topBarTrailing) {
            toolButton(tool)
          }
          .axisBehavior(.verticalPreferred)
        } else {
          ToolbarItem(placement: .topBarTrailing) {
            toolButton(tool)
          }
        }
      }
    }

    private func groupButton(_ group: ToolGroup) -> some View {
      Button {
        withAnimation(MapleTokens.Motion.groupSwap) {
          state.arm(tool: Tool.tools(in: group).first ?? state.armedTool)
        }
      } label: {
        Image(systemName: group.dockSymbol)
          .font(.system(size: 18))
          .modifier(
            DuoToolAppearance(
              selected: state.armedGroup == group && !specialTools.contains(state.armedTool),
              modified: group.hasEdits(in: state.session.model)))
      }
      .accessibilityLabel(group.displayName)
      .accessibilityAddTraits(
        state.armedGroup == group && !specialTools.contains(state.armedTool)
          ? .isSelected : []
      )
      .accessibilityIdentifier("editor-dock-group-\(group.rawValue)")
    }

    private func toolButton(_ tool: Tool) -> some View {
      Button {
        state.arm(tool: tool)
        if tool == .presets { onPresetsTap() }
      } label: {
        ToolGlyph.icon(for: tool, size: 18)
          .modifier(
            DuoToolAppearance(
              selected: state.armedTool == tool,
              modified: tool.hasEdits(in: state.session.model)))
      }
      .accessibilityLabel(tool.displayName)
      .accessibilityAddTraits(state.armedTool == tool ? .isSelected : [])
      .accessibilityIdentifier("editor-dock-tool-\(tool.rawValue)")
    }
  }

  private struct DuoToolAppearance: ViewModifier {
    let selected: Bool
    let modified: Bool

    func body(content: Content) -> some View {
      content
        .foregroundStyle(selected ? ProTokens.accent : ProTokens.text)
        .overlay(alignment: .bottomTrailing) {
          if modified {
            Circle()
              .fill(ProTokens.accent)
              .frame(width: 5, height: 5)
              .offset(x: -3, y: -3)
          }
        }
        .contentShape(Rectangle())
    }
  }

#endif
