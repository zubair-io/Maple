#if os(iOS)

  import MapleCore
  import MapleUI
  import SwiftUI

  /// The closed Duo's group switcher, in the trailing safe-area column
  /// below the clock (#5770).
  struct EditorSideGroupRail: View {
    @Bindable var state: EditorState
    @Environment(\.statusRegions) private var statusRegions

    var body: some View {
      GeometryReader { geometry in
        EditorGroupSwitcher(state: state, axis: .vertical)
          .accessibilityIdentifier("editor-side-groups")
          .padding(.vertical, 4)
          .modifier(PhotoHeaderGlass())
          .frame(width: geometry.safeAreaInsets.trailing)
          .padding(
            .top, EditorVerticalControlBar.top(in: geometry, statusRegions: statusRegions)
          )
          .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topTrailing)
          .ignoresSafeArea(.container, edges: .trailing)
      }
    }
  }

  /// The Duo's group switcher: a row in the open Duo's header (#5710), a
  /// column in the closed Duo's side rail (#5770).
  struct EditorGroupSwitcher: View {
    @Bindable var state: EditorState
    var axis: Axis = .horizontal

    private var stack: AnyLayout {
      axis == .horizontal
        ? AnyLayout(HStackLayout(spacing: 0)) : AnyLayout(VStackLayout(spacing: 0))
    }

    var body: some View {
      stack {
        ForEach(ToolGroup.allCases, id: \.self) { group in
          EditorGroupButton(state: state, group: group)
            .frame(width: 44, height: 44)
        }
      }
      .buttonStyle(.plain)
      .accessibilityElement(children: .contain)
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
      .editorSelectionHaptic(isSelected: state.armedGroup == group)
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
