import MapleCore
import SwiftUI

/// One inspector and one dock keep their identity while their arrangement
/// changes. Session, gesture, selection and zoom state stay with EditorState.
struct EditorControls: View {
  @Bindable var state: EditorState
  let onPresetsTap: () -> Void
  var usesSystemToolRail = false
  @Environment(\.mapleLayout) private var layout
  @Environment(\.accessibilityReduceMotion) private var reduceMotion

  var body: some View {
    GeometryReader { geometry in
      let isBottom =
        layout == .phone
        || (MapleShellKind.currentIdiom == .phone && geometry.size.height > geometry.size.width)
      let arrangement =
        isBottom
        ? AnyLayout(VStackLayout(spacing: 8)) : AnyLayout(HStackLayout(spacing: 12))
      let shortCrop = isBottom && geometry.size.height < 500 && state.armedTool == .crop
      let bottomPanelHeight = shortCrop ? 96 : min(360, geometry.size.height * 0.40)
      ScrollViewReader { proxy in
        arrangement {
          StackedAdjustmentsPanel(state: state, showsHeader: !shortCrop)
            .frame(width: isBottom ? nil : 320)
            // Keep a usable crop canvas in short compact windows. The
            // crop toolbar includes its own Reset and Done actions.
            .frame(
              height: isBottom
                ? bottomPanelHeight : nil
            )
            .frame(maxHeight: isBottom ? nil : .infinity)

          if !usesSystemToolRail {
            ToolDock(
              state: state, onPresetsTap: onPresetsTap,
              horizontal: isBottom,
              onGroupTap: { group in scroll(proxy, to: "group-\(group.rawValue)") })
          }
        }
        // Report only the fixed controls footprint. The following outer
        // alignment frame fills the editor and must never exclude its canvas.
        .frame(
          width: isBottom ? nil : (usesSystemToolRail ? 320 : 396),
          height: isBottom ? bottomPanelHeight + 80 : nil
        )
        // The inspector is scrollable for every tool; the dock scrolls too.
        // Wheel events over either must reach that surface, never the canvas.
        .reportsWheelExclusion(in: "editorCanvas", active: true)
        .padding(.top, isBottom ? 0 : 64)
        .padding(12)
        .frame(
          maxWidth: .infinity, maxHeight: .infinity,
          alignment: isBottom ? .bottom : .trailing
        )
        .onChange(of: layout) { _, _ in
          revealArmedTool(proxy)
        }
        .onChange(of: state.armedTool) { _, _ in
          revealArmedTool(proxy)
        }
      }
    }
  }

  /// A group tap selects its first tool, but should reveal the group heading,
  /// not jump the floating panel down to the first slider. Dedicated tool
  /// panels and other slider selections still reveal their own controls.
  private func revealArmedTool(_ proxy: ScrollViewProxy) {
    let firstTool = Tool.tools(in: state.armedGroup).first
    let target =
      state.armedTool == firstTool
      ? "group-\(state.armedGroup.rawValue)" : state.armedTool.rawValue
    scroll(proxy, to: target)
  }

  private func scroll<ID: Hashable>(_ proxy: ScrollViewProxy, to id: ID) {
    withAnimation(reduceMotion ? nil : MapleTokens.Motion.groupSwap) {
      proxy.scrollTo(id, anchor: .top)
    }
  }
}
