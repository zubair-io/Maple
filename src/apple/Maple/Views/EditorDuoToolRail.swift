// The closed Duo's dedicated side rail carries group selection; its compact
// slider controls keep the tools. The open Duo carries the same switcher in
// its header row, beside the vertical control bar.

#if os(iOS)

  import MapleCore
  import MapleUI
  import SwiftUI

  struct EditorDuoToolRail: ToolbarContent {
    @Bindable var state: EditorState

    var body: some ToolbarContent {
      ToolbarItemGroup(placement: .topBarTrailing) {
        ForEach(ToolGroup.allCases, id: \.self) { group in
          EditorGroupButton(state: state, group: group)
        }
      }
    }
  }

  /// The open Duo's group switcher, carried in the header row so every
  /// top control shares one level at the top safe area (#5710).
  struct EditorGroupSwitcher: View {
    @Bindable var state: EditorState

    var body: some View {
      HStack(spacing: 0) {
        ForEach(ToolGroup.allCases, id: \.self) { group in
          EditorGroupButton(state: state, group: group)
            .frame(width: 44, height: 44)
        }
      }
      .buttonStyle(.plain)
      .accessibilityElement(children: .contain)
      .accessibilityIdentifier("editor-header-groups")
    }
  }

  struct EditorGroupButton: View {
    @Bindable var state: EditorState
    let group: ToolGroup

    /// Groups wait for the sidecar (#4709 review): arming a tool on unloaded
    /// defaults would edit a model hydration then replaces.
    private var canEdit: Bool { state.session.hasLoadedSidecar }

    var body: some View {
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
