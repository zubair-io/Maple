// The closed Duo's dedicated side rail carries group selection; its compact
// slider controls keep the tools. The open Duo uses the vertical control bar.

#if os(iOS)

  import MapleCore
  import MapleUI
  import SwiftUI

  struct EditorDuoToolRail: ToolbarContent {
    @Bindable var state: EditorState

    /// Groups wait for the sidecar (#4709 review): arming a tool on unloaded
    /// defaults would edit a model hydration then replaces.
    private var canEdit: Bool { state.session.hasLoadedSidecar }

    var body: some ToolbarContent {
      ToolbarItemGroup(placement: .topBarTrailing) {
        ForEach(ToolGroup.allCases, id: \.self) { group in groupButton(group) }
      }
    }

    private func groupButton(_ group: ToolGroup) -> some View {
      Button {
        withAnimation(MapleTokens.Motion.groupSwap) {
          state.arm(tool: Tool.tools(in: group).first ?? state.armedTool)
        }
      } label: {
        MuiIcon(name: group.dockSymbol, size: .sm)
          .font(.system(size: 18))
          .modifier(
            DuoToolAppearance(
              selected: state.armedGroup == group,
              modified: group.hasEdits(in: state.session.model)))
      }
      .accessibilityLabel(group.displayName)
      .accessibilityAddTraits(state.armedGroup == group ? .isSelected : [])
      .accessibilityIdentifier("editor-dock-group-\(group.rawValue)")
      .disabled(!canEdit)
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
