// The open Duo hosts every editor destination in a single system toolbar
// item, keeping the whole rail in the chrome beneath the clock.

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
      ToolbarItem(placement: .topBarTrailing) {
        controls
      }
    }

    private var controls: some View {
      VStack(spacing: 2) {
        ForEach(ToolGroup.allCases, id: \.self) { group in
          Button {
            withAnimation(MapleTokens.Motion.groupSwap) {
              state.arm(tool: Tool.tools(in: group).first ?? state.armedTool)
            }
          } label: {
            VStack(spacing: 1) {
              Image(systemName: group.dockSymbol)
                .font(.system(size: 18))
              Text(group.displayName)
                .font(.system(size: 8, weight: .medium))
                .lineLimit(1)
            }
            .frame(width: 50, height: 44)
            .modifier(
              DuoToolAppearance(
                selected: state.armedGroup == group && !specialTools.contains(state.armedTool),
                modified: group.hasEdits(in: state.session.model)))
          }
          .buttonStyle(.plain)
          .accessibilityLabel(group.displayName)
          .accessibilityAddTraits(
            state.armedGroup == group && !specialTools.contains(state.armedTool)
              ? .isSelected : []
          )
          .accessibilityIdentifier("editor-dock-group-\(group.rawValue)")
        }
        Rectangle()
          .fill(ProTokens.border)
          .frame(width: 28, height: 1)
          .padding(.vertical, 2)

        ForEach(specialTools, id: \.self) { tool in
          Button {
            state.arm(tool: tool)
            if tool == .presets { onPresetsTap() }
          } label: {
            VStack(spacing: 1) {
              ToolGlyph.icon(for: tool, size: 18)
              Text(tool.displayName)
                .font(.system(size: 8, weight: .medium))
                .lineLimit(1)
                .minimumScaleFactor(0.75)
            }
            .frame(width: 50, height: 44)
            .modifier(
              DuoToolAppearance(
                selected: state.armedTool == tool,
                modified: tool.hasEdits(in: state.session.model)))
          }
          .buttonStyle(.plain)
          .accessibilityLabel(tool.displayName)
          .accessibilityAddTraits(state.armedTool == tool ? .isSelected : [])
          .accessibilityIdentifier("editor-dock-tool-\(tool.rawValue)")
        }
      }
      .padding(5)
      .accessibilityElement(children: .contain)
      .accessibilityLabel("Editor tools")
      .accessibilityIdentifier("editor-duo-tool-rail")
    }
  }

  private struct DuoToolAppearance: ViewModifier {
    let selected: Bool
    let modified: Bool

    func body(content: Content) -> some View {
      content
        .foregroundStyle(selected ? ProTokens.accent : ProTokens.text)
        .background(selected ? ProTokens.accent(0x28) : .clear, in: Circle())
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
