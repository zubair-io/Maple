// Keep the primary tools on the Duo's vertical rail. Use an explicit More
// menu for the remaining tools instead of the system's inert overflow button.

#if os(iOS)

  import MapleCore
  import MapleUI
  import SwiftUI

  struct EditorDuoToolRail: ToolbarContent {
    @Bindable var state: EditorState
    let onPresetsTap: () -> Void
    var showsSpecialTools = true

    private let visibleTools: [Tool] = [
      .crop, .toneCurve, .filmLook, .geometry, .mask,
    ]
    private let moreTools: [Tool] = [.presets, .heal]

    var body: some ToolbarContent {
      ToolbarItemGroup(placement: .topBarTrailing) {
        ForEach(ToolGroup.allCases, id: \.self) { group in groupButton(group) }
      }
      if showsSpecialTools {
        ForEach(visibleTools, id: \.self) { tool in
          railItem { toolButton(tool) }
        }
        railItem { moreMenu }
      }
    }

    @ToolbarContentBuilder
    private func railItem<Content: View>(
      @ViewBuilder _ content: () -> Content
    ) -> some ToolbarContent {
      // axisBehavior ships only in the iOS 27.1 SDK (SwiftUI 8.0.85); #available alone
      // still fails to compile under Xcode 27.0, which TestFlight pins to (#4489).
      #if canImport(SwiftUI, _version: 8.0.85)
        if #available(iOS 27.1, *) {
          ToolbarItem(placement: .topBarTrailing, content: content)
            .axisBehavior(.verticalPreferred)
        } else {
          ToolbarItem(placement: .topBarTrailing, content: content)
        }
      #else
        ToolbarItem(placement: .topBarTrailing, content: content)
      #endif
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
              selected: state.armedGroup == group && !visibleTools.contains(state.armedTool)
                && !moreTools.contains(state.armedTool),
              modified: group.hasEdits(in: state.session.model)))
      }
      .accessibilityLabel(group.displayName)
      .accessibilityAddTraits(
        state.armedGroup == group && !visibleTools.contains(state.armedTool)
          && !moreTools.contains(state.armedTool)
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

    private var moreMenu: some View {
      Menu {
        ForEach(moreTools, id: \.self) { tool in
          Button {
            state.arm(tool: tool)
            if tool == .presets { onPresetsTap() }
          } label: {
            Label {
              Text(tool.displayName)
            } icon: {
              ToolGlyph.icon(for: tool, size: 16)
            }
          }
          .accessibilityIdentifier("editor-dock-tool-\(tool.rawValue)")
        }
      } label: {
        MuiIcon(name: "more_horiz", size: .sm)
          .font(.system(size: 18))
          .foregroundStyle(moreTools.contains(state.armedTool) ? ProTokens.accent : ProTokens.text)
          .frame(minWidth: 44, minHeight: 44)
          .contentShape(Rectangle())
      }
      .accessibilityLabel("More tools")
      .accessibilityIdentifier("editor-dock-more")
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
